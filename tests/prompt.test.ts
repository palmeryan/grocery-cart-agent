import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderAttachmentPrompt,
  renderAuthPrompt,
  renderPrompt,
} from "../src/prompt.js";
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

describe("auth-only prompt", () => {
  it("allows only non-mutating auth and storefront checks", () => {
    const prompt = renderAuthPrompt({
      expectedPostalCode: "00000",
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("Confirm that Amazon is authenticated");
    expect(prompt).toContain("00000");
    expect(prompt).toContain("/repo/runs/id/browser/auth-state.png");
    expect(prompt).toContain("NEVER inspect cart contents");
    expect(prompt).toContain("NEVER search for products");
    expect(prompt).toContain("NEVER add, remove, or change cart items");
    expect(prompt).toContain("NEVER open or enter checkout");
    expect(prompt).toContain("NEVER expose an account name");
    expect(prompt).not.toContain("FOR EACH INGREDIENT");
    expect(prompt).not.toContain("GROCERY REQUEST");
  });
});

describe("harmless attachment prompt", () => {
  it("permits only observation of Example Domain", () => {
    const prompt = renderAttachmentPrompt();
    expect(prompt).toContain("https://example.com");
    expect(prompt).toContain("Do not navigate");
    expect(prompt).toContain("Do not click, type, or submit");
    expect(prompt).not.toContain("Amazon");
    expect(prompt).not.toContain("cart");
  });
});
