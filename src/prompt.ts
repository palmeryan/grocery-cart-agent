import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  CartAgentResult,
  CartItemSnapshot,
  CartReport,
  ShoppingList,
} from "./types.js";
import type { CartAgentTask } from "./cart-agent.js";
import type { IngredientsAgentOutput as IngredientsAgentResult } from "./shopping-list-compiler.js";

export interface PromptInput {
  request: ShoppingList;
  requestSha256: string;
  deliveryMode: "delivery";
  previousReport: CartReport | null;
  /** Absolute path for Playwright MCP artifacts (screenshots/traces). */
  browserOutputDir: string;
}

export interface CartAgentPromptInput {
  task: CartAgentTask;
  deliveryMode: "delivery";
  cartContext: {
    baselineItems: readonly CartItemSnapshot[];
    priorResults: readonly CartAgentResult[];
  };
  browserOutputDir: string;
}

export interface IngredientsAgentPromptInput {
  recipeDocuments: readonly {
    sourceName: string;
    text: string;
  }[];
}

const templatePath = fileURLToPath(
  new URL("../prompts/legacy-whole-run-cart-agent.md", import.meta.url),
);

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

export function renderPrompt(input: PromptInput): string {
  const prior =
    input.previousReport === null
      ? "No prior matching report exists."
      : `PREVIOUS REPORT FOR CONTROLLED RERUN:\n${JSON.stringify(
          input.previousReport,
          null,
          2,
        )}`;
  const finalScreenshotPath = `${input.browserOutputDir}/final-state.png`;
  return [
    readFileSync(templatePath, "utf8").trim(),
    `DELIVERY MODE: ${input.deliveryMode}`,
    `REQUEST SHA-256: ${input.requestSha256}`,
    [
      `BROWSER OUTPUT DIRECTORY: ${input.browserOutputDir}`,
      `FINAL SCREENSHOT PATH: ${finalScreenshotPath}`,
      "When capturing the final screenshot, call browser_take_screenshot with",
      `filename set to the absolute path ${finalScreenshotPath}.`,
      "Do not use a relative filename such as final-state.png.",
    ].join("\n"),
    prior,
    `GROCERY REQUEST:\n${JSON.stringify(input.request, null, 2)}`,
  ].join("\n\n");
}

export function renderCartAgentPrompt(input: CartAgentPromptInput): string {
  return [
    cartAgentTemplate.trim(),
    `DELIVERY MODE: ${input.deliveryMode}`,
    `BROWSER OUTPUT DIRECTORY: ${input.browserOutputDir}`,
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
