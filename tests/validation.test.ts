import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertAttachmentReportSafe,
  assertAuthReportSafe,
  assertReportMatchesRequest,
  assertReportPreflight,
  ValidationFailure,
  loadRequest,
  parseAttachmentReport,
  parseAuthReport,
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
    ["completed", "authenticated", { authenticated: false }],
    ["completed", "deliveryModeConfirmed", { deliveryModeConfirmed: false }],
    ["completed", "deliveryAddressConfirmed", { deliveryAddressConfirmed: false }],
    ["completed", "wholeFoodsStorefrontConfirmed", { wholeFoodsStorefrontConfirmed: false }],
    ["partial", "authenticated", { authenticated: false }],
    ["partial", "deliveryModeConfirmed", { deliveryModeConfirmed: false }],
    ["partial", "deliveryAddressConfirmed", { deliveryAddressConfirmed: false }],
    ["partial", "wholeFoodsStorefrontConfirmed", { wholeFoodsStorefrontConfirmed: false }],
  ] as const)(
    "rejects %s preflight when %s is false",
    (runStatus, field, patch) => {
      const report = parseReport(
        readFileSync(fixture("valid-report.json"), "utf8"),
      );
      report.runStatus = runStatus;
      Object.assign(report, patch);
      expect(() => assertReportPreflight(report)).toThrow(
        new RegExp(field),
      );
    },
  );

  it("allows failed reports with false auth/location gates", () => {
    const report = parseReport(
      readFileSync(fixture("valid-report.json"), "utf8"),
    );
    report.runStatus = "failed";
    report.authenticated = false;
    report.deliveryModeConfirmed = false;
    report.deliveryAddressConfirmed = false;
    report.wholeFoodsStorefrontConfirmed = false;
    report.failureReason = "not authenticated";
    expect(() => assertReportPreflight(report)).not.toThrow();
  });

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

const validAuthReport = () =>
  JSON.parse(
    readFileSync(
      new URL("fixtures/valid-auth-report.json", import.meta.url),
      "utf8",
    ),
  );

describe("auth report validation", () => {
  it("accepts a successful non-mutating auth report", () => {
    const report = parseAuthReport(JSON.stringify(validAuthReport()));
    expect(() => assertAuthReportSafe(report)).not.toThrow();
  });

  it.each([
    ["authenticated", false],
    ["deliveryModeConfirmed", false],
    ["deliveryAddressConfirmed", false],
    ["wholeFoodsStorefrontConfirmed", false],
    ["checkoutVisited", true],
    ["settingsChanged", true],
  ] as const)("rejects an unsafe or incomplete %s result", (field, value) => {
    const report = validAuthReport();
    report[field] = value;
    expect(() =>
      assertAuthReportSafe(parseAuthReport(JSON.stringify(report))),
    ).toThrow();
  });

  it("includes the reported failure reason when an auth gate fails", () => {
    const report = {
      ...validAuthReport(),
      runStatus: "failed",
      authenticated: false,
      deliveryModeConfirmed: false,
      deliveryAddressConfirmed: false,
      wholeFoodsStorefrontConfirmed: false,
      failureReason: "Playwright Extension was not found",
    };
    expect(() =>
      assertAuthReportSafe(parseAuthReport(JSON.stringify(report))),
    ).toThrow("Playwright Extension was not found");
  });

  it("rejects cart-shaped fields", () => {
    const report = { ...validAuthReport(), selections: [] };
    expect(() => parseAuthReport(JSON.stringify(report))).toThrow();
  });
});

describe("harmless attachment report validation", () => {
  it("accepts only the fixed Example Domain result", () => {
    const text = readFileSync(
      new URL("fixtures/valid-attachment-report.json", import.meta.url),
      "utf8",
    );
    expect(() =>
      assertAttachmentReportSafe(parseAttachmentReport(text)),
    ).not.toThrow();
  });

  it.each([
    ["url", "https://not-example.com/"],
    ["title", "Wrong Title"],
  ] as const)("parse rejects invalid %s", (field, value) => {
    const report = {
      connected: true,
      url: "https://example.com/",
      title: "Example Domain",
      navigationPerformed: false,
      interactionPerformed: false,
      failureReason: null,
      [field]: value,
    };
    expect(() => parseAttachmentReport(JSON.stringify(report))).toThrow(
      ValidationFailure,
    );
  });

  it("accepts an honest connection failure and reports its reason", () => {
    const report = {
      connected: false,
      url: null,
      title: null,
      navigationPerformed: false,
      interactionPerformed: false,
      failureReason: "Playwright Extension was not found",
    };
    expect(() =>
      assertAttachmentReportSafe(
        parseAttachmentReport(JSON.stringify(report)),
      ),
    ).toThrow("Playwright Extension was not found");
  });

  it("allows navigation evidence after reaching Example Domain", () => {
    const report = {
      connected: true,
      url: "https://example.com/",
      title: "Example Domain",
      navigationPerformed: true,
      interactionPerformed: false,
      failureReason: null,
    };
    expect(() =>
      assertAttachmentReportSafe(
        parseAttachmentReport(JSON.stringify(report)),
      ),
    ).not.toThrow();
  });

  it("rejects interaction evidence via safety gate", () => {
    const report = {
      connected: true,
      url: "https://example.com/",
      title: "Example Domain",
      navigationPerformed: false,
      interactionPerformed: true,
      failureReason: null,
    };
    expect(() =>
      assertAttachmentReportSafe(
        parseAttachmentReport(JSON.stringify(report)),
      ),
    ).toThrow("performed a prohibited action");
  });
});
