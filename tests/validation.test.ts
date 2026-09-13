import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertReportMatchesRequest,
  ValidationFailure,
  loadRequest,
  parseReport,
} from "../src/validation.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

describe("request validation", () => {
  it("loads a valid recipe-aware request", () => {
    const request = loadRequest(fixture("valid-request.json"));
    expect(request.recipes[0]?.ingredients[0]?.id).toBe("chicken");
  });

  it("rejects an ingredient without an amount-bearing request", () => {
    expect(() => loadRequest(fixture("invalid-request.json")))
      .toThrow(ValidationFailure);
  });
});

describe("report validation", () => {
  it("parses a valid report", () => {
    const report = parseReport(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    expect(report.checkoutVisited).toBe(false);
  });

  it("rejects malformed final output", () => {
    expect(() => parseReport('{"runStatus":"completed"}'))
      .toThrow(ValidationFailure);
  });

  it("requires one report selection per requested ingredient", () => {
    const request = loadRequest(fixture("valid-request.json"));
    const report = parseReport(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    report.selections = [];
    expect(() => assertReportMatchesRequest(report, request))
      .toThrow(/missing ingredient IDs: chicken/);
  });
});
