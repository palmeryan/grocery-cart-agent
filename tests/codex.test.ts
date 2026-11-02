import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  INGREDIENTS_AGENT_MODEL,
  INGREDIENTS_AGENT_REASONING_EFFORT,
  buildIngredientsAgentInvocation,
  codexEnvironment,
  createKillEscalation,
  runCodex,
} from "../src/codex.js";
import { assessModelToolInventory, buildModelToolProbeInvocation, MODEL_TOOL_PROBE_PROMPT, parseModelToolTrace } from "../src/model-tool-probe.js";

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Codex invocation", () => {
  it("only auto-clears exact tool names mapped to disabled settings present in the invocation", () => {
    const invocation = buildModelToolProbeInvocation({
      rootDir: "/repo", workDir: "/repo/runs/probe/model-work", outputPath: "/repo/out",
    });
    const args = invocation.args.join(" ");
    const mapped = assessModelToolInventory({ visibleTools: [
      "functions.exec", "functions.wait", "collaboration.spawn_agent",
    ], traceFiles: 1 });
    expect(mapped.status).toBe("covered");
    expect(mapped.covered).toEqual([
      { name: "collaboration.spawn_agent", settings: ["agents.enabled=false", "features.multi_agent=false"] },
      { name: "functions.exec", settings: ["features.code_mode_host=false"] },
      { name: "functions.wait", settings: ["features.code_mode_host=false"] },
    ]);
    for (const { settings } of mapped.covered) for (const setting of settings) expect(args).toContain(setting);

    expect(assessModelToolInventory({
      visibleTools: ["functions.request_user_input", "functions.exec.new"], traceFiles: 1,
    })).toEqual({ status: "warning", uncovered: ["functions.exec.new", "functions.request_user_input"], covered: [] });
    expect(assessModelToolInventory(null).status).toBe("warning");
    expect(assessModelToolInventory({ visibleTools: [], traceFiles: 1 }).status).toBe("covered");
  });

  it("probes the model with the same restrictions and no user data", () => {
    const invocation = buildModelToolProbeInvocation({
      rootDir: "/repo", workDir: "/repo/runs/probe/model-work",
      outputPath: "/repo/runs/probe/inventory.json",
    });
    const joined = invocation.args.join(" ");
    expect(joined).toContain('permissions.wfm-model.extends=":read-only"');
    expect(joined).toContain('permissions.wfm-model.network.enabled=false');
    expect(joined).toContain('agents.enabled=false');
    expect(joined).toContain("features.shell_tool=false");
    expect(joined).not.toContain("--output-schema");
    expect(joined).not.toContain("--output-last-message");
    expect(MODEL_TOOL_PROBE_PROMPT).toContain("ready");
  });

  it("extracts tool names and additional tool namespaces from captured inference requests", () => {
    const traceRoot = mkdtempSync(join(tmpdir(), "wfm-trace-"));
    const traceDir = join(traceRoot, "session-a");
    mkdirSync(traceDir, { recursive: true });
    const payloadPath = join(traceDir, "request.json");
    writeFileSync(payloadPath, JSON.stringify({ input: [
      { type: "function", name: "search" },
      { type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ name: "exec" }, { name: "read" }] }] },
    ] }));
    writeFileSync(join(traceDir, "trace.jsonl"), JSON.stringify({
      payload: { type: "inference_started", request_payload: { path: "request.json" } },
    }));
    // Tool-looking metadata in other trace files is not an inference inventory.
    writeFileSync(join(traceRoot, "other.json"), JSON.stringify({ tools: [{ name: "false-positive" }] }));
    expect(parseModelToolTrace(traceRoot)).toEqual({
      visibleTools: ["functions.exec", "functions.read", "search"], traceFiles: 1,
    });
  });

  it("treats a referenced Responses Lite request with no additional_tools as empty, and missing references as inconclusive", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "wfm-trace-empty-"));
    const payloadPath = join(emptyRoot, "request.json");
    writeFileSync(payloadPath, JSON.stringify({ input: [{ type: "message", role: "user", content: "ready" }] }));
    writeFileSync(join(emptyRoot, "trace.jsonl"), JSON.stringify({
      type: "inference_started", request_payload: { path: payloadPath },
    }));
    expect(parseModelToolTrace(emptyRoot)).toEqual({ visibleTools: [], traceFiles: 1 });
    const missingRoot = mkdtempSync(join(tmpdir(), "wfm-trace-missing-"));
    writeFileSync(join(missingRoot, "trace.jsonl"), JSON.stringify({ type: "turn.completed", tools: [{ name: "not-a-request" }] }));
    expect(() => parseModelToolTrace(missingRoot)).toThrow(/inconclusive/);
  });

  it("builds a restricted invocation with no project-file grants", () => {
    const invocation = buildIngredientsAgentInvocation({
      rootDir: "/repo",
      outputPath: "/repo/runs/id/ingredients-agent-output.json",
      schemaPath: "/repo/schemas/ingredients-agent-output.schema.json",
    });
    const joined = invocation.args.join(" ");
    expect(invocation.args).toContain("--output-schema");
    expect(invocation.args).toContain("/repo/schemas/ingredients-agent-output.schema.json");
    expect(invocation.args).toContain("--output-last-message");
    expect(invocation.args).toContain("/repo/runs/id/ingredients-agent-output.json");
    expect(joined).not.toContain("--sandbox");
    expect(invocation.args).toContain('permissions.wfm-model.extends=":read-only"');
    expect(invocation.args).toContain('permissions.wfm-model.network.enabled=false');
    expect(invocation.args).toContain('features.shell_tool=false');
    expect(invocation.args).toContain('web_search="disabled"');
    expect(invocation.workDir).toBe("/repo/runs/id/model-work");
    expect(invocation.args).toContain(INGREDIENTS_AGENT_MODEL);
    expect(invocation.args).toContain(
      `model_reasoning_effort="${INGREDIENTS_AGENT_REASONING_EFFORT}"`,
    );
    expect(invocation.args.at(-1)).toBe("-");
    expect(joined).not.toContain("playwright");
    expect(joined).not.toContain("--cdp-endpoint");
  });
});

