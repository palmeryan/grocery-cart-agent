import { describe, expect, it } from "vitest";
import { assertShoppingPlanIntegrity, compileShoppingPlan, type MealPlanDraft } from "../src/meal-plan.js";
import { compileRecipeDocuments } from "../src/meal-plan-agent.js";
import type { RecipeIngredientQuantity } from "../src/types.js";
import { parseMealPlanDraft, parseShoppingPlan } from "../src/validation.js";

const quantity = (
  value: number,
  unit: string,
  quantityMax: number | null = null,
  approximate = false,
): RecipeIngredientQuantity => ({ quantity: value, quantityMax, unit, approximate });

const amount = (
  raw: string,
  sourceQuantity: RecipeIngredientQuantity | null = null,
  additiveQuantity: RecipeIngredientQuantity | null = sourceQuantity,
) => ({ raw, sourceQuantity, additiveQuantity });

const line = (
  sourceText: string,
  name: string,
  overrides: Partial<MealPlanDraft["recipes"][number]["ingredients"][number]> = {},
) => ({
  sourceText,
  name,
  amount: amount(""),
  preparation: null,
  context: null,
  optional: false,
  pantryStatus: "buy" as const,
  alternatives: [],
  unresolved: [],
  ...overrides,
});

describe("meal-plan compiler", () => {
  it("accepts only the minimal model contract", () => {
    const draft = { recipes: [{ sourceName: "recipe.md", ingredients: [line(
      "2–3 limes",
      "lime",
      { amount: amount("2–3 limes", quantity(2, "limes", 3)) },
    )] }] };
    expect(parseMealPlanDraft(JSON.stringify(draft))).toEqual(draft);
    expect(() => parseMealPlanDraft(JSON.stringify({
      ...draft,
      recipes: [{ ...draft.recipes[0], recipeId: "model-id", title: "Model title" }],
      decisionLog: [],
    }))).toThrow(/invalid meal plan draft/i);
  });

  it("sums compatible additive quantities while preserving source quantities", () => {
    const plan = compileShoppingPlan({ recipes: [
      { sourceName: "one.md", ingredients: [line("2 garlic cloves", "garlic", {
        amount: amount("2 garlic cloves", quantity(2, "cloves")),
      })] },
      { sourceName: "two.md", ingredients: [line("6 garlic cloves", "garlic", {
        amount: amount("6 garlic cloves", quantity(6, "cloves")),
      })] },
    ] });
    expect(plan.purchaseIntents[0]?.sourceAmounts.map(({ raw }) => raw)).toEqual([
      "2 garlic cloves", "6 garlic cloves",
    ]);
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(quantity(8, "clove"));
  });

  it("combines package totals with loose weight", () => {
    const plan = compileShoppingPlan({ recipes: [
      { sourceName: "bags.md", ingredients: [line("2 (12-ounce) bags frozen peas", "frozen peas", {
        amount: amount("2 (12-ounce) bags", quantity(2, "bags"), quantity(24, "ounces")),
      })] },
      { sourceName: "loose.md", ingredients: [line("10 ounces frozen peas", "frozen peas", {
        amount: amount("10 ounces", quantity(10, "ounces")),
      })] },
    ] });
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(quantity(34, "oz"));
  });

  it("combines source-supported approximate equivalents", () => {
    const plan = compileShoppingPlan({ recipes: [
      { sourceName: "count.md", ingredients: [line("4 thighs (about 1½ pounds)", "bone-in chicken thighs", {
        amount: amount("4 thighs (about 1½ pounds)", quantity(4, "thighs"), quantity(1.5, "pounds", null, true)),
      })] },
      { sourceName: "weight.md", ingredients: [line("2 pounds chicken thighs", "bone-in chicken thighs", {
        amount: amount("2 pounds", quantity(2, "pounds")),
      })] },
    ] });
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(quantity(3.5, "lb", null, true));
  });

  it("preserves and sums ranges", () => {
    const plan = compileShoppingPlan({ recipes: [
      { sourceName: "a.md", ingredients: [line("2–3 limes", "lime", {
        amount: amount("2–3 limes", quantity(2, "limes", 3)),
      })] },
      { sourceName: "b.md", ingredients: [line("1 lime", "lime", {
        amount: amount("1 lime", quantity(1, "lime")),
      })] },
    ] });
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(quantity(3, "lime", 4));
  });

  it("retains incompatible amounts without fabricating a total", () => {
    const plan = compileShoppingPlan({ recipes: [
      { sourceName: "a.md", ingredients: [line("mint for serving", "fresh mint")] },
      { sourceName: "b.md", ingredients: [line("½ cup mint", "fresh mint", {
        amount: amount("½ cup", quantity(0.5, "cup")),
      })] },
    ] });
    expect(plan.purchaseIntents[0]?.additiveAmount).toBeNull();
    expect(plan.decisionLog.some(({ code }) => code === "incompatible_amounts")).toBe(true);
  });

  it("derives intent IDs from source membership rather than model wording", () => {
    const sources = [
      { sourceName: "a.md", ingredients: [line("Crushed red pepper", "crushed red pepper")] },
      { sourceName: "b.md", ingredients: [line("red-pepper flakes", "crushed red pepper")] },
    ];
    const first = compileShoppingPlan({ recipes: sources });
    const renamed = compileShoppingPlan({ recipes: sources.map((recipe) => ({
      ...recipe,
      ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient, name: "red pepper flakes" })),
    })) });
    expect(first.purchaseIntents[0]?.id).toBe(renamed.purchaseIntents[0]?.id);
    expect(first.recipes[0]).not.toHaveProperty("recipeId");
    expect(first.recipes[0]?.ingredients[0]).not.toHaveProperty("lineId");
  });

  it("ignores incidental boundary whitespace in source membership IDs", () => {
    const clean = compileShoppingPlan({ recipes: [
      { sourceName: "a.md", ingredients: [line("2½ cups chicken stock", "chicken broth")] },
    ] });
    const padded = compileShoppingPlan({ recipes: [
      { sourceName: "a.md", ingredients: [line("  2½ cups chicken stock ", "chicken broth")] },
    ] });
    expect(clean.purchaseIntents[0]?.id).toBe(padded.purchaseIntents[0]?.id);
    expect(padded.recipes[0]?.ingredients[0]?.sourceText).toBe("2½ cups chicken stock");
  });

  it("changes an intent ID when its source membership changes", () => {
    const first = compileShoppingPlan({ recipes: [{ sourceName: "a.md", ingredients: [line("salt", "salt")] }] });
    const second = compileShoppingPlan({ recipes: [
      { sourceName: "a.md", ingredients: [line("salt", "salt")] },
      { sourceName: "b.md", ingredients: [line("salt", "salt")] },
    ] });
    expect(first.purchaseIntents[0]?.id).not.toBe(second.purchaseIntents[0]?.id);
  });

  it("buys uncertain pantry items and reports the source", () => {
    const plan = compileShoppingPlan({ recipes: [{ sourceName: "soup.md", ingredients: [
      line("seasoning blend", "seasoning blend", { pantryStatus: "uncertain" }),
    ] }] });
    expect(plan.purchaseIntents[0]?.disposition).toBe("buy");
    expect(plan.decisionLog[0]).toMatchObject({
      priority: "high",
      code: "unresolved_interpretation",
      sources: [{ sourceName: "soup.md", sourceText: "seasoning blend" }],
    });
  });

  it("reports consolidated pantry uncertainty once and never claims an omitted optional is bought", () => {
    const plan = compileShoppingPlan({ recipes: [
      { sourceName: "one.md", ingredients: [line("seasoning blend", "seasoning blend", { pantryStatus: "uncertain" })] },
      { sourceName: "two.md", ingredients: [line("seasoning blend", "seasoning blends", { pantryStatus: "uncertain" })] },
      { sourceName: "three.md", ingredients: [line("finishing oil, optional", "finishing oil", {
        optional: true,
        pantryStatus: "uncertain",
      })] },
    ] });

    const uncertainty = plan.decisionLog.filter(({ code }) => code === "unresolved_interpretation");
    expect(uncertainty).toHaveLength(1);
    expect(uncertainty[0]?.sources).toHaveLength(2);
    expect(plan.decisionLog.find(({ code }) => code === "optional_omitted")?.message).toContain("finishing oil");
    expect(plan.decisionLog.some(({ message }) => message.includes("finishing oil") && message.includes("buy list"))).toBe(false);
  });

  it("reports optional and pantry omissions while retaining every source", () => {
    const plan = compileShoppingPlan({ recipes: [{ sourceName: "soup.md", ingredients: [
      line("salt", "salt", { pantryStatus: "assume_pantry" }),
      line("fresh dill, optional", "fresh dill", { optional: true }),
    ] }] });
    expect(plan.recipes[0]?.ingredients.map(({ disposition }) => disposition)).toEqual([
      "assume_pantry", "omit_optional",
    ]);
    expect(plan.decisionLog.map(({ code }) => code)).toEqual([
      "pantry_assumption", "optional_omitted",
    ]);
  });

  it("gives split components unique source references while retaining the full line", () => {
    const plan = compileShoppingPlan({ recipes: [{ sourceName: "seasoning.md", ingredients: [
      line("Salt and black pepper", "salt"),
      line("Salt and black pepper", "black pepper"),
    ] }] });
    const [salt, pepper] = plan.recipes[0]?.ingredients ?? [];
    expect(salt?.sourceText).toBe("Salt and black pepper");
    expect(pepper?.sourceText).toBe("Salt and black pepper");
    expect(salt?.componentIndex).toBe(1);
    expect(pepper?.componentIndex).toBe(2);
  });

  it("rejects broken cross-references and round-trips the strict plan schema", () => {
    const plan = compileShoppingPlan({ recipes: [{ sourceName: "soup.md", ingredients: [line("salt", "salt")] }] });
    expect(parseShoppingPlan(JSON.stringify(plan))).toEqual(plan);
    plan.recipes[0]!.ingredients[0]!.purchaseIntentId = "intent-0000000000000000";
    expect(() => assertShoppingPlanIntegrity(plan)).toThrow(/invalid source reference|valid purchase intent/);
  });
});

describe("recipe-document compiler seam", () => {
  it("validates exact recipe and line provenance", async () => {
    const documents = [{ sourceName: "one.md", text: "2 apples" }];
    const plan = await compileRecipeDocuments(documents, async () => ({ recipes: [{
      sourceName: "one.md",
      ingredients: [line("2 apples", "apple", { amount: amount("2 apples", quantity(2, "apples")) })],
    }] }));
    expect(plan.purchaseIntents[0]?.additiveAmount?.quantity).toBe(2);

    await expect(compileRecipeDocuments(documents, async () => ({ recipes: [{
      sourceName: "renamed.md",
      ingredients: [line("2 apples", "apple")],
    }] }))).rejects.toThrow(/sources do not match/);
    await expect(compileRecipeDocuments(documents, async () => ({ recipes: [{
      sourceName: "one.md",
      ingredients: [line("apples", "apple")],
    }] }))).rejects.toThrow(/complete verbatim line/);
  });

  it("rejects empty recipe input before invoking the agent", async () => {
    let called = false;
    await expect(compileRecipeDocuments([], async () => {
      called = true;
      throw new Error("should not run");
    })).rejects.toThrow(/at least one recipe document/i);
    expect(called).toBe(false);
  });
});
