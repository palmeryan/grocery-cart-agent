import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { buildRestrictedCodexInvocation, type CodexInvocation, type ReasoningEffort } from "./codex.js";
import type { GroceryIngredient, ShoppingQuantity } from "./types.js";
import type { QuantityOption } from "./wfm-page.js";

export const DECISION_MODEL = "gpt-6.1-terra" as const;
export const DECISION_REASONING_EFFORT = "medium" satisfies ReasoningEffort;

export interface DecisionTask {
  ingredientId: string;
  requested: string;
  preferences?: readonly string[];
  context?: string | null;
  purchaseRequirement?: GroceryIngredient["purchaseRequirement"];
}

export interface DecisionCandidate {
  id: string;
  productName: string;
  packageSize: string | null;
  price: string | null;
  available: boolean | null;
  text: string;
  description?: string | null;
}

export type CartDecision =
  | { action: "select"; candidateId: string; quantity: number; option: string | null; reason: string | null }
  | { action: "search_again"; query: string }
  | { action: "skip"; reason: string };

export interface DecisionPromptInput {
  task: DecisionTask;
  recipeContext?: readonly { id?: string; name: string; context?: string; text?: string }[];
  candidates: readonly DecisionCandidate[];
  quantityOptions?: readonly QuantityOption[];
  selectedPackSize?: string | null;
}

export interface DecisionInvocationInput {
  rootDir: string;
  workDir?: string;
  outputPath: string;
  schemaPath: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export type DecisionInvocation = CodexInvocation;

const template = readFileSync(fileURLToPath(new URL("../prompts/cart-decision.md", import.meta.url)), "utf8").trim();
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/cart-decision.schema.json", import.meta.url)), "utf8")) as object;
const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

const errors = (items: ErrorObject[] | null | undefined): string =>
  (items ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`).join("; ");

export function renderDecisionPrompt(input: DecisionPromptInput): string {
  return [
    template,
    ...(input.quantityOptions ? [
      "The selected product opened a weighted-item quantity chooser. Reconsider quantity using the listed estimated weights and the ingredient request. Return select with the same candidate ID and a quantity exactly matching one listed option; the earlier quantity was chosen before these options were visible. Do not claim the item is already in the cart.",
    ] : []),
    "BEGIN STOREFRONT OBSERVATION",
    JSON.stringify(input, null, 2),
    "END STOREFRONT OBSERVATION",
  ].join("\n\n");
}

export function quantityFromSelectedPackSize(
  total: ShoppingQuantity | undefined,
  selectedPackSize: string | null,
  options: readonly QuantityOption[],
): number | null {
  if (!total || !selectedPackSize) return null;
  const pack = /^(\d+(?:\.\d+)?)\s*(Pounds?|lbs?|Ounces?|oz|kg|g)\b/i.exec(selectedPackSize);
  if (!pack) return null;
  const grams = (quantity: number, unit: string): number | null => {
    const factor = { kg: 1000, g: 1, lb: 453.59237, pound: 453.59237, oz: 28.349523125, ounce: 28.349523125 }[unit.toLowerCase().replace(/s$/, "")];
    return factor ? quantity * factor : null;
  };
  const required = grams(total.quantity, total.unit);
  const perPack = grams(Number(pack[1]), pack[2]!);
  if (!required || !perPack) return null;
  const listedCounts = options.map((option) => option.quantity).filter((quantity) => Number.isSafeInteger(quantity) && quantity > 0);
  if (!listedCounts.length) return null;
  const withinTolerance = listedCounts
    .map((quantity) => ({ quantity, ratio: quantity * perPack / required }))
    .filter(({ ratio }) => ratio >= 0.85 && ratio <= 1.15)
    .sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1) || a.quantity - b.quantity);
  if (withinTolerance.length) return withinTolerance[0]!.quantity;
  return listedCounts.filter((quantity) => quantity * perPack >= required).sort((a, b) => a - b)[0] ?? null;
}

export function parseDecision(text: string): CartDecision {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid cart decision: response is not JSON"); }
  if (!validator(value)) throw new Error(`Invalid cart decision: ${errors(validator.errors)}`);
  const decision = value as Record<string, unknown>;
  if (decision.action === "select" && typeof decision.candidateId === "string" && Number.isSafeInteger(decision.quantity) && (decision.quantity as number) > 0 && (typeof decision.option === "string" || decision.option === null) && (typeof decision.reason === "string" || decision.reason === null)) {
    return { action: "select", candidateId: decision.candidateId, quantity: decision.quantity as number, option: decision.option, reason: decision.reason } as CartDecision;
  }
  if (decision.action === "search_again" && typeof decision.query === "string" && decision.query.trim()) {
    return { action: "search_again", query: decision.query };
  }
  if (decision.action === "skip" && typeof decision.reason === "string") {
    return { action: "skip", reason: decision.reason };
  }
  throw new Error("Invalid cart decision: action fields");
}

export function validateDecision(
  decision: CartDecision,
  candidates: readonly DecisionCandidate[],
): CartDecision {
  if (decision.action === "select") {
    const candidate = candidates.find(({ id }) => id.toUpperCase() === decision.candidateId.toUpperCase());
    if (!candidate) throw new Error(`Cart decision selected stale candidate ID: ${decision.candidateId}`);
    if (!candidate.available) throw new Error(`Cart decision selected unavailable candidate: ${decision.candidateId}`);
    if (!Number.isSafeInteger(decision.quantity) || decision.quantity < 1) throw new Error("Cart decision quantity must be a positive safe integer");
  }
  return decision;
}

export function parseAndValidateDecision(
  text: string,
  candidates: readonly DecisionCandidate[],
): CartDecision { return validateDecision(parseDecision(text), candidates); }

export function buildDecisionInvocation(input: DecisionInvocationInput): DecisionInvocation {
  return buildRestrictedCodexInvocation({
    ...input, model: input.model ?? DECISION_MODEL,
    reasoningEffort: input.reasoningEffort ?? DECISION_REASONING_EFFORT,
  });
}
