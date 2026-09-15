import { createHash } from "node:crypto";
import type {
  DecisionPriority,
  MealPlanDecision,
  MealPlanRecipe,
  PantryDisposition,
  PantryStatus,
  PurchaseIntent,
  PurchaseIntentSource,
  PurchaseIntentSourceRef,
  RecipeIngredientAlternative,
  RecipeIngredientAmount,
  RecipeIngredientLine,
  RecipeIngredientQuantity,
  RecipeIngredientUnresolved,
  ShoppingPlan,
} from "./types.js";

/** The semantic facts the recipe-reading agent must extract. */
export interface RecipeIngredientDraft {
  sourceText: string;
  name: string;
  amount: RecipeIngredientAmount;
  preparation: string | null;
  context: string | null;
  optional: boolean;
  pantryStatus: PantryStatus;
  alternatives: RecipeIngredientAlternative[];
  unresolved: RecipeIngredientUnresolved[];
}

export interface MealPlanRecipeDraft {
  sourceName: string;
  ingredients: RecipeIngredientDraft[];
}

export interface MealPlanDraft {
  recipes: MealPlanRecipeDraft[];
}

export interface MealPlanCompileOptions {
  includeOptional?: boolean;
  assumePantry?: boolean;
}

const DEFAULT_OPTIONS: Required<MealPlanCompileOptions> = {
  includeOptional: false,
  assumePantry: true,
};

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
  teaspoon: "tsp", teaspoons: "tsp",
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

const amountForOutput = (amount: RecipeIngredientAmount): RecipeIngredientAmount => ({
  raw: amount.raw,
  sourceQuantity: amount.sourceQuantity === null ? null : quantityForOutput(amount.sourceQuantity),
  additiveQuantity: amount.additiveQuantity === null ? null : quantityForOutput(amount.additiveQuantity),
});

const combineQuantities = (
  quantities: readonly (RecipeIngredientQuantity | null)[],
): RecipeIngredientQuantity | null => {
  if (quantities.length === 0 || quantities.some((quantity) => quantity === null)) return null;
  const present = quantities as RecipeIngredientQuantity[];
  const units = present.map(({ unit }) => canonicalUnit(unit));
  if (!units.every((unit) => unit === units[0])) return null;
  const quantity = present.reduce((sum, value) => sum + value.quantity, 0);
  const hasRange = present.some(({ quantityMax }) => quantityMax !== null);
  return {
    quantity,
    quantityMax: hasRange
      ? present.reduce((sum, value) => sum + (value.quantityMax ?? value.quantity), 0)
      : null,
    unit: units[0] ?? "",
    approximate: present.some(({ approximate }) => approximate),
  };
};

const lineDisposition = (
  ingredient: RecipeIngredientDraft,
  options: Required<MealPlanCompileOptions>,
): PantryDisposition => {
  if (ingredient.optional && !options.includeOptional) return "omit_optional";
  if (ingredient.pantryStatus === "assume_pantry" && options.assumePantry) return "assume_pantry";
  return "buy";
};

const intentDisposition = (lines: readonly RecipeIngredientLine[]): PantryDisposition => {
  if (lines.some(({ disposition }) => disposition === "buy")) return "buy";
  if (lines.some(({ disposition }) => disposition === "assume_pantry")) return "assume_pantry";
  return "omit_optional";
};

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

const priorityFor = (code: MealPlanDecision["code"]): DecisionPriority => {
  if (code === "unresolved_interpretation" || code === "incompatible_amounts") return "high";
  if (code === "consolidated") return "medium";
  return "low";
};

const decision = (
  code: MealPlanDecision["code"],
  message: string,
  sources: readonly PurchaseIntentSourceRef[],
  purchaseIntentId: string,
): MealPlanDecision => ({
  priority: priorityFor(code),
  code,
  message,
  sources: uniqueSources(sources),
  purchaseIntentId,
});

const formatQuantity = (value: RecipeIngredientQuantity): string => {
  const amount = value.quantityMax === null
    ? `${value.quantity}`
    : `${value.quantity}-${value.quantityMax}`;
  return `${value.approximate ? "about " : ""}${amount} ${canonicalUnit(value.unit)}`;
};

const guidanceFor = (
  name: string,
  buyLines: readonly RecipeIngredientLine[],
  additiveAmount: RecipeIngredientQuantity | null,
): string => {
  if (buyLines.length > 1) {
    return additiveAmount === null
      ? "Buy enough to satisfy each preserved source amount."
      : `Buy enough to satisfy ${formatQuantity(additiveAmount)} of ${name}.`;
  }
  const amount = buyLines[0]?.amount;
  if (amount?.raw) {
    const rawIdentity = normalizedItemKey(amount.raw);
    const nameIdentity = normalizedItemKey(name);
    const alreadyNamesItem = ` ${rawIdentity} `.includes(` ${nameIdentity} `);
    return `Buy enough to satisfy ${amount.raw}${alreadyNamesItem ? "" : ` of ${name}`}.`;
  }
  if (additiveAmount) return `Buy enough to satisfy ${formatQuantity(additiveAmount)} of ${name}.`;
  return `Choose a reasonable package of ${name}.`;
};

