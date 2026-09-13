import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CartReport, GroceryRequest } from "./types.js";

export interface PromptInput {
  request: GroceryRequest;
  requestSha256: string;
  expectedPostalCode: string;
  previousReport: CartReport | null;
  /** Absolute path for Playwright MCP artifacts (screenshots/traces). */
  browserOutputDir: string;
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
  const finalScreenshotPath = `${input.browserOutputDir}/final-state.png`;
  return [
    readFileSync(templatePath, "utf8").trim(),
    `EXPECTED POSTAL CODE: ${input.expectedPostalCode}`,
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
