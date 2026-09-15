import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserLaunchError } from "../src/browser.js";
import { runCli, withCliSignalHandlers } from "../src/cli.js";
import type { CodexResult } from "../src/codex.js";

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
) => ({
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
});

const writeValidRequest = (root: string): string => {
  const request = join(root, "request.json");
  cpSync(new URL("fixtures/valid-request.json", import.meta.url), request);
  return request;
};

const loadValidReport = () =>
  JSON.parse(
    readFileSync(
      new URL("fixtures/valid-report.json", import.meta.url),
      "utf8",
    ),
  );

const writeReport = (
  reportPath: string,
  requestSha256: string,
  patch: Record<string, unknown> = {},
  mode = 0o644,
): void => {
  const report = loadValidReport();
  report.requestSha256 = requestSha256;
  Object.assign(report, patch);
  if (Array.isArray(patch.selections)) {
    report.selections = patch.selections;
  }
  writeFileSync(reportPath, JSON.stringify(report), { mode });
};

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("cart CLI", () => {
  it("validates, runs Codex, validates the report, and returns success", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    let capturedPrompt = "";
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath, requestSha256, prompt }) => {
        capturedPrompt = prompt;
        const metadata = JSON.parse(
          readFileSync(join(dirname(reportPath), "metadata.json"), "utf8"),
        );
        expect(metadata).toMatchObject({
          model: "gpt-5.6-terra",
          reasoningEffort: "low",
        });
        writeReport(reportPath, requestSha256);
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(0);
    expect(capturedPrompt).toContain("BROWSER OUTPUT DIRECTORY:");
    expect(capturedPrompt).toMatch(
      /BROWSER OUTPUT DIRECTORY: .*\/runs\/[^/\s]+\/browser/,
    );
    expect(capturedPrompt).toMatch(/\/runs\/[^/\s]+\/browser\/final-state\.png/);
    expect(events).toContain("reserve-port");
  });

  it("runs one ingredient agent per item and performs the cart check only at the boundaries", async () => {
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
              items: [{ productName: "Chicken thighs", quantity: 1 }],
              totalItemCount: 1,
              url: "https://www.wholefoodsmarket.com/grocery/cart",
              bodyText: "Chicken thighs\nCurrent quantity: 1",
            };
      },
      invokeIngredient: async ({ task }) => {
        agentCalls.push(task.ingredient.id);
        return {
          ingredientId: task.ingredient.id,
          requested: task.ingredient.request,
          status: "added",
          productName: "Chicken thighs",
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

  it("fails before Codex when request validation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-"));
    const request = join(root, "request.json");
    cpSync(new URL("fixtures/invalid-request.json", import.meta.url), request);
    const events: string[] = [];
    let called = false;
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async () => {
        called = true;
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(2);
    expect(called).toBe(false);
  });

  it("releases the profile lock when Codex throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const dependencies = {
      ...lifecycleDependencies(root, events),
      invokeCodex: async (): Promise<never> => {
        throw new Error("synthetic Codex failure");
      },
    };
    expect(await runCli(["build", request], dependencies)).toBe(2);
    expect(await runCli(["build", request], dependencies)).toBe(2);
  });

  it.each([
    ["authenticated", { authenticated: false }],
    ["deliveryModeConfirmed", { deliveryModeConfirmed: false }],
    ["deliveryAddressConfirmed", { deliveryAddressConfirmed: false }],
    ["wholeFoodsStorefrontConfirmed", { wholeFoodsStorefrontConfirmed: false }],
  ] as const)(
    "returns nonzero when report preflight %s is false",
    async (_field, patch) => {
      const root = mkdtempSync(join(tmpdir(), "wfm-cli-preflight-"));
      const request = writeValidRequest(root);
      const events: string[] = [];
      const exitCode = await runCli(["build", request], {
        ...lifecycleDependencies(root, events),
        invokeCodex: async ({ reportPath, requestSha256 }) => {
          writeReport(reportPath, requestSha256, patch);
          return { exitCode: 0, signal: null, timedOut: false };
        },
      });
      expect(exitCode).toBe(2);
      // Lock must be released for a subsequent run.
      expect(
        await runCli(["build", request], {
          ...lifecycleDependencies(root, events),
          invokeCodex: async ({ reportPath, requestSha256 }) => {
            writeReport(reportPath, requestSha256);
            return { exitCode: 0, signal: null, timedOut: false };
          },
        }),
      ).toBe(0);
    },
  );

  it("rejects completed reports that contain skipped selections", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-skipped-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        const report = loadValidReport();
        report.requestSha256 = requestSha256;
        report.runStatus = "completed";
        report.selections = [
          {
            ...report.selections[0],
            status: "skipped",
            productName: null,
            packageSize: null,
            quantity: 0,
            price: null,
          },
        ];
        writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(2);
  });

  it("allows partial reports with skipped selections to exit 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-partial-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        const report = loadValidReport();
        report.requestSha256 = requestSha256;
        report.runStatus = "partial";
        report.selections = [
          {
            ...report.selections[0],
            status: "skipped",
            productName: null,
            packageSize: null,
            quantity: 0,
            price: null,
          },
        ];
        writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(0);
  });

  it("returns 1 for failed runStatus after successful Codex exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-failed-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        writeReport(reportPath, requestSha256, {
          runStatus: "failed",
          failureReason: "could not find product",
        });
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(1);
  });

  it("returns 1 for failed report with authenticated false (honest auth failure)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-failed-auth-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        writeReport(reportPath, requestSha256, {
          runStatus: "failed",
          authenticated: false,
          deliveryModeConfirmed: false,
          deliveryAddressConfirmed: false,
          wholeFoodsStorefrontConfirmed: false,
          failureReason: "not authenticated at Whole Foods",
        });
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(1);
  });

  it.each([
    ["checkoutVisited", { checkoutVisited: true }],
    ["settingsChanged", { settingsChanged: true }],
  ] as const)(
    "returns 1 when safety flag %s is true",
    async (_field, patch) => {
      const root = mkdtempSync(join(tmpdir(), "wfm-cli-safety-"));
      const request = writeValidRequest(root);
      const events: string[] = [];
      const exitCode = await runCli(["build", request], {
        ...lifecycleDependencies(root, events),
        invokeCodex: async ({ reportPath, requestSha256 }) => {
          writeReport(reportPath, requestSha256, patch);
          return { exitCode: 0, signal: null, timedOut: false };
        },
      });
      expect(exitCode).toBe(1);
    },
  );

  it("returns nonzero on request hash mismatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-hash-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath }) => {
        writeReport(reportPath, "b".repeat(64));
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(2);
  });

  it("chmods report.json to 0600 after a successful run", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-perm-ok-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    let reportPath = "";
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath: path, requestSha256 }) => {
        reportPath = path;
        writeReport(path, requestSha256, {}, 0o644);
        expect(modeOf(path)).toBe(0o644);
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(0);
    expect(modeOf(reportPath)).toBe(0o600);
  });

  it("chmods report.json to 0600 after a nonzero report outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-perm-fail-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    let reportPath = "";
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath: path, requestSha256 }) => {
        reportPath = path;
        writeReport(path, requestSha256, { checkoutVisited: true }, 0o644);
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(1);
    expect(modeOf(reportPath)).toBe(0o600);
  });

  it("still releases the lock if report chmod fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-perm-lock-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      secureReport: () => {
        throw new Error("chmod failed");
      },
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        writeReport(reportPath, requestSha256);
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(2);
    // Lock released: second run can acquire again.
    expect(
      await runCli(["build", request], {
        ...lifecycleDependencies(root, events),
        invokeCodex: async ({ reportPath, requestSha256 }) => {
          writeReport(reportPath, requestSha256);
          return { exitCode: 0, signal: null, timedOut: false };
        },
      }),
    ).toBe(0);
  });

  it("chmods report.json when invoke rejects after writing a report", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-perm-reject-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    let reportPath = "";
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async ({ reportPath: path, requestSha256 }) => {
        reportPath = path;
        writeReport(path, requestSha256, {}, 0o644);
        expect(modeOf(path)).toBe(0o644);
        throw new Error("invoke rejected after writing report");
      },
    });
    expect(exitCode).toBe(2);
    expect(modeOf(reportPath)).toBe(0o600);
    // Lock released for a subsequent run.
    expect(
      await runCli(["build", request], {
        ...lifecycleDependencies(root, events),
        invokeCodex: async ({ reportPath: path, requestSha256 }) => {
          writeReport(path, requestSha256);
          return { exitCode: 0, signal: null, timedOut: false };
        },
      }),
    ).toBe(0);
  });

  it("forwards abort to Codex and releases lock on signal cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-abort-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
    const events: string[] = [];
    let sawSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const invokeStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const invoke = async (
      _input: {
        reportPath: string;
        requestSha256: string;
        prompt: string;
      },
      signal?: AbortSignal,
    ): Promise<CodexResult> => {
      sawSignal = signal;
      resolveStarted();
      return await new Promise<CodexResult>((resolve) => {
        if (signal?.aborted) {
          resolve({ exitCode: 1, signal: "SIGTERM", timedOut: false });
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            resolve({ exitCode: 1, signal: "SIGTERM", timedOut: false });
          },
          { once: true },
        );
      });
    };

    const controller = new AbortController();
    const runPromise = runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      signal: controller.signal,
      invokeCodex: invoke,
    });
    await invokeStarted;
    expect(existsSync(lockPath)).toBe(true);
    expect(sawSignal?.aborted).toBe(false);
    controller.abort();
    const exitCode = await runPromise;
    expect(exitCode).toBe(1);
    expect(sawSignal?.aborted).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(events).toContain("chrome-stop");
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
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        events.push("codex");
        writeReport(reportPath, requestSha256);
        return { exitCode: 0, signal: null, timedOut: false };
      },
      releaseLock: (lock) => {
        events.push("lock-release");
        lock.release();
      },
    });
    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "reserve-port",
      "chrome-start",
      "codex",
      "chrome-stop",
      "lock-release",
    ]);
  });

  it.each(["throw", "nonzero", "malformed", "chmod"] as const)(
    "closes owned Chrome after %s failure",
    async (failure) => {
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
        invokeCodex: async ({ reportPath, requestSha256 }) => {
          events.push("codex");
          if (failure === "throw") throw new Error("synthetic");
          if (failure === "malformed") writeFileSync(reportPath, "{");
          else writeReport(reportPath, requestSha256);
          return {
            exitCode: failure === "nonzero" ? 1 : 0,
            signal: null,
            timedOut: false,
          };
        },
      });
      expect(exitCode).not.toBe(0);
      expect(events.at(-1)).toBe("chrome-stop");
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
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        writeReport(reportPath, requestSha256);
        return { exitCode: 0, signal: null, timedOut: false };
      },
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
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        events.push("codex");
        writeReport(reportPath, requestSha256);
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    // Successful Codex/report must not bypass stop-failure retention policy.
    expect(exitCode).toBe(2);
    expect(stopCalls).toBe(1);
    expect(releaseCalls).toBe(0);
    expect(events).toEqual([
      "reserve-port",
      "chrome-start",
      "codex",
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
    let codexCalled = false;
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      launchBrowser: async () => {
        throw new BrowserLaunchError(
          "Dedicated Chrome profile is already active: 99",
          false,
        );
      },
      invokeCodex: async () => {
        codexCalled = true;
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(2);
    expect(codexCalled).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    // Subsequent run can acquire the released lock.
    expect(
      await runCli(["build", request], {
        ...lifecycleDependencies(root, events),
        invokeCodex: async ({ reportPath, requestSha256 }) => {
          writeReport(reportPath, requestSha256);
          return { exitCode: 0, signal: null, timedOut: false };
        },
      }),
    ).toBe(0);
  });

  it("retains the lock when BrowserLaunchError requires retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-launch-retain-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
    const events: string[] = [];
    let codexCalled = false;
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      launchBrowser: async () => {
        throw new BrowserLaunchError(
          "Owned Chrome exited before the profile became idle",
          true,
        );
      },
      invokeCodex: async () => {
        codexCalled = true;
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(2);
    expect(codexCalled).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toMatch(/^\d+\n$/);
  });

  it("retains the lock conservatively on unknown launch errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-launch-unknown-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
    const events: string[] = [];
    let codexCalled = false;
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      launchBrowser: async () => {
        throw new Error("unexpected spawn failure");
      },
      invokeCodex: async () => {
        codexCalled = true;
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(2);
    expect(codexCalled).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toMatch(/^\d+\n$/);
  });

  it("runs auth-check deterministically without Codex", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-auth-check-"));
    const events: string[] = [];
    let codexCalled = false;
    const exitCode = await runCli(["auth-check"], {
      ...lifecycleDependencies(root, events),
      invokeCodex: async () => {
        codexCalled = true;
        throw new Error("auth-check must not invoke Codex");
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
    expect(codexCalled).toBe(false);
    expect(events).toContain("reserve-port");
    expect(events).toContain("chrome-stop");
  });

  it("returns 1 when auth-check reports signed out", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-auth-fail-"));
    const events: string[] = [];
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
