import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BrowserLaunchError } from "../src/browser.js";
import { parseCommand, runCli, withCliSignalHandlers } from "../src/cli.js";

const baseEnv = (root: string) => ({
  HOME: root,
  USER: "test",
  PLAYWRIGHT_MCP_BIN: "/usr/bin/true",
  CHROME_EXECUTABLE: "/usr/bin/true",
});

const lifecycleDependencies = (
  root: string,
  events: string[],
  stopResult = { stopped: true, remainingProfilePids: [] as number[] },
) => {
  let inspectCalls = 0;
  return {
    rootDir: root,
    env: baseEnv(root),
    reservePort: async () => {
      events.push("reserve-port");
      return 45678;
    },
    launchBrowser: async () => {
      events.push("chrome-start");
      return {
        pid: 4242,
        stop: async () => {
          events.push("chrome-stop");
          return stopResult;
        },
      };
    },
    runDeterministicCheck: async () => loadValidAuthReport(),
    inspectCart: async () => {
      inspectCalls += 1;
      return inspectCalls === 1
        ? { items: [], totalItemCount: 0, url: "https://www.wholefoodsmarket.com/grocery/cart", bodyText: "empty" }
        : {
            items: [{ productName: "Chicken thighs", productId: "B000000001", quantity: 1 }],
            totalItemCount: 1,
            url: "https://www.wholefoodsmarket.com/grocery/cart",
            bodyText: "Chicken thighs",
          };
    },
    prepareCartAgentPage: async () => undefined,
    invokeCartAgent: async ({ task }: { task: { ingredient: { id: string; request: string } } }) => {
      events.push("cart-agent");
      return {
        ingredientId: task.ingredient.id,
        requested: task.ingredient.request,
        status: "added" as const,
        productName: "Chicken thighs",
        productId: "B000000001",
        packageSize: "1.5 lb",
        quantity: 1,
        price: "$9.99",
        rationale: "Matches the request",
        confidence: "high" as const,
        failureReason: null,
      };
    },
  };
};

const writeValidRequest = (root: string): string => {
  const request = join(root, "request.json");
  cpSync(new URL("fixtures/valid-shopping-list.json", import.meta.url), request);
  return request;
};

const loadValidAuthReport = () =>
  JSON.parse(
    readFileSync(
      new URL("fixtures/valid-auth-report.json", import.meta.url),
      "utf8",
    ),
  );

