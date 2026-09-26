import { createHash } from "node:crypto";
import type {
  DecisionPriority,
  CompilationDecision,
  CompiledRecipe,
  PurchaseIntent,
  PurchaseIntentSource,
  PurchaseIntentSourceRef,
  RecipeIngredientAlternative,
  RecipeIngredientAmount,
  RecipeIngredientLine,
  RecipeIngredientQuantity,
  RecipeIngredientUnresolved,
  RecipeCompilation,
  ShoppingQuantity,
  ShoppingList,
} from "./types.js";

/** The semantic facts the recipe-reading agent must extract. */
export interface RecipeIngredientDraft {
  sourceText: string;
  name: string;
  amount: RecipeIngredientAmount;
  preparation: string | null;
  context: string | null;
  optional: boolean;
  alternatives: RecipeIngredientAlternative[];
  unresolved: RecipeIngredientUnresolved[];
}

export interface IngredientsAgentRecipe {
  sourceName: string;
  ingredients: RecipeIngredientDraft[];
}

export interface IngredientsAgentOutput {
  recipes: IngredientsAgentRecipe[];
}

const compact = (value: string): string => value.replace(/\s+/g, " ").trim();
const keyOf = (value: string): string => compact(value).normalize("NFKC").toLocaleLowerCase();

const normalizedItemKey = (value: string): string => {
  const words = keyOf(value).replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  const last = words.at(-1);
  if (last?.endsWith("ies") && last.length > 4) words[words.length - 1] = `${last.slice(0, -3)}y`;
  else if (last?.endsWith("s") && !last.endsWith("ss") && last.length > 3) words[words.length - 1] = last.slice(0, -1);
  return words.join(" ");
};

const unitAliases: Record<string, string> = {
  clove: "clove", cloves: "clove", ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", tablespoon: "tbsp", tablespoons: "tbsp",
  teaspoon: "tsp", teaspoons: "tsp", tomatoes: "tomato",
};

const canonicalUnit = (unit: string): string => {
  const normalized = keyOf(unit);
  return unitAliases[normalized] ?? normalizedItemKey(normalized);
};

const quantityForOutput = (quantity: RecipeIngredientQuantity): RecipeIngredientQuantity => {
  if (quantity.quantity <= 0) throw new Error("Ingredient quantities must be positive");
  if (quantity.quantityMax !== null && quantity.quantityMax < quantity.quantity) {
    throw new Error("Ingredient quantity range has an upper bound below its lower bound");
  }
  return {
    quantity: quantity.quantity,
    quantityMax: quantity.quantityMax,
    unit: compact(quantity.unit),
    approximate: quantity.approximate,
  };
};

const exactQuantityForOutput = (quantity: ShoppingQuantity): ShoppingQuantity => {
  if (quantity.quantity <= 0) throw new Error("Shopping quantities must be positive");
  return { quantity: quantity.quantity, unit: compact(quantity.unit), approximate: quantity.approximate };
};

const amountForOutput = (amount: RecipeIngredientAmount): RecipeIngredientAmount => {
  const sizedPackage = /\b\d+(?:\.\d+)?\s*-?\s*(?:g|kg|oz|ounces?|lb|pounds?)\b/i.test(amount.raw) &&
    /\b(?:cans?|bags?|jars?|bottles?|cartons?|boxes?)\b/i.test(amount.raw);
  const genericPackage = /^(?:cans?|bags?|jars?|bottles?|cartons?|boxes?)$/i;
  if (sizedPackage && (!amount.sourceQuantity || genericPackage.test(amount.sourceQuantity.unit) ||
      genericPackage.test(amount.additiveQuantity.unit))) {
    throw new Error(`Package size omitted from ingredient quantity: ${amount.raw}`);
  }
  return {
    raw: amount.raw,
    sourceQuantity: amount.sourceQuantity === null ? null : quantityForOutput(amount.sourceQuantity),
    additiveQuantity: exactQuantityForOutput(amount.additiveQuantity),
  };
};

const combineQuantities = (
  quantities: readonly ShoppingQuantity[],
): ShoppingQuantity => {
  if (quantities.length === 0) throw new Error("Shopping quantity is missing");
  const units = quantities.map(({ unit }) => canonicalUnit(unit));
  if (!units.every((unit) => unit === units[0])) throw new Error(`Incompatible shopping units: ${units.join(", ")}`);
  return {
    quantity: quantities.reduce((sum, value) => sum + value.quantity, 0),
    unit: /\d/.test(quantities[0]?.unit ?? "") ? compact(quantities[0]!.unit) : units[0] ?? "",
    approximate: quantities.some(({ approximate }) => approximate),
  };
};

const purchaseQuantity = (total: ShoppingQuantity): ShoppingQuantity =>
  new Set(["lemon", "clove", "onion", "pita", "tomato", "cucumber", "can", "package", "bunch", "loaf", "bulb"])
    .has(total.unit.split(" ").at(-1) ?? "")
    ? { ...total, quantity: Math.ceil(total.quantity), approximate: false }
    : total;