describe("Codex environment", () => {
  it("preserves CLI authentication and proxy settings while excluding unrelated secrets and shell injection settings", () => {
    expect(codexEnvironment({
      PATH: "/usr/bin", HOME: "/home/test", CODEX_HOME: "/home/test/.codex",
      OPENAI_API_KEY: "synthetic-auth", HTTPS_PROXY: "http://proxy.test:3128",
      SSL_CERT_FILE: "/certs/test.pem", AWS_SECRET_ACCESS_KEY: "unrelated-secret",
      NODE_OPTIONS: "--require /untrusted/script.js", BASH_ENV: "/untrusted/startup",
    })).toEqual({
      PATH: "/usr/bin", HOME: "/home/test", CODEX_HOME: "/home/test/.codex",
      OPENAI_API_KEY: "synthetic-auth", HTTPS_PROXY: "http://proxy.test:3128",
      SSL_CERT_FILE: "/certs/test.pem",
    });
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

  it("does not pass unrelated parent environment secrets to the child", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-codex-env-"));
    vi.stubEnv("WFM_TEST_PRIVATE_SECRET", "SYNTHETIC_PRIVATE_SECRET");
    try {
      const result = await runCodex({
        executable: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({secret:process.env.WFM_TEST_PRIVATE_SECRET ?? null,trace:process.env.CODEX_ROLLOUT_TRACE_ROOT ?? null}));"],
        prompt: "", eventsPath: join(runDir, "events.jsonl"),
        stderrPath: join(runDir, "stderr.log"), timeoutMs: 5_000,
        rolloutTraceRoot: join(runDir, "trace"),
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(runDir, "events.jsonl"), "utf8"))).toEqual({ secret: null, trace: join(runDir, "trace") });
    } finally {
      vi.unstubAllEnvs();
    }
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
      // Allow the descendant to install its SIGTERM handler and write the
      // readiness marker before exercising the kill escalation.
      timeoutMs: 500,
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
