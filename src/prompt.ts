import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  CartAgentResult,
  CartItemSnapshot,
} from "./types.js";
import type { CartAgentTask } from "./cart-agent.js";
import type { IngredientsAgentOutput as IngredientsAgentResult } from "./shopping-list-compiler.js";

export interface CartAgentPromptInput {
  task: CartAgentTask;
  cartContext: {
    baselineItems: readonly CartItemSnapshot[];
    priorResults: readonly CartAgentResult[];
  };
}

export interface IngredientsAgentPromptInput {
  recipeDocuments: readonly {
    sourceName: string;
    text: string;
  }[];
}

const attachmentTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/attachment-check.md", import.meta.url)),
  "utf8",
);

const cartAgentTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/cart-agent.md", import.meta.url)),
  "utf8",
);

const ingredientsAgentTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/ingredients-agent.md", import.meta.url)),
  "utf8",
);

export function renderCartAgentPrompt(input: CartAgentPromptInput): string {
  return [
    cartAgentTemplate.trim(),
    "CART AGENT TASK:",
    JSON.stringify(input.task, null, 2),
    "CART CONTEXT:",
    JSON.stringify(input.cartContext, null, 2),
  ].join("\n\n");
}

export function renderIngredientsAgentPrompt(
  input: IngredientsAgentPromptInput,
): string {
  const documents = input.recipeDocuments.map(({ sourceName, text }) =>
    [
      `RECIPE SOURCE: ${sourceName}`,
      "BEGIN RECIPE SOURCE",
      text,
      "END RECIPE SOURCE",
    ].join("\n"),
  );
  return [ingredientsAgentTemplate.trim(), ...documents].join("\n\n");
}

/** Compile-time-only assertion for callers that deserialize Ingredients Agent output. */
export type IngredientsAgentOutput = IngredientsAgentResult;

export function renderAttachmentPrompt(): string {
  return `${attachmentTemplate.trim()}\n`;
}
