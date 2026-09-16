import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalShoppingList,
  createRunPaths,
  findPreviousReport,
  sha256,
} from "../src/artifacts.js";
import { loadConfig } from "../src/config.js";

describe("artifact paths", () => {
  it("creates one timestamped run outside tracked source paths", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cart-"));
    const paths = createRunPaths(root, new Date("2026-09-12T12:34:56Z"));
    expect(paths.kind).toBe("build");
    expect(paths.runId).toBe("2026-09-12T12-34-56-000Z");
    expect(paths.reportPath).toContain("/runs/");
    expect(paths.browserOutputDir).toContain("/browser");
  });

  it("creates an auth-check run without requiring a request path", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-auth-"));
    const paths = createRunPaths(
      root,
      new Date("2026-09-12T12:34:56Z"),
      "auth-check",
    );
    expect(paths.kind).toBe("auth-check");
    expect(paths.reportPath).toContain("/runs/");
    expect(paths.browserOutputDir).toContain("/browser");
  });

  it("finds the latest valid prior report with the same request hash", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cart-"));
    const runs = join(root, "runs");
    const hash = "a".repeat(64);
    mkdirSync(join(runs, "2026-01-01"), { recursive: true });
    const report = JSON.parse(
      readFileSync(
        new URL("fixtures/valid-report.json", import.meta.url),
        "utf8",
      ),
    );
    report.requestSha256 = hash;
    writeFileSync(
      join(runs, "2026-01-01", "report.json"),
      JSON.stringify(report),
    );
    expect(findPreviousReport(runs, hash)?.requestSha256).toBe(hash);
  });

  it("hashes equivalent nested requests identically", () => {
    const a = { recipes: [{ name: "x", servings: 2 }] };
    const b = { recipes: [{ servings: 2, name: "x" }] };
    expect(sha256(canonicalShoppingList(a))).toBe(sha256(canonicalShoppingList(b)));
  });
});

describe("configuration", () => {
  it("uses a profile outside the repository and defaults to delivery", () => {
    const config = loadConfig(
      {
        HOME: "/Users/test",
      },
      "/repo",
    );
    expect(config.profileDir).toBe(
      "/Users/test/.whole-foods-cart/chrome-profile",
    );
    expect(config.deliveryMode).toBe("delivery");
    expect(sha256("same")).toHaveLength(64);
  });

  it("configures owned Chrome and the local MCP binary", () => {
    const config = loadConfig(
      {
        HOME: "/Users/test",
        USER: "test",
      },
      "/repo",
    );
    expect(config.chromeExecutable).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(config.chromeStartupTimeoutMs).toBe(15_000);
    expect(config.chromeStopTimeoutMs).toBe(10_000);
    expect(config.playwrightMcpBin).toBe(
      "/repo/node_modules/.bin/playwright-mcp",
    );
  });
});
