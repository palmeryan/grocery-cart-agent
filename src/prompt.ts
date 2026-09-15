import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CartItemSnapshot,
  CartReport,
  GroceryRequest,
  IngredientResult,
} from "./types.js";
import type { IngredientTask } from "./ingredient-runner.js";
import type { MealPlanDraft } from "./meal-plan.js";

export interface PromptInput {
  request: GroceryRequest;
  requestSha256: string;
  deliveryMode: "delivery";
  previousReport: CartReport | null;
  /** Absolute path for Playwright MCP artifacts (screenshots/traces). */
  browserOutputDir: string;
}

export interface AuthPromptInput {
  deliveryMode: "delivery";
  browserOutputDir: string;
}

export interface IngredientPromptInput {
  task: IngredientTask;
  deliveryMode: "delivery";
  cartContext: {
    baselineItems: readonly CartItemSnapshot[];
    priorResults: readonly IngredientResult[];
  };
  browserOutputDir: string;
}

export interface MealPlanCompilerPromptInput {
  recipeDocuments: readonly {
    sourceName: string;
    text: string;
  }[];
}

const templatePath = fileURLToPath(
  new URL("../prompts/build-cart.md", import.meta.url),
);

const authTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/auth-check.md", import.meta.url)),
  "utf8",
);

const attachmentTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/attachment-check.md", import.meta.url)),
  "utf8",
);

const ingredientTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/ingredient-agent.md", import.meta.url)),
  "utf8",
);

const mealPlanCompilerTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/meal-plan-compiler.md", import.meta.url)),
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
    // Delimited run config — not grocery request content.
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

export function renderIngredientPrompt(
  input: IngredientPromptInput,
): string {
  return [
    ingredientTemplate.trim(),
    `DELIVERY MODE: ${input.deliveryMode}`,
    `BROWSER OUTPUT DIRECTORY: ${input.browserOutputDir}`,
    "INGREDIENT TASK:",
    JSON.stringify(input.task, null, 2),
    "CART CONTEXT:",
    JSON.stringify(input.cartContext, null, 2),
  ].join("\n\n");
}

export function renderMealPlanCompilerPrompt(
  input: MealPlanCompilerPromptInput,
): string {
  const documents = input.recipeDocuments.map(({ sourceName, text }) =>
    [
      `RECIPE SOURCE: ${sourceName}`,
      "BEGIN RECIPE SOURCE",
      text,
      "END RECIPE SOURCE",
    ].join("\n"),
  );
  return [mealPlanCompilerTemplate.trim(), ...documents].join("\n\n");
}

/** Compile-time-only assertion for callers that deserialize planner output. */
export type MealPlanCompilerOutput = MealPlanDraft;

export function renderAuthPrompt(input: AuthPromptInput): string {
  return [
    authTemplate.trim(),
    "",
    `DELIVERY MODE: ${input.deliveryMode}`,
    `BROWSER OUTPUT DIRECTORY: ${input.browserOutputDir}`,
    `AUTH SCREENSHOT PATH: ${join(input.browserOutputDir, "auth-state.png")}`,
    "",
  ].join("\n");
}

export function renderAttachmentPrompt(): string {
  return `${attachmentTemplate.trim()}\n`;
}
