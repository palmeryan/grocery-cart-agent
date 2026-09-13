import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCodexInvocation, runCodex } from "../src/codex.js";

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
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(runDir, "events.jsonl"))).toBe(true);
  });
});
