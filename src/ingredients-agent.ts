import { readFileSync } from "node:fs";
import {
  compileRecipeCompilation,
  recipeCompilationToShoppingList,
  type IngredientsAgentOutput,
} from "./shopping-list-compiler.js";
import { renderIngredientsAgentPrompt } from "./prompt.js";
import {
  buildIngredientsAgentInvocation,
  runCodex,
  type CodexResult,
} from "./codex.js";
import type { RecipeCompilation, ShoppingList } from "./types.js";
import { parseIngredientsAgentOutput } from "./validation.js";

export interface RecipeDocument {
  sourceName: string;
  text: string;
}

export interface IngredientsAgentInvocation {
  prompt: string;
  documents: readonly RecipeDocument[];
  signal: AbortSignal;
}

export type InvokeIngredientsAgent = (
  input: IngredientsAgentInvocation,
) => Promise<IngredientsAgentOutput>;

export interface RunIngredientsAgentInput {
  executable: string;
  rootDir: string;
  workDir?: string;
  schemaPath: string;
  outputPath: string;
  eventsPath: string;
  stderrPath: string;
  timeoutMs: number;
  documents: readonly RecipeDocument[];
  signal?: AbortSignal;
}

/** Ensure the model cannot invent, rename, duplicate, or omit recipe sources. */
export function assertDraftMatchesDocuments(
  draft: IngredientsAgentOutput,
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
export async function runIngredientsAgent(
  input: RunIngredientsAgentInput,
): Promise<{
  shoppingList: ShoppingList;
  recipeCompilation: RecipeCompilation;
  codex: CodexResult;
}> {
  const invocation = buildIngredientsAgentInvocation({
    rootDir: input.rootDir,
    ...(input.workDir ? { workDir: input.workDir } : {}),
    outputPath: input.outputPath,
    schemaPath: input.schemaPath,
  });
  const codex = await runCodex({
    executable: input.executable,
    args: invocation.args,
    workDir: invocation.workDir,
    prompt: renderIngredientsAgentPrompt({ recipeDocuments: input.documents }),
    eventsPath: input.eventsPath,
    stderrPath: input.stderrPath,
    timeoutMs: input.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (codex.timedOut || codex.exitCode !== 0) {
    throw new Error(
      `Ingredients Agent failed (exit ${codex.exitCode}${codex.signal ? `, ${codex.signal}` : ""})`,
    );
  }
  const draft = parseIngredientsAgentOutput(readFileSync(input.outputPath, "utf8"));
  assertDraftMatchesDocuments(draft, input.documents);
  const recipeCompilation = compileRecipeCompilation(draft);
  return {
    shoppingList: recipeCompilationToShoppingList(recipeCompilation, input.documents),
    recipeCompilation,
    codex,
  };
}

/**
 * Run the semantic recipe-reading step, then keep grouping and
 * cross-reference checks deterministic and local.
 */
export async function compileIngredientsList(
  documents: readonly RecipeDocument[],
  invokeCompiler: InvokeIngredientsAgent,
  signal = new AbortController().signal,
): Promise<ShoppingList> {
  if (documents.length === 0) {
    throw new Error("At least one recipe document is required");
  }
  if (documents.some(({ sourceName, text }) => !sourceName.trim() || !text.trim())) {
    throw new Error("Recipe documents require a source name and non-empty text");
  }
  const prompt = renderIngredientsAgentPrompt({ recipeDocuments: documents });
  const draft = await invokeCompiler({ prompt, documents, signal });
  if (signal.aborted) throw new Error("Ingredients Agent run was aborted");
  assertDraftMatchesDocuments(draft, documents);
  return recipeCompilationToShoppingList(compileRecipeCompilation(draft), documents);
}
