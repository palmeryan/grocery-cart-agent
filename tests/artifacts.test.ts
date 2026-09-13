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
  canonicalRequest,
  createRunPaths,
  findPreviousReport,
  sha256,
} from "../src/artifacts.js";
import { loadConfig } from "../src/config.js";

describe("artifact paths", () => {
  it("creates one timestamped run outside tracked source paths", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cart-"));
    const paths = createRunPaths(root, new Date("2026-09-12T12:34:56Z"));
    expect(paths.runId).toBe("2026-09-12T12-34-56-000Z");
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
    expect(sha256(canonicalRequest(a))).toBe(sha256(canonicalRequest(b)));
  });
});

describe("configuration", () => {
  it("uses a profile outside the repository and requires a postal code", () => {
    const config = loadConfig(
      {
        HOME: "/Users/test",
        WFM_EXPECTED_POSTAL_CODE: "02139",
      },
      "/repo",
    );
    expect(config.profileDir).toBe(
      "/Users/test/.whole-foods-cart/chrome-profile",
    );
    expect(config.expectedPostalCode).toBe("02139");
    expect(sha256("same")).toHaveLength(64);
  });
});
