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
      deliveryMode: "delivery",
      previousReport: null,
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("DELIVERY MODE: delivery");
    expect(prompt).toContain("Chicken stir-fry");
    expect(prompt).toContain("b".repeat(64));
  });

  it("contains the explicit checkout stop conditions", () => {
    const prompt = renderPrompt({
      request,
      requestSha256: "b".repeat(64),
      deliveryMode: "delivery",
      previousReport: prior,
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("NEVER open or enter checkout");
    expect(prompt).toContain("Do not change the saved address or payment setting");
    expect(prompt).toContain("report failure when the delivery context");
    expect(prompt).toContain("Use the current controlled page");
    expect(prompt).toContain("Do not create tabs");
    expect(prompt).toMatch(/Do not\s+click the location control/);
    expect(prompt).toContain("If 43214 appears anywhere in the page");
    expect(prompt).toContain("PREVIOUS REPORT FOR CONTROLLED RERUN");
  });

  it("provides an absolute output path for optional final screenshots", () => {
    const browserOutputDir = "/repo/runs/abc123/browser";
    const prompt = renderPrompt({
      request,
      requestSha256: "b".repeat(64),
      deliveryMode: "delivery",
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
      deliveryMode: "delivery",
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("Confirm that Amazon is authenticated");
    expect(prompt).toContain("Use the current controlled page");
    expect(prompt).toContain("Do not create tabs");
    expect(prompt).toMatch(/Do\s+not click the location control/);
    expect(prompt).toContain("If 43214 appears anywhere in the page");
    expect(prompt).toContain("DELIVERY MODE: delivery");
    expect(prompt).toContain("/repo/runs/id/browser/auth-state.png");
    expect(prompt).toContain("Do not include personal details");
    expect(prompt).toContain("NEVER open or enter checkout");
    expect(prompt).not.toContain("FOR EACH INGREDIENT");
    expect(prompt).not.toContain("GROCERY REQUEST");
  });
});

describe("harmless attachment prompt", () => {
  it("permits only navigation to and observation of Example Domain", () => {
    const prompt = renderAttachmentPrompt();
    expect(prompt).toContain("https://example.com");
    expect(prompt).toMatch(
      /navigate the controlled tab directly to\s+https:\/\/example\.com/,
    );
    expect(prompt).toContain("browser_navigate");
    expect(prompt).toContain("NEVER use browser_run_code_unsafe");
    expect(prompt).toContain("Do not navigate anywhere else");
    expect(prompt).toContain("Do not click, type, or submit");
    expect(prompt).not.toContain("Amazon");
    expect(prompt).not.toContain("cart");
  });
});
