import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCodexInvocation, runCodex } from "../src/codex.js";

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
      profileDir: "/profile",
      browserOutputDir: "/repo/runs/id/browser",
      reportPath: "/repo/runs/id/report.json",
      schemaPath: "/repo/schemas/report.schema.json",
      playwrightMcpBin: "/repo/node_modules/.bin/playwright-mcp",
    });
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args.join(" ")).not.toContain("dangerously-bypass");
    expect(invocation.args.join(" ")).toContain("--user-data-dir");
    expect(invocation.args.join(" ")).toContain("--caps=devtools");
  });

  it("passes request content through stdin, never command arguments", () => {
    const invocation = buildCodexInvocation({
      rootDir: "/repo",
      profileDir: "/profile",
      browserOutputDir: "/repo/runs/id/browser",
      reportPath: "/repo/runs/id/report.json",
      schemaPath: "/repo/schemas/report.schema.json",
      playwrightMcpBin: "/repo/node_modules/.bin/playwright-mcp",
    });
    expect(invocation.args.at(-1)).toBe("-");
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
