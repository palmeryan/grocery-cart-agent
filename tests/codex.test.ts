import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CART_MODEL,
  CART_REASONING_EFFORT,
  MEAL_PLAN_MODEL,
  MEAL_PLAN_REASONING_EFFORT,
  buildCodexInvocation,
  buildMealPlanCompilerInvocation,
  createKillEscalation,
  runCodex,
} from "../src/codex.js";

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Codex invocation", () => {
  it("uses a read-only sandbox and never bypasses approvals", () => {
    const invocation = buildCodexInvocation({
      rootDir: "/repo",
      browserOutputDir: "/repo/runs/id/browser",
      reportPath: "/repo/runs/id/report.json",
      schemaPath: "/repo/schemas/report.schema.json",
      playwrightMcpBin: "/repo/node_modules/.bin/playwright-mcp",
      remoteDebuggingPort: 45678,
    });
    const joined = invocation.args.join(" ");
    expect(invocation.args).toContain("--model");
    expect(invocation.args).toContain(CART_MODEL);
    expect(invocation.args).toContain(
      `model_reasoning_effort="${CART_REASONING_EFFORT}"`,
    );
    expect(invocation.args).toContain("--sandbox");
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain('approval_policy="never"');
    expect(invocation.args).toContain(
      'mcp_servers.playwright.default_tools_approval_mode="approve"',
    );
    expect(joined).not.toContain(
      'mcp_servers.playwright.default_tools_approval_mode="auto"',
    );
    expect(joined).not.toContain("dangerously-bypass");
    expect(joined).not.toContain("--approve-for-me");
    expect(joined).not.toContain("workspace-write");
    expect(joined).not.toContain("--skip-git-repo-check");
    expect(joined).toContain(
      'mcp_servers.playwright.command="/repo/node_modules/.bin/playwright-mcp"',
    );
    expect(joined).toContain(
      'mcp_servers.playwright.args=["--cdp-endpoint","http://127.0.0.1:45678","--output-dir","/repo/runs/id/browser","--caps=devtools"]',
    );
    expect(joined).not.toContain("--browser=chrome");
    expect(joined).toContain("--cdp-endpoint");
    expect(joined).not.toContain("--storage-state");
    expect(joined).not.toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
    expect(joined).not.toContain("--extension");
  });

  it("passes request content through stdin, never command arguments", () => {
    const invocation = buildCodexInvocation({
      rootDir: "/repo",
      browserOutputDir: "/repo/runs/id/browser",
      reportPath: "/repo/runs/id/report.json",
      schemaPath: "/repo/schemas/report.schema.json",
      playwrightMcpBin: "/repo/node_modules/.bin/playwright-mcp",
      remoteDebuggingPort: 45678,
    });
    expect(invocation.args.at(-1)).toBe("-");
  });

  it("builds a read-only planner invocation without browser or MCP settings", () => {
    const invocation = buildMealPlanCompilerInvocation({
      rootDir: "/repo",
      outputPath: "/repo/runs/id/meal-plan-draft.json",
      schemaPath: "/repo/schemas/meal-plan-draft.schema.json",
    });
    const joined = invocation.args.join(" ");
    expect(invocation.args).toContain("--output-schema");
    expect(invocation.args).toContain("/repo/schemas/meal-plan-draft.schema.json");
    expect(invocation.args).toContain("--output-last-message");
    expect(invocation.args).toContain("/repo/runs/id/meal-plan-draft.json");
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain(MEAL_PLAN_MODEL);
    expect(invocation.args).toContain(
      `model_reasoning_effort="${MEAL_PLAN_REASONING_EFFORT}"`,
    );
    expect(invocation.args.at(-1)).toBe("-");
    expect(joined).not.toContain("playwright");
    expect(joined).not.toContain("--cdp-endpoint");
  });
});