describe("cart CLI", () => {
  it("parses Cart Agent model and effort CLI overrides", () => {
    expect(
      parseCommand([
        "build",
        "request.json",
        "--model",
        "gpt-5.6-luna",
        "--effort",
        "low",
      ]),
    ).toEqual({
      command: "build",
      shoppingListPath: "request.json",
      cartAgentModel: "gpt-5.6-luna",
      cartAgentReasoningEffort: "low",
    });
  });

  it("rejects unsupported effort values", () => {
    expect(parseCommand(["build", "request.json", "--effort", "maximum"])).toBeNull();
  });

  it("runs one Cart Agent per item and performs the cart check only at the boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-ingredients-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    let inspectCalls = 0;
    const agentCalls: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      runDeterministicCheck: async () =>
        JSON.parse(
          readFileSync(
            new URL("fixtures/valid-auth-report.json", import.meta.url),
            "utf8",
          ),
        ),
      inspectCart: async () => {
        inspectCalls += 1;
        return inspectCalls === 1
          ? {
              items: [],
              totalItemCount: 0,
              url: "https://www.wholefoodsmarket.com/grocery/cart",
              bodyText: "Your cart is empty",
            }
          : {
              items: [{ productName: "Chicken thighs", productId: "B000000001", quantity: 1 }],
              totalItemCount: 1,
              url: "https://www.wholefoodsmarket.com/grocery/cart",
              bodyText: "Chicken thighs\nCurrent quantity: 1",
            };
      },
      invokeCartAgent: async ({ task }) => {
        agentCalls.push(task.ingredient.id);
        return {
          ingredientId: task.ingredient.id,
          requested: task.ingredient.request,
          status: "added",
          productName: "Chicken thighs",
          productId: "B000000001",
          packageSize: "1.5 lb",
          quantity: 1,
          price: "$9.99",
          rationale: "The product fits the recipe context.",
          confidence: "high",
          failureReason: null,
        };
      },
    });
    expect(exitCode).toBe(0);
    expect(agentCalls).toEqual(["chicken"]);
    expect(inspectCalls).toBe(2);
    expect(events).toEqual(["reserve-port", "chrome-start", "chrome-stop"]);
  });

  it("installs and removes process signal handlers only via entrypoint helper", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const fakeProcess = {
      on(event: string, handler: (...args: unknown[]) => void) {
        void handler;
        events.push(`on:${event}`);
        return fakeProcess;
      },
      off(event: string, handler: (...args: unknown[]) => void) {
        void handler;
        events.push(`off:${event}`);
        return fakeProcess;
      },
    };

    await withCliSignalHandlers(
      async () => {
        events.push("run");
        controller.abort();
      },
      {
        processObject: fakeProcess as unknown as NodeJS.Process,
        signals: ["SIGINT", "SIGTERM"],
        controller,
      },
    );

    expect(events).toEqual([
      "on:SIGINT",
      "on:SIGTERM",
      "run",
      "off:SIGINT",
      "off:SIGTERM",
    ]);
  });

  it("stops Chrome before releasing the lock on build success", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-life-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      releaseLock: (lock) => {
        events.push("lock-release");
        lock.release();
      },
    });
    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "reserve-port",
      "chrome-start",
      "cart-agent",
      "chrome-stop",
      "lock-release",
    ]);
  });

  it.each([
    ["agent", false],
    ["chmod", true],
  ] as const)(
    "handles owned Chrome after %s failure",
    async (failure, shouldStop) => {
      const root = mkdtempSync(join(tmpdir(), "wfm-cli-cleanup-"));
      const request = writeValidRequest(root);
      const events: string[] = [];
      const secureDependency =
        failure === "chmod"
          ? {
              secureReport: () => {
                throw new Error("chmod failed");
              },
            }
          : {};
      const exitCode = await runCli(["build", request], {
        ...lifecycleDependencies(root, events),
        ...secureDependency,
        ...(failure === "agent"
          ? { invokeCartAgent: async (): Promise<never> => { throw new Error("synthetic"); } }
          : {}),
      });
      expect(exitCode).not.toBe(0);
      expect(events.includes("chrome-stop")).toBe(shouldStop);
    },
  );

  it("retains the lock when Chrome cannot be confirmed stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-stuck-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events, {
        stopped: false,
        remainingProfilePids: [4242],
      }),
    });
    expect(exitCode).toBe(2);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toMatch(/^\d+\n$/);
  });

  it("retains the lock when browser.stop rejects and never calls releaseLock", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-stop-reject-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
    const events: string[] = [];
    let stopCalls = 0;
    let releaseCalls = 0;
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      launchBrowser: async () => {
        events.push("chrome-start");
        return {
          pid: 4242,
          stop: async () => {
            stopCalls += 1;
            events.push("chrome-stop");
            throw new Error("stop transport failed");
          },
        };
      },
      releaseLock: () => {
        releaseCalls += 1;
        events.push("lock-release");
      },
    });
    // A successful Cart Agent run must not bypass stop-failure retention policy.
    expect(exitCode).toBe(2);
    expect(stopCalls).toBe(1);
    expect(releaseCalls).toBe(0);
    expect(events).toEqual([
      "reserve-port",
      "chrome-start",
      "cart-agent",
      "chrome-stop",
    ]);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toMatch(/^\d+\n$/);
  });

  it("releases the lock when BrowserLaunchError does not require retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-launch-release-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
    const events: string[] = [];
    let cartAgentCalled = false;
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      launchBrowser: async () => {
        throw new BrowserLaunchError(
          "Dedicated Chrome profile is already active: 99",
          false,
        );
      },
      invokeCartAgent: async () => {
        cartAgentCalled = true;
        throw new Error("Cart Agent must not run");
      },
    });
    expect(exitCode).toBe(2);
    expect(cartAgentCalled).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    // Subsequent run can acquire the released lock.
    expect(
      await runCli(["build", request], {
        ...lifecycleDependencies(root, events),
      }),
    ).toBe(0);
  });

  it("retains the lock when BrowserLaunchError requires retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-launch-retain-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
    const events: string[] = [];
    let cartAgentCalled = false;
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      launchBrowser: async () => {
        throw new BrowserLaunchError(
          "Owned Chrome exited before the profile became idle",
          true,
        );
      },
      invokeCartAgent: async () => {
        cartAgentCalled = true;
        throw new Error("Cart Agent must not run");
      },
    });
    expect(exitCode).toBe(2);
    expect(cartAgentCalled).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toMatch(/^\d+\n$/);
  });

  it("retains the lock conservatively on unknown launch errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-launch-unknown-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
    const events: string[] = [];
    let cartAgentCalled = false;
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      launchBrowser: async () => {
        throw new Error("unexpected spawn failure");
      },
      invokeCartAgent: async () => {
        cartAgentCalled = true;
        throw new Error("Cart Agent must not run");
      },
    });
    expect(exitCode).toBe(2);
    expect(cartAgentCalled).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toMatch(/^\d+\n$/);
  });

  it("runs auth-check deterministically without Codex", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-auth-check-"));
    const events: string[] = [];
    let cartAgentCalled = false;
    const exitCode = await runCli(["auth-check"], {
      ...lifecycleDependencies(root, events),
      invokeCartAgent: async () => {
        cartAgentCalled = true;
        throw new Error("auth-check must not invoke the Cart Agent");
      },
      runDeterministicCheck: async () => {
        return JSON.parse(
          readFileSync(
            new URL("fixtures/valid-auth-report.json", import.meta.url),
            "utf8",
          ),
        );
      },
    });
    expect(exitCode).toBe(0);
    expect(cartAgentCalled).toBe(false);
    expect(events).toContain("reserve-port");
    expect(events).toContain("chrome-stop");
  });

  it("returns 1 when auth-check reports signed out", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-auth-fail-"));
    const events: string[] = [];
    const errors: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((message) => errors.push(String(message)));
    const exitCode = await runCli(["auth-check"], {
      ...lifecycleDependencies(root, events),
      runDeterministicCheck: async () => {
        const report = JSON.parse(
          readFileSync(
            new URL("fixtures/valid-auth-report.json", import.meta.url),
            "utf8",
          ),
        );
        Object.assign(report, {
          runStatus: "failed",
          authenticated: false,
          failureReason: "Whole Foods Market is signed out",
        });
        return report;
      },
    });
    errorSpy.mockRestore();
    expect(exitCode).toBe(1);
    expect(events).not.toContain("chrome-stop");
    expect(existsSync(join(root, ".wfm-cart.lock"))).toBe(false);
    expect(errors.join("\n")).toContain(
      "Auth readiness check failed: Whole Foods Market is signed out",
    );
    expect(errors.join("\n")).toContain("Dedicated Chrome left open");
  });

  it("prints cart readiness failures and leaves Chrome open for manual recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cart-readiness-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const errors: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((message) => errors.push(String(message)));
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      runDeterministicCheck: async () => ({
        ...loadValidAuthReport(),
        runStatus: "failed",
        authenticated: false,
        failureReason: "authentication (sign-in state detected)",
      }),
      inspectCart: async () => {
        throw new Error("cart inspection must not run when authentication is missing");
      },
    });
    errorSpy.mockRestore();

    expect(exitCode).toBe(1);
    expect(events).toEqual(["reserve-port", "chrome-start"]);
    expect(existsSync(join(root, ".wfm-cart.lock"))).toBe(false);
    expect(errors.join("\n")).toContain(
      "Cart readiness check failed: authentication (sign-in state detected)",
    );
    expect(errors.join("\n")).toContain("Dedicated Chrome left open");
  });

  it("closes Chrome when the cart preflight crosses a safety boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cart-safety-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      runDeterministicCheck: async () => ({
        ...loadValidAuthReport(),
        runStatus: "failed",
        checkoutVisited: true,
        failureReason: "checkout boundary observed",
      }),
    });

    expect(exitCode).toBe(1);
    expect(events).toContain("chrome-stop");
  });

  it("owns the harmless Example Domain attachment lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-attachment-check-"));
    const events: string[] = [];
    let launchUrl = "";
    const dependencies = lifecycleDependencies(root, events);
    const exitCode = await runCli(["attachment-check"], {
      ...dependencies,
      launchBrowser: async (input) => {
        launchUrl = input.launchUrl ?? "";
        return dependencies.launchBrowser();
      },
      runDeterministicCheck: async () => {
        return JSON.parse(
          readFileSync(
            new URL("fixtures/valid-attachment-report.json", import.meta.url),
            "utf8",
          ),
        );
      },
    });
    expect(exitCode).toBe(0);
    expect(launchUrl).toBe("https://example.com");
    expect(events).toContain("chrome-stop");
  });

  it("returns 1 for an honest attachment failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-attachment-failure-"));
    const events: string[] = [];
    const exitCode = await runCli(["attachment-check"], {
      ...lifecycleDependencies(root, events),
      runDeterministicCheck: async () => {
        return {
            connected: false,
            url: null,
            title: null,
            navigationPerformed: false,
            interactionPerformed: false,
            failureReason: "Deterministic Chrome/CDP check failed",
          };
      },
    });
    expect(exitCode).toBe(1);
    expect(events).toContain("chrome-stop");
  });
});
