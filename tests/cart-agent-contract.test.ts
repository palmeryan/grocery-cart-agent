import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { classifyCartAgentUrl } from "../src/cli.js";

const schemaPath = fileURLToPath(
  new URL("../schemas/cart-agent-result.schema.json", import.meta.url),
);
const promptPath = fileURLToPath(
  new URL("../prompts/cart-agent.md", import.meta.url),
);

const readSchema = (): Record<string, unknown> =>
  JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;

const readPrompt = (): string => readFileSync(promptPath, "utf8");

const base = {
  ingredientId: "chicken",
  requested: "about 1.5 lb boneless skinless chicken thighs",
  productName: "365 by Whole Foods Market Boneless Skinless Chicken Thighs",
  productId: "B000000001",
  packageSize: "1.5 lb",
  quantity: 1,
  price: "$12.99",
  rationale: "The package meets the amount and fits the recipe context.",
  confidence: "high",
  failureReason: null,
} as const;

const validResults = {
  added: { ...base, status: "added" },
  alreadyPresent: {
    ...base,
    ingredientId: "olive-oil",
    requested: "extra-virgin olive oil",
    productName: "365 by Whole Foods Market Extra Virgin Olive Oil",
    packageSize: "25.5 fl oz",
    price: "$9.99",
    status: "already_present",
  },
  skipped: {
    ...base,
    ingredientId: "fresh-tarragon",
    requested: "2 tablespoons fresh tarragon",
    productName: null,
    productId: null,
    packageSize: null,
    quantity: 0,
    price: null,
    rationale: "No defensible match was visible in the storefront.",
    confidence: "medium",
    failureReason: "No suitable fresh tarragon was available.",
    status: "skipped",
  },
  failed: {
    ...base,
    ingredientId: "milk",
    requested: "1 cup whole milk",
    productName: null,
    productId: null,
    packageSize: null,
    quantity: 0,
    price: null,
    rationale: "The cart state could not be established after the attempt.",
    confidence: "low",
    failureReason: "The browser state prevented safe cart verification.",
    status: "failed",
  },
} as const;

const compileValidator = (): ValidateFunction => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readSchema());
};

const expectValid = (value: unknown): void => {
  const validate = compileValidator();
  expect(validate(value), JSON.stringify(validate.errors, null, 2)).toBe(true);
};

const expectInvalid = (value: unknown): void => {
  expect(compileValidator()(value)).toBe(false);
};

describe("Cart Agent result schema", () => {
  it.each(Object.entries(validResults))("accepts a valid %s result", (_name, result) => {
    expectValid(result);
  });

  it.each([
    ["a result missing a required field", { ...validResults.added, rationale: undefined }],
    ["an unknown property", { ...validResults.added, unexpected: true }],
    ["an unsupported status", { ...validResults.added, status: "pending" }],
  ] as const)("rejects %s", (_description, result) => {
    expectInvalid(result);
  });
});

describe("Cart Agent prompt contract", () => {
  it("requires one ingredient and preserves recipe/cart context", () => {
    const prompt = readPrompt();
    expect(prompt).toMatch(/exactly one|one ingredient at a time/i);
    expect(prompt).toMatch(/recipeContext|recipe context/i);
    expect(prompt).toMatch(/cartContext|cart context/i);
    expect(prompt).toMatch(/servings|cooking context/i);
  });

  it("requires adaptive observation instead of a fixed search recipe", () => {
    const prompt = readPrompt();
    expect(prompt).toMatch(/adaptive/i);
    expect(prompt).toMatch(/inspect|observe|re-evaluate/i);
    expect(prompt).toMatch(/choose.*candidate|choose.*product|decide what to search/i);
  });

  it("finishes add interactions without requiring on-page confirmation", () => {
    const prompt = readPrompt();
    expect(prompt).toMatch(/weighted product/i);
    expect(prompt).toMatch(/quantity selector/i);
    expect(prompt).toMatch(/commit.*item|control that commits/i);
    expect(prompt).not.toMatch(/on-page confirmation/i);
  });

  it("prohibits checkout and settings changes", () => {
    const prompt = readPrompt();
    expect(prompt).toMatch(/never enter\s+checkout/i);
    expect(prompt).toMatch(/never[\s\S]*change account or fulfillment settings/i);
  });

  it("requires a structured result matching the harness schema", () => {
    const prompt = readPrompt();
    expect(prompt).toMatch(/exactly one JSON object/i);
    expect(prompt).toContain("schemas/cart-agent-result.schema.json");
    expect(prompt).not.toMatch(/claim `added` only|on-page confirmation/i);
    for (const field of [
      "ingredientId",
      "requested",
      "status",
      "productName",
      "productId",
      "packageSize",
      "quantity",
      "price",
      "rationale",
      "confidence",
      "failureReason",
    ]) {
      expect(compileValidator().schema).toHaveProperty("properties." + field);
    }
  });
});

describe("Cart Agent runtime page classification", () => {
  it("does not fail a valid Whole Foods result solely because the tab ends on cart", () => {
    expect(classifyCartAgentUrl("https://www.wholefoodsmarket.com/grocery/cart")).toMatchObject({
      safe: true,
      checkoutVisited: false,
      settingsChanged: false,
      failureReason: null,
    });
  });

  it("continues to reject checkout and settings pages", () => {
    expect(classifyCartAgentUrl("https://www.wholefoodsmarket.com/grocery/checkout").safe).toBe(false);
    expect(classifyCartAgentUrl("https://www.wholefoodsmarket.com/account/address").safe).toBe(false);
  });
});
