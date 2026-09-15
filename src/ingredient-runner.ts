import type {
  GroceryIngredient,
  GroceryRecipe,
  GroceryRequest,
  IngredientResult,
} from "./types.js";

export type IngredientRecipeContext = Pick<
  GroceryRecipe,
  "id" | "name" | "servings" | "context"
>;

export interface IngredientTask {
  ingredient: GroceryIngredient;
  recipeContext: readonly IngredientRecipeContext[];
}

export function flattenIngredientTasks(
  request: GroceryRequest,
): IngredientTask[] {
  return request.recipes.flatMap((recipe) =>
    recipe.ingredients.map((ingredient) => ({
      ingredient,
      recipeContext: [
        {
          id: recipe.id,
          name: recipe.name,
          servings: recipe.servings,
          context: recipe.context,
        },
      ],
    })),
  );
}

export type IngredientAgentInvocation<TSession> = (input: {
  task: IngredientTask;
  session: TSession;
  priorResults: readonly IngredientResult[];
  signal: AbortSignal;
}) => Promise<IngredientResult>;

export interface IngredientRunResult {
  task: IngredientTask;
  result: IngredientResult;
}

export interface IngredientRunProgress {
  total: number;
  completed: number;
  remaining: number;
  results: readonly IngredientRunResult[];
  stopped: boolean;
  stopReason: string | null;
}

export interface IngredientRunnerOptions<TSession> {
  tasks: readonly IngredientTask[];
  session: TSession;
  invokeAgent: IngredientAgentInvocation<TSession>;
  signal?: AbortSignal;
  onProgress?: (progress: IngredientRunProgress) => void | Promise<void>;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const invalidResultReason = (result: IngredientResult): string | null => {
  if (!result || typeof result !== "object") {
    return "Agent returned an invalid result";
  }
  if (
    result.status !== "added" &&
    result.status !== "already_present" &&
    result.status !== "skipped" &&
    result.status !== "failed"
  ) {
    return "Agent returned an unsupported status";
  }
  if (!isNonEmptyString(result.ingredientId) || !isNonEmptyString(result.requested)) {
    return "Agent result did not identify the requested ingredient";
  }
  if (!isNonEmptyString(result.rationale)) {
    return "Agent returned no rationale";
  }
  if (
    (result.status === "skipped" || result.status === "failed") &&
    !isNonEmptyString(result.failureReason)
  ) {
    return `Agent returned ${result.status} without a failure reason`;
  }
  if (
    (result.status === "added" || result.status === "already_present") &&
    (!isNonEmptyString(result.productName) ||
      !isNonEmptyString(result.packageSize) ||
      !Number.isSafeInteger(result.quantity) ||
      result.quantity < 1 ||
      result.failureReason !== null)
  ) {
    return `Agent returned ${result.status} without a complete product result`;
  }
  if (
    (result.status === "skipped" || result.status === "failed") &&
    (result.productName !== null ||
      result.packageSize !== null ||
      result.quantity !== 0 ||
      result.price !== null)
  ) {
    return `Agent returned ${result.status} with product details`;
  }
  return null;
};

const makeProgress = (
  total: number,
  results: readonly IngredientRunResult[],
  stopped: boolean,
  stopReason: string | null,
): IngredientRunProgress => ({
  total,
  completed: results.length,
  remaining: total - results.length,
  results: [...results],
  stopped,
  stopReason,
});

const failedResult = (
  task: IngredientTask,
  reason: string,
): IngredientResult => ({
  ingredientId: task.ingredient.id,
  requested: task.ingredient.request,
  status: "failed",
  productName: null,
  packageSize: null,
  quantity: 0,
  price: null,
  rationale: "The ingredient agent did not return a valid completed result.",
  confidence: "low",
  failureReason: reason,
});

/**
 * Invoke one fresh agent context per ingredient. The browser session is shared,
 * and final cart truth is checked once by the caller after this queue ends.
 */
export async function runIngredientTasks<TSession>(
  options: IngredientRunnerOptions<TSession>,
): Promise<IngredientRunProgress> {
  const signal = options.signal ?? new AbortController().signal;
  const results: IngredientRunResult[] = [];
  let stopped = false;
  let stopReason: string | null = null;

  const publishProgress = async (): Promise<void> => {
    try {
      await options.onProgress?.(
        makeProgress(options.tasks.length, results, stopped, stopReason),
      );
    } catch {
      // Progress is diagnostic output. A failed progress write must not prevent
      // the current result from reaching the final report.
    }
  };

  for (const task of options.tasks) {
    if (signal.aborted) {
      stopped = true;
      stopReason = "Run aborted before the next ingredient started";
      break;
    }

    let result: IngredientResult;
    try {
      result = await options.invokeAgent({
        task,
        session: options.session,
        priorResults: results.map(({ result: prior }) => prior),
        signal,
      });
    } catch (error) {
      result = failedResult(task, errorMessage(error));
    }

    const invalidReason =
      result &&
      typeof result === "object" &&
      result.ingredientId !== task.ingredient.id
        ? `Agent returned ${result.ingredientId} for ${task.ingredient.id}`
        : invalidResultReason(result);
    if (invalidReason !== null) {
      result = failedResult(task, invalidReason);
    }

    results.push({ task, result });
    await publishProgress();
  }

  return makeProgress(options.tasks.length, results, stopped, stopReason);
}
