import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CartReport, GroceryRequest } from "./types.js";

export interface PromptInput {
  request: GroceryRequest;
  requestSha256: string;
  expectedPostalCode: string;
  previousReport: CartReport | null;
}

const templatePath = fileURLToPath(
  new URL("../prompts/build-cart.md", import.meta.url),
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
  return [
    readFileSync(templatePath, "utf8").trim(),
    `EXPECTED POSTAL CODE: ${input.expectedPostalCode}`,
    `REQUEST SHA-256: ${input.requestSha256}`,
    prior,
    `GROCERY REQUEST:\n${JSON.stringify(input.request, null, 2)}`,
  ].join("\n\n");
}
