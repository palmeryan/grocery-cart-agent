import { describe, expect, it } from "vitest";
import { assertRecipeCompilationIntegrity, compileRecipeCompilation, recipeCompilationToShoppingList, type IngredientsAgentOutput } from "../src/shopping-list-compiler.js";
import { compileIngredientsList } from "../src/ingredients-agent.js";
import { cartTasks } from "../src/cart-flow.js";
import { renderDecisionPrompt } from "../src/cart-decision.js";
import type { RecipeIngredientQuantity, ShoppingQuantity } from "../src/types.js";
import { parseIngredientsAgentOutput, parseRecipeCompilation } from "../src/validation.js";

const quantity = (
  value: number,
  unit: string,
  quantityMax: number | null = null,
  approximate = false,
): RecipeIngredientQuantity => ({ quantity: value, quantityMax, unit, approximate });

const chosen = (quantity: number, unit: string, approximate = false): ShoppingQuantity =>
  ({ quantity, unit, approximate });

const amount = (
  raw: string,
  sourceQuantity: RecipeIngredientQuantity | null = null,
  additiveQuantity: ShoppingQuantity = sourceQuantity
    ? chosen(sourceQuantity.quantity, sourceQuantity.unit, sourceQuantity.approximate)
    : chosen(1, "pinch", true),
) => ({ raw, sourceQuantity, additiveQuantity });

const line = (
  sourceText: string,
  name: string,
  overrides: Partial<IngredientsAgentOutput["recipes"][number]["ingredients"][number]> = {},
) => ({
  sourceText,
  name,
  amount: amount(""),
  preparation: null,
  context: null,
  optional: false,
  alternatives: [],
  unresolved: [],
  ...overrides,
});

