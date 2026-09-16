import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IngredientsAgentOutput as IngredientsAgentResult } from "./shopping-list-compiler.js";

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

const ingredientsAgentTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/ingredients-agent.md", import.meta.url)),
  "utf8",
);

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
