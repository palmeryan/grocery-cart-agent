import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { ReasoningEffort } from "./codex.js";
import type { CartItemSnapshot } from "./types.js";

export const DECISION_MODEL = "gpt-5.6-terra" as const;
export const DECISION_REASONING_EFFORT = "medium" satisfies ReasoningEffort;

export interface DecisionTask {
  ingredientId: string;
  requested: string;
  preferences?: readonly string[];
  context?: string | null;
}

export interface DecisionCandidate {
  id: string;
  productName: string;
  packageSize: string | null;
  price: string | null;
  available: boolean | null;
  text: string;
}

export type CartDecision =
  | { action: "select"; candidateId: string; quantity: number; option: string | null; reason: string | null }
  | { action: "search_again"; query: string }
  | { action: "already_present"; cartProductId: string }
  | { action: "skip"; reason: string };

export interface DecisionPromptInput {
  task: DecisionTask;
  recipeContext?: readonly { id: string; name: string; servings: number; context: string }[];
  candidates: readonly DecisionCandidate[];
  currentCart: readonly CartItemSnapshot[];
}

export interface DecisionInvocationInput {
  rootDir: string;
  outputPath: string;
  schemaPath: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface DecisionInvocation { args: string[] }

const template = readFileSync(fileURLToPath(new URL("../prompts/cart-decision.md", import.meta.url)), "utf8").trim();
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/cart-decision.schema.json", import.meta.url)), "utf8")) as object;
const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

const errors = (items: ErrorObject[] | null | undefined): string =>
  (items ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`).join("; ");

export function renderDecisionPrompt(input: DecisionPromptInput): string {
  return [template, "BEGIN STOREFRONT OBSERVATION", JSON.stringify(input, null, 2), "END STOREFRONT OBSERVATION"].join("\n\n");
}

export function parseDecision(text: string): CartDecision {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid cart decision: response is not JSON"); }
  if (!validator(value)) throw new Error(`Invalid cart decision: ${errors(validator.errors)}`);
  const decision = value as Record<string, unknown>;
  if (decision.action === "select" && typeof decision.candidateId === "string" && Number.isSafeInteger(decision.quantity) && (decision.quantity as number) > 0 && (typeof decision.option === "string" || decision.option === null) && (typeof decision.reason === "string" || decision.reason === null) && decision.query === null && decision.cartProductId === null) return decision as unknown as CartDecision;
  if (decision.action === "search_again" && typeof decision.query === "string" && decision.candidateId === null && decision.quantity === 0 && decision.option === null && decision.cartProductId === null && decision.reason === null) return decision as unknown as CartDecision;
  if (decision.action === "already_present" && typeof decision.cartProductId === "string" && decision.candidateId === null && decision.quantity === 0 && decision.option === null && decision.query === null && decision.reason === null) return decision as unknown as CartDecision;
  if (decision.action === "skip" && typeof decision.reason === "string" && decision.candidateId === null && decision.quantity === 0 && decision.option === null && decision.query === null && decision.cartProductId === null) return decision as unknown as CartDecision;
  throw new Error("Invalid cart decision: action fields");
}

export function validateDecision(
  decision: CartDecision,
  candidates: readonly DecisionCandidate[],
  currentCart: readonly CartItemSnapshot[],
): CartDecision {
  if (decision.action === "select") {
    const candidate = candidates.find(({ id }) => id === decision.candidateId);
    if (!candidate) throw new Error(`Cart decision selected stale candidate ID: ${decision.candidateId}`);
    if (!candidate.available) throw new Error(`Cart decision selected unavailable candidate: ${decision.candidateId}`);
    if (!Number.isSafeInteger(decision.quantity) || decision.quantity < 1) throw new Error("Cart decision quantity must be a positive safe integer");
  } else if (decision.action === "already_present") {
    if (!currentCart.some((item) => item.productId === decision.cartProductId)) {
      throw new Error(`Cart decision referenced missing cart product ID: ${decision.cartProductId}`);
    }
  }
  return decision;
}

export function parseAndValidateDecision(
  text: string,
  candidates: readonly DecisionCandidate[],
  currentCart: readonly CartItemSnapshot[],
): CartDecision { return validateDecision(parseDecision(text), candidates, currentCart); }

export function buildDecisionInvocation(input: DecisionInvocationInput): DecisionInvocation {
  return { args: ["exec", "--model", input.model ?? DECISION_MODEL, "-c", `model_reasoning_effort="${input.reasoningEffort ?? DECISION_REASONING_EFFORT}"`, "--ignore-user-config", "--strict-config", "--ephemeral", "--sandbox", "read-only", "--json", "--output-schema", input.schemaPath, "--output-last-message", input.outputPath, "--cd", input.rootDir, "-c", 'approval_policy="never"', "-"] };
}
