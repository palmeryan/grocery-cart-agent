import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/prompt.js";
import type { CartReport, GroceryRequest } from "../src/types.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

const request = JSON.parse(
  readFileSync(fixture("valid-request.json"), "utf8"),
) as GroceryRequest;

const prior = JSON.parse(
  readFileSync(fixture("valid-report.json"), "utf8"),
) as CartReport;

describe("cart prompt", () => {
  it("includes location, request context, and the request hash", () => {
    const prompt = renderPrompt({
      request,
      requestSha256: "b".repeat(64),
      expectedPostalCode: "02139",
      previousReport: null,
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("02139");
    expect(prompt).toContain("Chicken stir-fry");
    expect(prompt).toContain("b".repeat(64));
  });

  it("contains the explicit checkout stop conditions", () => {
    const prompt = renderPrompt({
      request,
      requestSha256: "b".repeat(64),
      expectedPostalCode: "02139",
      previousReport: prior,
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("NEVER open or enter checkout");
    expect(prompt).toContain("Do not change an address or payment setting");
    expect(prompt).toContain("Stop immediately");
    expect(prompt).toContain("PREVIOUS REPORT FOR CONTROLLED RERUN");
  });

  it("requires the final screenshot under the absolute browser output directory", () => {
    const browserOutputDir = "/repo/runs/abc123/browser";
    const prompt = renderPrompt({
      request,
      requestSha256: "b".repeat(64),
      expectedPostalCode: "02139",
      previousReport: null,
      browserOutputDir,
    });
    expect(prompt).toContain(`BROWSER OUTPUT DIRECTORY: ${browserOutputDir}`);
    expect(prompt).toContain(`${browserOutputDir}/final-state.png`);
    expect(prompt).toMatch(
      /browser_take_screenshot[\s\S]*final-state\.png|final-state\.png[\s\S]*browser_take_screenshot/,
    );
    // Path must be labeled as output config, not free-form request text.
    const outputDirIndex = prompt.indexOf("BROWSER OUTPUT DIRECTORY:");
    const groceryRequestIndex = prompt.indexOf("GROCERY REQUEST:");
    expect(outputDirIndex).toBeGreaterThan(-1);
    expect(groceryRequestIndex).toBeGreaterThan(outputDirIndex);
  });
});