const sourceRefFor = (
  sourceName: string,
  line: RecipeIngredientLine,
): PurchaseIntentSourceRef => ({
  sourceName,
  sourceText: line.sourceText,
  sourceOccurrence: line.sourceOccurrence,
  componentIndex: line.componentIndex,
});

const sourceRefKey = (source: PurchaseIntentSourceRef): string =>
  JSON.stringify([
    source.sourceName,
    source.sourceText,
    source.sourceOccurrence,
    source.componentIndex,
  ]);

const stableIntentId = (sources: readonly PurchaseIntentSourceRef[]): string => {
  const membership = sources.map(sourceRefKey).sort().join("\n");
  return `intent-${createHash("sha256").update(membership).digest("hex").slice(0, 16)}`;
};

const uniqueSources = (sources: readonly PurchaseIntentSourceRef[]): PurchaseIntentSourceRef[] => {
  const byKey = new Map(sources.map((source) => [sourceRefKey(source), source]));
  return [...byKey.values()];
};

const priorityFor = (code: CompilationDecision["code"]): DecisionPriority => {
  if (code === "unresolved_interpretation") return "high";
  if (code === "consolidated") return "medium";
  return "low";
};

const decision = (
  code: CompilationDecision["code"],
  message: string,
  sources: readonly PurchaseIntentSourceRef[],
  purchaseIntentId: string,
): CompilationDecision => ({
  priority: priorityFor(code),
  code,
  message,
  sources: uniqueSources(sources),
  purchaseIntentId,
});

interface CompiledLine {
  recipe: CompiledRecipe;
  line: RecipeIngredientLine;
}

/** Deterministically turn semantic extraction into the cart-facing plan. */
export function compileRecipeCompilation(
  draft: IngredientsAgentOutput,
): RecipeCompilation {
  if (draft.recipes.length === 0) throw new Error("Meal plan must contain at least one recipe");

  const sourceNames = new Set<string>();
  const compiledRecipes: CompiledRecipe[] = draft.recipes.map((recipe) => {
    if (!recipe.sourceName.trim()) throw new Error("Recipe has no source name");
    if (sourceNames.has(recipe.sourceName)) throw new Error(`Duplicate recipe source: ${recipe.sourceName}`);
    sourceNames.add(recipe.sourceName);
    if (recipe.ingredients.length === 0) throw new Error(`Recipe ${recipe.sourceName} has no ingredients`);

    const occurrenceByText = new Map<string, number>();
    let previousText: string | undefined;
    let sourceOccurrence = 0;
    let componentIndex = 0;
    return {
      sourceName: recipe.sourceName,
      ingredients: recipe.ingredients.map((ingredient) => {
        const sourceText = ingredient.sourceText.trim();
        if (sourceText !== previousText) {
          sourceOccurrence = (occurrenceByText.get(sourceText) ?? 0) + 1;
          occurrenceByText.set(sourceText, sourceOccurrence);
          componentIndex = 1;
          previousText = sourceText;
        } else {
          componentIndex += 1;
        }
        return {
          sourceText,
          sourceOccurrence,
          componentIndex,
          name: compact(ingredient.name),
          amount: amountForOutput(ingredient.amount),
          preparation: ingredient.preparation === null ? null : compact(ingredient.preparation),
          context: ingredient.context === null ? null : compact(ingredient.context),
          optional: ingredient.optional,
          alternatives: ingredient.alternatives.map((alternative) => ({
            name: compact(alternative.name),
            guidance: compact(alternative.guidance),
          })),
          unresolved: ingredient.unresolved.map(({ priority, message }) => ({
            priority,
            message: compact(message),
          })),
          purchaseIntentId: "pending",
        };
      }),
    };
  });

  const groups = new Map<string, CompiledLine[]>();
  for (const recipe of compiledRecipes) {
    for (const line of recipe.ingredients) {
      const key = normalizedItemKey(line.name);
      const group = groups.get(key) ?? [];
      group.push({ recipe, line });
      groups.set(key, group);
    }
  }

  const purchaseIntents: PurchaseIntent[] = [];
  const decisions: CompilationDecision[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const refs = group.map(({ recipe, line }) => sourceRefFor(recipe.sourceName, line));
    const intentId = stableIntentId(refs);
    for (const { line } of group) line.purchaseIntentId = intentId;

    const buyLines = group.map(({ line }) => line);
    const additiveAmount = combineQuantities(buyLines.map(({ amount }) => amount.additiveQuantity));
    const sourceLines: PurchaseIntentSource[] = group.map(({ recipe, line }) => ({
      ...sourceRefFor(recipe.sourceName, line),
      context: line.context,
    }));
    const alternatives = [
      ...new Set(group.flatMap(({ line }) => line.alternatives.map((value) => JSON.stringify(value)))),
    ].map((value) => JSON.parse(value) as RecipeIngredientAlternative);

    purchaseIntents.push({
      id: intentId,
      primary: { name: first.line.name },
      alternatives,
      sourceLines,
      sourceAmounts: group.map(({ line }) => amountForOutput(line.amount)),
      additiveAmount,
      optional: group.every(({ line }) => line.optional),
    });

    if (group.length > 1) {
      decisions.push(decision("consolidated", `Combined ${group.length} recipe mentions of ${first.line.name}.`, refs, intentId));
    }
    for (const { recipe, line } of group) {
      for (const entry of line.unresolved) {
        decisions.push({
          ...decision("unresolved_interpretation", entry.message, [sourceRefFor(recipe.sourceName, line)], intentId),
          priority: entry.priority,
        });
      }
    }
  }

  const plan: RecipeCompilation = {
    contractVersion: 6,
    recipes: compiledRecipes,
    purchaseIntents,
    decisionLog: decisions,
  };
  assertRecipeCompilationIntegrity(plan);
  return plan;
}

