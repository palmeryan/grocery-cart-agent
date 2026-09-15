import { readFileSync } from "node:fs";
import {
  compileShoppingPlan,
  type MealPlanCompileOptions,
  type MealPlanDraft,
} from "./meal-plan.js";
import { renderMealPlanCompilerPrompt } from "./prompt.js";
import {
  buildMealPlanCompilerInvocation,
  runCodex,
  type CodexResult,
} from "./codex.js";
import type { ShoppingPlan } from "./types.js";
import { parseMealPlanDraft } from "./validation.js";

export interface RecipeDocument {
  sourceName: string;
  text: string;
}

export interface MealPlanCompilerInvocation {
  prompt: string;
  documents: readonly RecipeDocument[];
  signal: AbortSignal;
}

export type InvokeMealPlanCompiler = (
  input: MealPlanCompilerInvocation,
) => Promise<MealPlanDraft>;

export interface RunMealPlanCompilerInput {
  executable: string;
  rootDir: string;
  schemaPath: string;
  outputPath: string;
  eventsPath: string;
  stderrPath: string;
  timeoutMs: number;
  documents: readonly RecipeDocument[];
  options?: MealPlanCompileOptions;
  signal?: AbortSignal;
}

/** Ensure the model cannot invent, rename, duplicate, or omit recipe sources. */
export function assertDraftMatchesDocuments(
  draft: MealPlanDraft,
  documents: readonly RecipeDocument[],
): void {
  const expected = documents.map(({ sourceName }) => sourceName).sort();
  const received = draft.recipes.map(({ sourceName }) => sourceName).sort();
  if (JSON.stringify(received) !== JSON.stringify(expected)) {
    throw new Error("Meal-plan draft recipe sources do not match the supplied documents");
  }
  const textBySource = new Map(documents.map(({ sourceName, text }) => [sourceName, text]));
  for (const recipe of draft.recipes) {
    const source = textBySource.get(recipe.sourceName);
    if (source === undefined) throw new Error(`Unknown recipe source: ${recipe.sourceName}`);
    const sourceLines = new Set(
      source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    );
    for (const ingredient of recipe.ingredients) {
      if (!sourceLines.has(ingredient.sourceText.trim())) {
        throw new Error(`Ingredient sourceText is not a complete verbatim line from ${recipe.sourceName}`);
      }
    }
  }
}

/** Run the real read-only planner agent and compile its JSON output locally. */
export async function runMealPlanCompiler(
  input: RunMealPlanCompilerInput,
): Promise<{ plan: ShoppingPlan; codex: CodexResult }> {
  const invocation = buildMealPlanCompilerInvocation({
    rootDir: input.rootDir,
    outputPath: input.outputPath,
    schemaPath: input.schemaPath,
  });
  const codex = await runCodex({
    executable: input.executable,
    args: invocation.args,
    prompt: renderMealPlanCompilerPrompt({ recipeDocuments: input.documents }),
    eventsPath: input.eventsPath,
    stderrPath: input.stderrPath,
    timeoutMs: input.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (codex.timedOut || codex.exitCode !== 0) {
    throw new Error(
      `Meal-plan compiler failed (exit ${codex.exitCode}${codex.signal ? `, ${codex.signal}` : ""})`,
    );
  }
  const draft = parseMealPlanDraft(readFileSync(input.outputPath, "utf8"));
  assertDraftMatchesDocuments(draft, input.documents);
  return {
    plan: compileShoppingPlan(draft, input.options),
    codex,
  };
}

/**
 * Run the semantic recipe-reading step, then keep grouping, policy, and
 * cross-reference checks deterministic and local.
 */
export async function compileRecipeDocuments(
  documents: readonly RecipeDocument[],
  invokeCompiler: InvokeMealPlanCompiler,
  options: MealPlanCompileOptions = {},
  signal = new AbortController().signal,
): Promise<ShoppingPlan> {
  if (documents.length === 0) {
    throw new Error("At least one recipe document is required");
  }
  if (documents.some(({ sourceName, text }) => !sourceName.trim() || !text.trim())) {
    throw new Error("Recipe documents require a source name and non-empty text");
  }
  const prompt = renderMealPlanCompilerPrompt({ recipeDocuments: documents });
  const draft = await invokeCompiler({ prompt, documents, signal });
  if (signal.aborted) throw new Error("Meal-plan compilation was aborted");
  assertDraftMatchesDocuments(draft, documents);
  return compileShoppingPlan(draft, options);
}