interface CompiledLine {
  recipe: MealPlanRecipe;
  line: RecipeIngredientLine;
}

/** Deterministically turn semantic extraction into the cart-facing plan. */
export function compileShoppingPlan(
  draft: MealPlanDraft,
  suppliedOptions: MealPlanCompileOptions = {},
): ShoppingPlan {
  const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
  if (draft.recipes.length === 0) throw new Error("Meal plan must contain at least one recipe");

  const sourceNames = new Set<string>();
  const compiledRecipes: MealPlanRecipe[] = draft.recipes.map((recipe) => {
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
          pantryStatus: ingredient.pantryStatus,
          alternatives: ingredient.alternatives.map((alternative) => ({
            name: compact(alternative.name),
            guidance: compact(alternative.guidance),
          })),
          unresolved: ingredient.unresolved.map(({ priority, message }) => ({
            priority,
            message: compact(message),
          })),
          disposition: lineDisposition(ingredient, options),
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
  const decisions: MealPlanDecision[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const refs = group.map(({ recipe, line }) => sourceRefFor(recipe.sourceName, line));
    const intentId = stableIntentId(refs);
    for (const { line } of group) line.purchaseIntentId = intentId;

    const buyLines = group.map(({ line }) => line).filter(({ disposition }) => disposition === "buy");
    const additiveAmount = combineQuantities(buyLines.map(({ amount }) => amount.additiveQuantity));
    const disposition = intentDisposition(group.map(({ line }) => line));
    const sourceLines: PurchaseIntentSource[] = group.map(({ recipe, line }) => ({
      ...sourceRefFor(recipe.sourceName, line),
      context: line.context,
      disposition: line.disposition,
    }));
    const alternatives = [
      ...new Set(group.flatMap(({ line }) => line.alternatives.map((value) => JSON.stringify(value)))),
    ].map((value) => JSON.parse(value) as RecipeIngredientAlternative);

    purchaseIntents.push({
      id: intentId,
      primary: {
        name: first.line.name,
        guidance: disposition === "buy"
          ? guidanceFor(first.line.name, buyLines, additiveAmount)
          : disposition === "assume_pantry"
            ? "No purchase; assumed to be in the pantry."
            : "No purchase; optional ingredient omitted by policy.",
      },
      alternatives,
      sourceLines,
      sourceAmounts: group.map(({ line }) => amountForOutput(line.amount)),
      additiveAmount,
      optional: group.every(({ line }) => line.optional),
      disposition,
    });

    if (group.length > 1) {
      decisions.push(decision("consolidated", `Combined ${group.length} recipe mentions of ${first.line.name}.`, refs, intentId));
    }
    if (buyLines.length > 1 && additiveAmount === null) {
      const buyRefs = group
        .filter(({ line }) => line.disposition === "buy")
        .map(({ recipe, line }) => sourceRefFor(recipe.sourceName, line));
      decisions.push(decision("incompatible_amounts", `Preserved separate source amounts for ${first.line.name}.`, buyRefs, intentId));
    }
    const pantryGroup = group.filter(({ line }) => line.disposition === "assume_pantry");
    if (pantryGroup.length > 0) {
      decisions.push(decision(
        "pantry_assumption",
        `Assumed ${first.line.name} is already in the pantry.`,
        pantryGroup.map(({ recipe, line }) => sourceRefFor(recipe.sourceName, line)),
        intentId,
      ));
    }
    const optionalGroup = group.filter(({ line }) => line.disposition === "omit_optional");
    if (optionalGroup.length > 0) {
      decisions.push(decision(
        "optional_omitted",
        `Omitted optional ${first.line.name}.`,
        optionalGroup.map(({ recipe, line }) => sourceRefFor(recipe.sourceName, line)),
        intentId,
      ));
    }
    const uncertainPantryGroup = group.filter(
      ({ line }) => line.pantryStatus === "uncertain" && line.disposition === "buy",
    );
    if (uncertainPantryGroup.length > 0) {
      decisions.push({
        ...decision(
          "unresolved_interpretation",
          `Pantry status for ${first.line.name} is uncertain; kept it on the buy list.`,
          uncertainPantryGroup.map(({ recipe, line }) => sourceRefFor(recipe.sourceName, line)),
          intentId,
        ),
        priority: "high",
      });
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

  const plan: ShoppingPlan = {
    contractVersion: 3,
    recipes: compiledRecipes,
    purchaseIntents,
    decisionLog: decisions,
  };
  assertShoppingPlanIntegrity(plan);
  return plan;
}

/** Validate cross-reference invariants that JSON Schema cannot express. */
export function assertShoppingPlanIntegrity(plan: ShoppingPlan): void {
  if (plan.contractVersion !== 3) throw new Error(`Unsupported shopping-plan contract version: ${plan.contractVersion}`);
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
          line.disposition !== source.disposition || line.purchaseIntentId !== intent.id) {
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