/** Validate cross-reference invariants that JSON Schema cannot express. */
export function assertRecipeCompilationIntegrity(plan: RecipeCompilation): void {
  if (plan.contractVersion !== 6) throw new Error(`Unsupported recipe-compilation contract version: ${plan.contractVersion}`);
  const sourceNames = new Set<string>();
  const lines = new Map<string, RecipeIngredientLine>();
  for (const recipe of plan.recipes) {
    if (sourceNames.has(recipe.sourceName)) throw new Error(`Duplicate recipe source: ${recipe.sourceName}`);
    sourceNames.add(recipe.sourceName);
    for (const line of recipe.ingredients) {
      const key = sourceRefKey(sourceRefFor(recipe.sourceName, line));
      if (lines.has(key)) throw new Error(`Duplicate ingredient source reference: ${key}`);
      lines.set(key, line);
    }
  }

  const intents = new Map<string, PurchaseIntent>();
  for (const intent of plan.purchaseIntents) {
    if (intents.has(intent.id)) throw new Error(`Duplicate purchase intent ID: ${intent.id}`);
    intents.set(intent.id, intent);
    if (intent.sourceLines.length === 0) throw new Error(`Purchase intent ${intent.id} has no source lines`);
    if (intent.id !== stableIntentId(intent.sourceLines)) throw new Error(`Purchase intent ${intent.id} has an unstable ID`);
    for (const source of intent.sourceLines) {
      const line = lines.get(sourceRefKey(source));
      if (!line || line.sourceText !== source.sourceText || line.context !== source.context ||
          line.purchaseIntentId !== intent.id) {
        throw new Error(`Purchase intent ${intent.id} has an invalid source reference`);
      }
    }
  }
  for (const line of lines.values()) {
    if (!intents.has(line.purchaseIntentId)) throw new Error("Ingredient line has no valid purchase intent");
  }
  for (const entry of plan.decisionLog) {
    const intent = intents.get(entry.purchaseIntentId);
    if (!intent) throw new Error(`Decision references unknown purchase intent: ${entry.purchaseIntentId}`);
    const intentRefs = new Set(intent.sourceLines.map(sourceRefKey));
    if (entry.sources.some((source) => !lines.has(sourceRefKey(source)) || !intentRefs.has(sourceRefKey(source)))) {
      throw new Error("Decision references an unknown or unrelated ingredient source");
    }
  }
}

const compactContext = (values: readonly (string | null)[]): string | undefined => {
  const unique = [...new Set(values.filter((value): value is string => value !== null && value.trim().length > 0))];
  return unique.length > 0 ? unique.join(" ") : undefined;
};

/** Convert source-preserving recipe compilation into the cart harness input. */
export function recipeCompilationToShoppingList(
  compilation: RecipeCompilation,
  sourceRecipes: readonly { sourceName: string; text: string }[],
): ShoppingList {
  assertRecipeCompilationIntegrity(compilation);
  if (JSON.stringify(sourceRecipes.map(({ sourceName }) => sourceName).sort()) !==
      JSON.stringify(compilation.recipes.map(({ sourceName }) => sourceName).sort())) {
    throw new Error("Shopping list source recipes do not match the compilation");
  }
  const ingredients = compilation.purchaseIntents
    .map((intent) => {
      const context = compactContext(intent.sourceLines.map(({ context }) => context));
      return {
        id: intent.id,
        request: intent.primary.name,
        purchaseRequirement: {
          total: purchaseQuantity(intent.additiveAmount),
          optional: intent.optional,
          alternatives: intent.alternatives,
          sources: [...new Set(intent.sourceLines.map(({ sourceName }) => sourceName))],
        },
        ...(context ? { context } : {}),
      };
    });
  if (ingredients.length === 0) {
    throw new Error("Ingredients Agent produced no items for the shopping list");
  }
  return {
    sourceRecipes: sourceRecipes.map(({ sourceName, text }) => ({ sourceName, text })),
    ingredients,
  };
}