describe("Ingredients Agent deterministic compiler", () => {
  it("accepts only the minimal model contract", () => {
    const draft = { recipes: [{ sourceName: "recipe.md", ingredients: [line(
      "2–3 limes",
      "lime",
      { amount: amount("2–3 limes", quantity(2, "limes", 3)) },
    )] }] };
    expect(parseIngredientsAgentOutput(JSON.stringify(draft))).toEqual(draft);
    expect(() => parseIngredientsAgentOutput(JSON.stringify({
      ...draft,
      recipes: [{ ...draft.recipes[0], recipeId: "model-id", title: "Model title" }],
      decisionLog: [],
    }))).toThrow(/invalid Ingredients Agent output/i);
  });

  it("sums compatible additive quantities while preserving source quantities", () => {
    const plan = compileRecipeCompilation({ recipes: [
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
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(chosen(8, "clove"));
  });

  it("combines package totals with loose weight", () => {
    const plan = compileRecipeCompilation({ recipes: [
      { sourceName: "bags.md", ingredients: [line("2 (12-ounce) bags frozen peas", "frozen peas", {
        amount: amount("2 (12-ounce) bags", quantity(2, "12 oz bag"), chosen(24, "ounces")),
      })] },
      { sourceName: "loose.md", ingredients: [line("10 ounces frozen peas", "frozen peas", {
        amount: amount("10 ounces", quantity(10, "ounces")),
      })] },
    ] });
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(chosen(34, "oz"));
  });

  it("keeps recipe-specified can sizes in the shopping totals", () => {
    const plan = compileRecipeCompilation({ recipes: [{ sourceName: "dinner.md", ingredients: [
      line("2 × 800 g / 28 oz cans tomatoes", "canned tomatoes", {
        amount: amount("2 × 800 g / 28 oz cans", quantity(2, "800 g / 28 oz can"), chosen(2, "800 g / 28 oz can")),
      }),
      line("3 × 425 g / 15 oz cans beans", "cannellini beans", {
        amount: amount("3 × 425 g / 15 oz cans", quantity(3, "425 g / 15 oz can"), chosen(3, "425 g / 15 oz can")),
      }),
    ] }] });
    const list = recipeCompilationToShoppingList(plan, [{ sourceName: "dinner.md", text: "2 × 800 g / 28 oz cans tomatoes\n3 × 425 g / 15 oz cans beans" }]);
    expect(list.ingredients?.map(({ purchaseRequirement }) => purchaseRequirement?.total)).toEqual([
      chosen(2, "800 g / 28 oz can"), chosen(3, "425 g / 15 oz can"),
    ]);
    expect(() => compileRecipeCompilation({ recipes: [{ sourceName: "dinner.md", ingredients: [
      line("2 × 800 g / 28 oz cans tomatoes", "canned tomatoes", {
        amount: amount("2 × 800 g / 28 oz cans", quantity(2, "can"), chosen(2, "can")),
      }),
    ] }] })).toThrow(/Package size omitted/);
  });

  it("combines source-supported approximate equivalents", () => {
    const plan = compileRecipeCompilation({ recipes: [
      { sourceName: "count.md", ingredients: [line("4 thighs (about 1½ pounds)", "bone-in chicken thighs", {
        amount: amount("4 thighs (about 1½ pounds)", quantity(4, "thighs"), chosen(1.5, "pounds", true)),
      })] },
      { sourceName: "weight.md", ingredients: [line("2 pounds chicken thighs", "bone-in chicken thighs", {
        amount: amount("2 pounds", quantity(2, "pounds")),
      })] },
    ] });
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(chosen(3.5, "lb", true));
  });

  it("preserves source ranges but sums one chosen shopping quantity", () => {
    const plan = compileRecipeCompilation({ recipes: [
      { sourceName: "a.md", ingredients: [line("2–3 limes", "lime", {
        amount: amount("2–3 limes", quantity(2, "limes", 3), chosen(3, "lime")),
      })] },
      { sourceName: "b.md", ingredients: [line("1 lime", "lime", {
        amount: amount("1 lime", quantity(1, "lime")),
      })] },
    ] });
    expect(plan.recipes[0]?.ingredients[0]?.amount.sourceQuantity).toEqual(quantity(2, "limes", 3));
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(chosen(4, "lime"));
  });

  it("buys whole items after summing fractional recipe needs", () => {
    const plan = compileRecipeCompilation({ recipes: [{ sourceName: "dinner.md", ingredients: [
      line("Juice of ½ lemon for chicken", "lemon", { amount: amount("½ lemon", quantity(0.5, "lemon")) }),
      line("Juice of ½ lemon for salad", "lemon", { amount: amount("½ lemon", quantity(0.5, "lemon")) }),
      line("15 g lemon juice", "lemon", { amount: amount("15 g", quantity(15, "g"), chosen(0.5, "lemon", true)) }),
    ] }] });
    const list = recipeCompilationToShoppingList(plan, [{ sourceName: "dinner.md", text: "Juice of ½ lemon for chicken\nJuice of ½ lemon for salad\n15 g lemon juice" }]);
    expect(plan.purchaseIntents[0]?.additiveAmount).toEqual(chosen(1.5, "lemon", true));
    expect(list.ingredients?.[0]?.purchaseRequirement?.total).toEqual(chosen(2, "lemon"));
  });

  it("uses a whole singular item unit for an inferred optional tomato", () => {
    const plan = compileRecipeCompilation({ recipes: [{ sourceName: "dinner.md", ingredients: [
      line("Chopped tomato, optional", "tomato", {
        amount: amount("Chopped tomato", null, chosen(1, "tomatoes", true)), optional: true,
      }),
    ] }] });
    const list = recipeCompilationToShoppingList(plan, [{ sourceName: "dinner.md", text: "Chopped tomato, optional" }]);
    expect(list.ingredients?.[0]?.purchaseRequirement?.total).toEqual(chosen(1, "tomato"));
  });

  it("rejects incompatible chosen units instead of emitting a missing total", () => {
    expect(() => compileRecipeCompilation({ recipes: [
      { sourceName: "a.md", ingredients: [line("mint for serving", "fresh mint")] },
      { sourceName: "b.md", ingredients: [line("½ cup mint", "fresh mint", {
        amount: amount("½ cup", quantity(0.5, "cup")),
      })] },
    ] })).toThrow(/incompatible shopping units/i);
  });

  it("derives intent IDs from source membership rather than model wording", () => {
    const sources = [
      { sourceName: "a.md", ingredients: [line("Crushed red pepper", "crushed red pepper")] },
      { sourceName: "b.md", ingredients: [line("red-pepper flakes", "crushed red pepper")] },
    ];
    const first = compileRecipeCompilation({ recipes: sources });
    const renamed = compileRecipeCompilation({ recipes: sources.map((recipe) => ({
      ...recipe,
      ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient, name: "red pepper flakes" })),
    })) });
    expect(first.purchaseIntents[0]?.id).toBe(renamed.purchaseIntents[0]?.id);
    expect(first.recipes[0]).not.toHaveProperty("recipeId");
    expect(first.recipes[0]?.ingredients[0]).not.toHaveProperty("lineId");
  });

  it("ignores incidental boundary whitespace in source membership IDs", () => {
    const clean = compileRecipeCompilation({ recipes: [
      { sourceName: "a.md", ingredients: [line("2½ cups chicken stock", "chicken broth")] },
    ] });
    const padded = compileRecipeCompilation({ recipes: [
      { sourceName: "a.md", ingredients: [line("  2½ cups chicken stock ", "chicken broth")] },
    ] });
    expect(clean.purchaseIntents[0]?.id).toBe(padded.purchaseIntents[0]?.id);
    expect(padded.recipes[0]?.ingredients[0]?.sourceText).toBe("2½ cups chicken stock");
  });

  it("changes an intent ID when its source membership changes", () => {
    const first = compileRecipeCompilation({ recipes: [{ sourceName: "a.md", ingredients: [line("salt", "salt")] }] });
    const second = compileRecipeCompilation({ recipes: [
      { sourceName: "a.md", ingredients: [line("salt", "salt")] },
      { sourceName: "b.md", ingredients: [line("salt", "salt")] },
    ] });
    expect(first.purchaseIntents[0]?.id).not.toBe(second.purchaseIntents[0]?.id);
  });

  it("includes seasonings, cooking fats, and optional ingredients in the shopping list", () => {
    const plan = compileRecipeCompilation({ recipes: [{ sourceName: "soup.md", ingredients: [
      line("salt", "salt"),
      line("olive oil", "olive oil"),
      line("fresh dill, optional", "fresh dill", { optional: true }),
    ] }] });
    expect(plan.purchaseIntents.map(({ primary }) => primary.name)).toEqual(["salt", "olive oil", "fresh dill"]);
    expect(recipeCompilationToShoppingList(plan, [{ sourceName: "soup.md", text: "salt\nolive oil\nfresh dill, optional" }]).ingredients).toHaveLength(3);
    expect(plan.purchaseIntents[2]?.optional).toBe(true);
    expect(plan.decisionLog).toEqual([]);
  });

  it("gives split components unique source references while retaining the full line", () => {
    const plan = compileRecipeCompilation({ recipes: [{ sourceName: "seasoning.md", ingredients: [
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
    const plan = compileRecipeCompilation({ recipes: [{ sourceName: "soup.md", ingredients: [line("salt", "salt")] }] });
    expect(parseRecipeCompilation(JSON.stringify(plan))).toEqual(plan);
    plan.recipes[0]!.ingredients[0]!.purchaseIntentId = "intent-0000000000000000";
    expect(() => assertRecipeCompilationIntegrity(plan)).toThrow(/invalid source reference|valid purchase intent/);
  });
});

describe("recipe-document compiler seam", () => {
  it("validates exact recipe and line provenance", async () => {
    const documents = [{ sourceName: "one.md", text: "2 apples" }];
    const shoppingList = await compileIngredientsList(documents, async () => ({ recipes: [{
      sourceName: "one.md",
      ingredients: [line("2 apples", "apple", { amount: amount("2 apples", quantity(2, "apples")) })],
    }] }));
    expect(shoppingList.ingredients?.[0]?.request).toBe("apple");
    expect(shoppingList.ingredients?.[0]?.purchaseRequirement).toMatchObject({
      total: chosen(2, "apple"),
      optional: false,
      sources: ["one.md"],
    });
    expect(shoppingList.sourceRecipes).toEqual(documents);
    const task = cartTasks(shoppingList)[0]!;
    expect(task.recipeContext).toEqual([{ name: "one.md", text: "2 apples" }]);
    expect(renderDecisionPrompt({
      task: { ingredientId: task.ingredient.id, requested: task.ingredient.request, purchaseRequirement: task.ingredient.purchaseRequirement },
      recipeContext: task.recipeContext, candidates: [], currentCart: [],
    })).toContain('"text": "2 apples"');

    await expect(compileIngredientsList(documents, async () => ({ recipes: [{
      sourceName: "renamed.md",
      ingredients: [line("2 apples", "apple")],
    }] }))).rejects.toThrow(/sources do not match/);
    await expect(compileIngredientsList(documents, async () => ({ recipes: [{
      sourceName: "one.md",
      ingredients: [line("apples", "apple")],
    }] }))).rejects.toThrow(/complete verbatim line/);
  });

  it("rejects empty recipe input before invoking the agent", async () => {
    let called = false;
    await expect(compileIngredientsList([], async () => {
      called = true;
      throw new Error("should not run");
    })).rejects.toThrow(/at least one recipe document/i);
    expect(called).toBe(false);
  });
});
