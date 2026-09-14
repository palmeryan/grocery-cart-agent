import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, withCliSignalHandlers } from "../src/cli.js";
import type { CodexResult } from "../src/codex.js";

const baseEnv = (root: string) => ({
  HOME: root,
  WFM_EXPECTED_POSTAL_CODE: "02139",
  PLAYWRIGHT_MCP_BIN: "/usr/bin/true",
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
    let capturedPrompt = "";
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
      invokeCodex: async ({ reportPath, requestSha256, prompt }) => {
        capturedPrompt = prompt;
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
  });

  it("fails before Codex when request validation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-"));
    const request = join(root, "request.json");
    cpSync(new URL("fixtures/invalid-request.json", import.meta.url), request);
    let called = false;
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
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
    const dependencies = {
      rootDir: root,
      env: baseEnv(root),
      invokeCodex: async (): Promise<never> => {
        throw new Error("synthetic Codex failure");
      },
    };
    expect(await runCli(["build", request], dependencies)).toBe(2);
    expect(await runCli(["build", request], dependencies)).toBe(2);
  });

  it.each([
    ["authenticated", { authenticated: false }],
    ["expectedLocationConfirmed", { expectedLocationConfirmed: false }],
    ["wholeFoodsStorefrontConfirmed", { wholeFoodsStorefrontConfirmed: false }],
  ] as const)(
    "returns nonzero when report preflight %s is false",
    async (_field, patch) => {
      const root = mkdtempSync(join(tmpdir(), "wfm-cli-preflight-"));
      const request = writeValidRequest(root);
      const exitCode = await runCli(["build", request], {
        rootDir: root,
        env: baseEnv(root),
        invokeCodex: async ({ reportPath, requestSha256 }) => {
          writeReport(reportPath, requestSha256, patch);
          return { exitCode: 0, signal: null, timedOut: false };
        },
      });
      expect(exitCode).toBe(2);
      // Lock must be released for a subsequent run.
      expect(
        await runCli(["build", request], {
          rootDir: root,
          env: baseEnv(root),
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
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
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
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
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
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
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

  it.each([
    ["checkoutVisited", { checkoutVisited: true }],
    ["settingsChanged", { settingsChanged: true }],
  ] as const)(
    "returns 1 when safety flag %s is true",
    async (_field, patch) => {
      const root = mkdtempSync(join(tmpdir(), "wfm-cli-safety-"));
      const request = writeValidRequest(root);
      const exitCode = await runCli(["build", request], {
        rootDir: root,
        env: baseEnv(root),
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
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
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
    let reportPath = "";
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
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
    let reportPath = "";
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
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
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
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
        rootDir: root,
        env: baseEnv(root),
        invokeCodex: async ({ reportPath, requestSha256 }) => {
          writeReport(reportPath, requestSha256);
          return { exitCode: 0, signal: null, timedOut: false };
        },
      }),
    ).toBe(0);
  });

  it("forwards abort to Codex and releases lock on signal cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-abort-"));
    const request = writeValidRequest(root);
    const lockPath = join(root, ".wfm-cart.lock");
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
      rootDir: root,
      env: baseEnv(root),
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
});
