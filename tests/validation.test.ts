import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertReportMatchesRequest,
  assertReportPreflight,
  ValidationFailure,
  loadRequest,
  parseReport,
} from "../src/validation.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

const writeTempRequest = (value: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "wfm-req-"));
  const path = join(dir, "request.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
};

describe("request validation", () => {
  it("loads a valid recipe-aware request", () => {
    const request = loadRequest(fixture("valid-request.json"));
    expect(request.recipes[0]?.ingredients[0]?.id).toBe("chicken");
  });

  it("rejects an ingredient without an amount-bearing request", () => {
    expect(() => loadRequest(fixture("invalid-request.json")))
      .toThrow(ValidationFailure);
  });

  it("rejects duplicate ingredient IDs across different recipes", () => {
    const path = writeTempRequest({
      recipes: [
        {
          id: "stir-fry",
          name: "Chicken stir-fry",
          servings: 2,
          context: "weeknight",
          ingredients: [{ id: "chicken", request: "about 1 lb chicken" }],
        },
        {
          id: "soup",
          name: "Chicken soup",
          servings: 4,
          context: "batch cook",
          ingredients: [{ id: "chicken", request: "about 2 lb chicken" }],
        },
      ],
    });
    expect(() => loadRequest(path)).toThrow(/duplicate ingredient IDs: chicken/i);
  });

  it("rejects duplicate ingredient IDs within one recipe", () => {
    const path = writeTempRequest({
      recipes: [
        {
          id: "stir-fry",
          name: "Chicken stir-fry",
          servings: 2,
          context: "weeknight",
          ingredients: [
            { id: "chicken", request: "about 1 lb chicken" },
            { id: "chicken", request: "about 2 lb chicken" },
          ],
        },
      ],
    });
    expect(() => loadRequest(path)).toThrow(/duplicate ingredient IDs: chicken/i);
  });

  it("rejects duplicate recipe IDs", () => {
    const path = writeTempRequest({
      recipes: [
        {
          id: "stir-fry",
          name: "Chicken stir-fry",
          servings: 2,
          context: "weeknight",
          ingredients: [{ id: "chicken", request: "about 1 lb chicken" }],
        },
        {
          id: "stir-fry",
          name: "Tofu stir-fry",
          servings: 2,
          context: "vegetarian night",
          ingredients: [{ id: "tofu", request: "1 block firm tofu" }],
        },
      ],
    });
    expect(() => loadRequest(path)).toThrow(/duplicate recipe IDs: stir-fry/i);
  });

  it.each(["staples.json", "ambiguous.json", "substitutions.json"])(
    "validates acceptance fixture %s",
    (name) => {
      const path = fileURLToPath(new URL(`../examples/${name}`, import.meta.url));
      expect(loadRequest(path).recipes).toHaveLength(1);
    },
  );
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

  it("rejects unknown report selection IDs", () => {
    const request = loadRequest(fixture("valid-request.json"));
    const report = parseReport(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    report.selections[0]!.ingredientId = "not-in-request";
    expect(() => assertReportMatchesRequest(report, request))
      .toThrow(/unknown ingredient IDs: not-in-request/);
  });

  it("rejects duplicate report selection IDs", () => {
    const request = loadRequest(fixture("valid-request.json"));
    const report = parseReport(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    report.selections.push({ ...report.selections[0]! });
    expect(() => assertReportMatchesRequest(report, request))
      .toThrow(/duplicate ingredient IDs: chicken/);
  });

  it("passes preflight when auth and location gates are confirmed", () => {
    const report = parseReport(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    expect(() => assertReportPreflight(report)).not.toThrow();
  });

  it.each([
    ["authenticated", { authenticated: false }],
    ["expectedLocationConfirmed", { expectedLocationConfirmed: false }],
    ["wholeFoodsStorefrontConfirmed", { wholeFoodsStorefrontConfirmed: false }],
  ] as const)(
    "rejects preflight when %s is false",
    (field, patch) => {
      const report = parseReport(
        readFileSync(fixture("valid-report.json"), "utf8"),
      );
      Object.assign(report, patch);
      expect(() => assertReportPreflight(report)).toThrow(
        new RegExp(field),
      );
    },
  );

  it("rejects completed status when any selection is skipped", () => {
    const report = parseReport(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    report.selections[0]!.status = "skipped";
    report.selections[0]!.productName = null;
    report.selections[0]!.packageSize = null;
    report.selections[0]!.quantity = 0;
    report.selections[0]!.price = null;
    expect(() => assertReportPreflight(report))
      .toThrow(/completed.*skipped|skipped.*completed/i);
  });

  it("allows partial status with skipped selections", () => {
    const report = parseReport(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    report.runStatus = "partial";
    report.selections[0]!.status = "skipped";
    report.selections[0]!.productName = null;
    report.selections[0]!.packageSize = null;
    report.selections[0]!.quantity = 0;
    report.selections[0]!.price = null;
    expect(() => assertReportPreflight(report)).not.toThrow();
  });
});