describe("Codex process", () => {
  const fakeCodex = fileURLToPath(
    new URL("fixtures/fake-codex.mjs", import.meta.url),
  );

  it("passes the prompt through stdin and captures both output streams", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-"));
    const result = await runCodex({
      executable: process.execPath,
      args: [fakeCodex],
      prompt: "NEVER open or enter checkout",
      eventsPath: join(runDir, "events.jsonl"),
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8"))
      .toContain("NEVER open or enter checkout");
    expect(readFileSync(join(runDir, "stderr.log"), "utf8"))
      .toContain("fake-codex-stderr");
  });

  it("terminates and reports a timeout", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-timeout-"));
    const result = await runCodex({
      executable: process.execPath,
      args: [fakeCodex, "--hang"],
      prompt: "test",
      eventsPath: join(runDir, "events.jsonl"),
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 50,
      killGraceMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(runDir, "events.jsonl"))).toBe(true);
  });

  it("kills descendant processes in the same process group on timeout", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-pg-"));
    const markerPath = join(runDir, "descendant.pid");
    const result = await runCodex({
      executable: process.execPath,
      args: [fakeCodex, "--spawn-descendant", markerPath],
      prompt: "test",
      eventsPath: join(runDir, "events.jsonl"),
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 200,
      killGraceMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);

    const deadline = Date.now() + 2_000;
    while (!existsSync(markerPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(markerPath)).toBe(true);
    const descendantPid = Number(readFileSync(markerPath, "utf8"));
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(processAlive(descendantPid)).toBe(false);
  });

  it("keeps SIGKILL armed after leader exits so SIGTERM-resistant descendants die", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-resist-"));
    const markerPath = join(runDir, "descendant.pid");
    const killGraceMs = 250;
    const result = await runCodex({
      executable: process.execPath,
      args: [fakeCodex, "--spawn-term-resistant-descendant", markerPath],
      prompt: "test",
      eventsPath: join(runDir, "events.jsonl"),
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 100,
      killGraceMs,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);

    expect(existsSync(markerPath)).toBe(true);
    const descendantPid = Number(readFileSync(markerPath, "utf8"));
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    // runCodex must not resolve until escalation reaped the resistant child.
    expect(processAlive(descendantPid)).toBe(false);
  });

  it("reaps descendants when aborted via AbortSignal", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-abort-"));
    const markerPath = join(runDir, "descendant.pid");
    const controller = new AbortController();
    const runPromise = runCodex({
      executable: process.execPath,
      args: [fakeCodex, "--spawn-term-resistant-descendant", markerPath],
      prompt: "test",
      eventsPath: join(runDir, "events.jsonl"),
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 30_000,
      killGraceMs: 100,
      signal: controller.signal,
    });

    const deadline = Date.now() + 2_000;
    while (!existsSync(markerPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(markerPath)).toBe(true);
    const descendantPid = Number(readFileSync(markerPath, "utf8"));
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    controller.abort();
    const result = await runPromise;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(processAlive(descendantPid)).toBe(false);
  });

  it("settles promptly when started with an already-aborted signal", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-preabort-"));
    const markerPath = join(runDir, "descendant.pid");
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await runCodex({
      executable: process.execPath,
      args: [fakeCodex, "--spawn-term-resistant-descendant", markerPath],
      prompt: "test",
      eventsPath: join(runDir, "events.jsonl"),
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 30_000,
      killGraceMs: 50,
      signal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    // If a descendant appeared, it must already be reaped.
    if (existsSync(markerPath)) {
      const descendantPid = Number(readFileSync(markerPath, "utf8"));
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        expect(processAlive(descendantPid)).toBe(false);
      }
    }
  });

  it("does not miss abort that fires between subscribe and recheck", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-race-"));
    const markerPath = join(runDir, "descendant.pid");

    // Signal double: first aborted read is false so subscribe path is taken;
    // addEventListener immediately aborts (simulating race), and the post-
    // subscribe recheck must observe aborted=true.
    let aborted = false;
    let listener: (() => void) | undefined;
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener(
        type: string,
        handler: () => void,
        options?: { once?: boolean },
      ) {
        void type;
        void options;
        listener = handler;
        // Abort races in right after subscription registration.
        aborted = true;
        queueMicrotask(() => {
          // Also deliver the event in case implementation relies on it only.
          handler();
        });
      },
      removeEventListener(type: string, handler: () => void) {
        void type;
        void handler;
        listener = undefined;
      },
    } as unknown as AbortSignal;

    const started = Date.now();
    const result = await runCodex({
      executable: process.execPath,
      args: [fakeCodex, "--spawn-term-resistant-descendant", markerPath],
      prompt: "test",
      eventsPath: join(runDir, "events.jsonl"),
      stderrPath: join(runDir, "stderr.log"),
      timeoutMs: 30_000,
      killGraceMs: 50,
      signal,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    void listener;
    if (existsSync(markerPath)) {
      const descendantPid = Number(readFileSync(markerPath, "utf8"));
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        expect(processAlive(descendantPid)).toBe(false);
      }
    }
  });

  it("fails fast when an exclusive log file cannot be opened", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-log-"));
    const eventsPath = join(runDir, "events.jsonl");
    const stderrPath = join(runDir, "stderr.log");
    writeFileSync(eventsPath, "occupied\n", { mode: 0o600 });

    await expect(
      runCodex({
        executable: process.execPath,
        args: [fakeCodex],
        prompt: "test",
        eventsPath,
        stderrPath,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(existsSync(stderrPath)).toBe(false);
  });
});

describe("Kill escalation coordinator", () => {
  it("completes done when fail path cancels the grace timer early", async () => {
    const handles: Array<ReturnType<typeof setTimeout>> = [];
    const schedule = vi.fn((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      handles.push(handle);
      return handle;
    });
    const cancel = vi.fn((handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
    });
    const reap = vi.fn(async () => {
      // no-op reap for deterministic unit coverage
    });

    const escalation = createKillEscalation({
      pgid: 1,
      graceMs: 60_000,
      reap,
      schedule,
      cancel,
    });

    // Simulate fail() after timeout armed escalation: complete without waiting
    // for the long grace timer. done must settle (no hang in outer finally).
    const finished = await Promise.race([
      escalation.completeNow().then(() => "completed" as const),
      new Promise<"hung">((resolve) => {
        setTimeout(() => resolve("hung"), 500);
      }),
    ]);

    expect(finished).toBe("completed");
    expect(escalation.isComplete()).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(reap).toHaveBeenCalledTimes(1);

    // Second completeNow is idempotent and does not re-reap.
    await escalation.completeNow();
    expect(reap).toHaveBeenCalledTimes(1);
    await expect(escalation.done).resolves.toBeUndefined();

    for (const handle of handles) clearTimeout(handle);
  });
});
