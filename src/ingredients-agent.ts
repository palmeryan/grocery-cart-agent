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

/** Keep source context usable even if the model changes or omits recipe names. */
function reconcileRecipeSources(
  draft: IngredientsAgentOutput,
  documents: readonly RecipeDocument[],
): { draft: IngredientsAgentOutput; documents: readonly RecipeDocument[] } {
  const expected = documents.map(({ sourceName }) => sourceName).sort();
  const received = draft.recipes.map(({ sourceName }) => sourceName).sort();
  if (JSON.stringify(received) === JSON.stringify(expected)) return { draft, documents };
  const sourceName = "Combined recipes";
  return {
    draft: { recipes: [{ sourceName, ingredients: draft.recipes.flatMap((recipe) => recipe.ingredients) }] },
    documents: [{ sourceName, text: documents.map(({ sourceName: name, text }) => `${name}\n${text}`).join("\n\n") }],
  };
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
  const reconciled = reconcileRecipeSources(draft, input.documents);
  const recipeCompilation = compileRecipeCompilation(reconciled.draft);
  return {
    shoppingList: recipeCompilationToShoppingList(recipeCompilation, reconciled.documents),
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
  const reconciled = reconcileRecipeSources(draft, documents);
  return recipeCompilationToShoppingList(compileRecipeCompilation(reconciled.draft), reconciled.documents);
}
