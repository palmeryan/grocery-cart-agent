import { describe, expect, it } from "vitest";
import {
  buildCartReport,
  completeCartAgentResults,
} from "../src/report-builder.js";
import type {
  AuthReport,
  ShoppingList,
  CartAgentResult,
} from "../src/types.js";

const request: ShoppingList = {
  recipes: [{
    id: "recipe",
    name: "Test recipe",
    servings: 2,
    context: "Test context",
    ingredients: [{ id: "apples", request: "2 apples" }],
  }],
};

const preflight: AuthReport = {
  runStatus: "completed",
  authenticated: true,
  deliveryModeConfirmed: true,
  wholeFoodsStorefrontConfirmed: true,
  checkoutVisited: false,
  settingsChanged: false,
  failureReason: null,
};

const item = (status: CartAgentResult["status"] = "added"): CartAgentResult => ({
  ingredientId: "apples",
  requested: "2 apples",
  status,
  productName: status === "added" ? "Organic Apples" : null,
  productId: status === "added" ? "B000000001" : null,
  packageSize: status === "added" ? "3 lb bag" : null,
  quantity: status === "added" ? 1 : 0,
  price: status === "added" ? "$5.99" : null,
  rationale: "The product fits the recipe.",
  confidence: "high",
  failureReason: status === "added" ? null : "No suitable product was available.",
});

const inspection = (bodyText: string, quantity = 1) => ({
  items: bodyText.includes("Organic Apples")
    ? [{ productName: "Organic Apples", productId: "B000000001", quantity }]
    : [],
  totalItemCount: bodyText.includes("Organic Apples") ? quantity : 0,
  url: "https://www.wholefoodsmarket.com/grocery/cart",
  bodyText,
});

describe("report builder", () => {
  it("uses the structured final cart delta to confirm an agent-reported add", () => {
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: inspection("Your cart is empty"),
      final: inspection("Organic Apples\nCurrent quantity: 1"),
      results: [item()],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.verificationStatus).toBe("confirmed");
    expect(report.finalCartDelta).toEqual([
      { productName: "Organic Apples", productId: "B000000001", quantity: 1 },
    ]);
    expect(report.failureReason).toBeNull();
  });

  it("matches a cart title that includes the separately reported package size", () => {
    const result = {
      ...item(),
      productName: "Kikkoman Naturally Brewed Soy Sauce",
      packageSize: "15 oz",
    };
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: inspection("Your cart is empty"),
      final: {
        ...inspection("unstructured text without nearby quantity evidence"),
        items: [
          {
            productName: "Kikkoman Naturally Brewed Soy Sauce, 15 oz",
            quantity: 1,
          },
        ],
        totalItemCount: 1,
      },
      results: [result],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.verificationNotes).toBeUndefined();
  });

  it("matches differing storefront labels by stable product ID", () => {
    const result = {
      ...item(),
      productName:
        "Fresh Produce (Brands May Vary) Broccoli Crowns Conventional",
      productId: "B07887CXXC",
      packageSize: "1 Each",
    };
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: inspection("Your cart is empty"),
      final: {
        ...inspection("cart rendered"),
        items: [
          {
            productName: "Broccoli Crowns Conventional, 1 Each",
            productId: "B07887CXXC",
            quantity: 1,
          },
        ],
        totalItemCount: 1,
      },
      results: [result],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.verificationNotes).toBeUndefined();
  });

  it("confirms one weighted purchase when the cart reports its weight", () => {
    const result = {
      ...item(),
      ingredientId: "ginger",
      requested: "one 2-inch piece fresh ginger",
      productName: "Fresh Produce (Brands May Vary) Produce Organic Ginger Root",
      productId: "B0C6V3416T",
      packageSize: "0.25 lb",
      quantity: 1,
    };
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: inspection("Your cart is empty"),
      final: {
        ...inspection("cart rendered"),
        items: [
          {
            productName: "Produce Organic Ginger Root",
            productId: "B0C6V3416T",
            quantity: 0.25,
          },
        ],
        totalItemCount: 1,
      },
      results: [result],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.verificationStatus).toBe("confirmed");
    expect(report.verificationNotes).toBeUndefined();
  });

  it("still requires the full cart quantity for multiple purchase units", () => {
    const result = { ...item(), quantity: 2 };
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: inspection("Your cart is empty"),
      final: inspection("Organic Apples", 1),
      results: [result],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.verificationStatus).toBe("inconclusive");
  });

  it("confirms already-present results against the structured baseline", () => {
    const existing = {
      ...item(),
      status: "already_present" as const,
      packageSize: null,
      price: null,
    };
    const baseline = inspection("Organic Apples");
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline,
      final: baseline,
      results: [existing],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.finalCartDelta).toEqual([]);
  });

  it("keeps execution completed when final reconciliation is inconclusive", () => {
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: inspection("Your cart is empty"),
      final: inspection("Your cart is empty"),
      results: [item()],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.verificationStatus).toBe("inconclusive");
    expect(report.failureReason).toBeNull();
    expect(report.verificationNotes?.[0]).toContain("Final cart verification");
    expect(report.selections[0]?.status).toBe("added");
  });

  it("fails closed when either cart extraction is degraded", () => {
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: {
        ...inspection("Your cart is empty"),
        extractionStatus: "degraded",
        extractionDiagnostic: "selectors no longer matched",
      },
      final: inspection("Organic Apples\nCurrent quantity: 1"),
      results: [item()],
    });
    expect(report.runStatus).toBe("failed");
    expect(report.verificationStatus).toBe("not_run");
    expect(report.failureReason).toContain("baseline cart extraction was degraded");
  });

  it("fills unvisited ingredients with explicit failed results", () => {
    const results = completeCartAgentResults(request, [], "run stopped");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ingredientId: "apples",
      status: "failed",
      failureReason: "run stopped",
    });
  });
});
