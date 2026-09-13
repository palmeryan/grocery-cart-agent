import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("cart CLI", () => {
  it("validates, runs Codex, validates the report, and returns success", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-"));
    const request = join(root, "request.json");
    cpSync(new URL("fixtures/valid-request.json", import.meta.url), request);
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: {
        HOME: root,
        WFM_EXPECTED_POSTAL_CODE: "02139",
        PLAYWRIGHT_MCP_BIN: "/usr/bin/true",
      },
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        const report = JSON.parse(
          readFileSync(
            new URL("fixtures/valid-report.json", import.meta.url),
            "utf8",
          ),
        );
        report.requestSha256 = requestSha256;
        writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
        return { exitCode: 0, signal: null, timedOut: false };
      },
    });
    expect(exitCode).toBe(0);
  });

  it("fails before Codex when request validation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-"));
    const request = join(root, "request.json");
    cpSync(new URL("fixtures/invalid-request.json", import.meta.url), request);
    let called = false;
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: {
        HOME: root,
        WFM_EXPECTED_POSTAL_CODE: "02139",
        PLAYWRIGHT_MCP_BIN: "/usr/bin/true",
      },
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
    const request = join(root, "request.json");
    cpSync(new URL("fixtures/valid-request.json", import.meta.url), request);
    const dependencies = {
      rootDir: root,
      env: {
        HOME: root,
        WFM_EXPECTED_POSTAL_CODE: "02139",
        PLAYWRIGHT_MCP_BIN: "/usr/bin/true",
      },
      invokeCodex: async (): Promise<never> => {
        throw new Error("synthetic Codex failure");
      },
    };
    expect(await runCli(["build", request], dependencies)).toBe(2);
    expect(await runCli(["build", request], dependencies)).toBe(2);
  });
});
