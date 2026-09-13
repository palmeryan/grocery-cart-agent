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
    });
    expect(prompt).toContain("NEVER open or enter checkout");
    expect(prompt).toContain("Do not change an address or payment setting");
    expect(prompt).toContain("Stop immediately");
    expect(prompt).toContain("PREVIOUS REPORT FOR CONTROLLED RERUN");
  });
});
