import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

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
    expect(prompt).toMatch(/fixed product-search recipe|precomputed candidate list/i);
  });

  it("keeps cart navigation out of the per-ingredient agent", () => {
    const prompt = readPrompt();
    expect(prompt).toMatch(/weighted product/i);
    expect(prompt).toMatch(/quantity selector/i);
    expect(prompt).toMatch(/intermediate browser state/i);
    expect(prompt).toMatch(/on-page confirmation/i);
    expect(prompt).toMatch(/do not navigate to the cart/i);
    expect(prompt).toMatch(/deterministic shell[\s\S]*single final cart check/i);
    expect(prompt).toMatch(/do not navigate back to a homepage/i);
  });

  it("prohibits checkout and settings changes", () => {
    const prompt = readPrompt();
    expect(prompt).toMatch(/may\s+not\s+open\s+or\s+enter\s+checkout/i);
    expect(prompt).toMatch(/do\s+not\s+change\s+account,\s+delivery,\s+pickup,\s+payment,\s+or\s+address settings/i);
  });

  it("requires one structured CartSelection-compatible result", () => {
    const prompt = readPrompt();
    expect(prompt).toMatch(/exactly one JSON object and nothing else/i);
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
      expect(prompt).toContain(`\`${field}\``);
    }
    expect(prompt).toMatch(/added.*only when.*evidence|claim `added` only/i);
  });
});
