import { describe, expect, it } from "vitest";
import {
  buildCartReport,
  completeIngredientResults,
} from "../src/report-builder.js";
import type {
  AuthReport,
  GroceryRequest,
  IngredientResult,
} from "../src/types.js";

const request: GroceryRequest = {
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
  deliveryAddressConfirmed: true,
  wholeFoodsStorefrontConfirmed: true,
  checkoutVisited: false,
  settingsChanged: false,
  failureReason: null,
};

const item = (status: IngredientResult["status"] = "added"): IngredientResult => ({
  ingredientId: "apples",
  requested: "2 apples",
  status,
  productName: status === "added" ? "Organic Apples" : null,
  packageSize: status === "added" ? "3 lb bag" : null,
  quantity: status === "added" ? 1 : 0,
  price: status === "added" ? "$5.99" : null,
  rationale: "The product fits the recipe.",
  confidence: "high",
  failureReason: status === "added" ? null : "No suitable product was available.",
});

const inspection = (bodyText: string, quantity = 1) => ({
  items: bodyText.includes("Organic Apples")
    ? [{ productName: "Organic Apples", quantity }]
    : [],
  totalItemCount: bodyText.includes("Organic Apples") ? quantity : 0,
  url: "https://www.wholefoodsmarket.com/grocery/cart",
  bodyText,
});

describe("report builder", () => {
  it("uses one final text check to confirm an agent-reported add", () => {
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: inspection("Your cart is empty"),
      final: inspection("Organic Apples\nCurrent quantity: 1"),
      results: [item()],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.finalCartDelta).toEqual([
      { productName: "Organic Apples", quantity: 1 },
    ]);
    expect(report.failureReason).toBeNull();
  });

  it("records a final verification mismatch as an output note without retrying", () => {
    const report = buildCartReport({
      request,
      requestSha256: "a".repeat(64),
      preflight,
      baseline: inspection("Your cart is empty"),
      final: inspection("Your cart is empty"),
      results: [item()],
    });
    expect(report.runStatus).toBe("completed");
    expect(report.failureReason).toBeNull();
    expect(report.verificationNotes?.[0]).toContain("Final cart verification");
    expect(report.selections[0]?.status).toBe("added");
  });

  it("fills unvisited ingredients with explicit failed results", () => {
    const results = completeIngredientResults(request, [], "run stopped");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ingredientId: "apples",
      status: "failed",
      failureReason: "run stopped",
    });
  });
});
