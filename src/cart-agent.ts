import type {
  GroceryIngredient,
  GroceryRecipe,
  ShoppingList,
  CartAgentResult,
} from "./types.js";

export type CartAgentRecipeContext = Pick<
  GroceryRecipe,
  "id" | "name" | "servings" | "context"
>;

export interface CartAgentTask {
  ingredient: GroceryIngredient;
  recipeContext: readonly CartAgentRecipeContext[];
}

export function flattenCartAgentTasks(
  request: ShoppingList,
): CartAgentTask[] {
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

export type CartAgentInvocation<TSession> = (input: {
  task: CartAgentTask;
  session: TSession;
  priorResults: readonly CartAgentResult[];
  signal: AbortSignal;
}) => Promise<CartAgentResult>;

export interface CartAgentRunResult {
  task: CartAgentTask;
  result: CartAgentResult;
}

export interface CartAgentRunProgress {
  total: number;
  completed: number;
  remaining: number;
  results: readonly CartAgentRunResult[];
  stopped: boolean;
  stopReason: string | null;
}

export interface CartAgentRunnerOptions<TSession> {
  tasks: readonly CartAgentTask[];
  session: TSession;
  invokeAgent: CartAgentInvocation<TSession>;
  signal?: AbortSignal;
  onProgress?: (progress: CartAgentRunProgress) => void | Promise<void>;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const invalidResultReason = (result: CartAgentResult): string | null => {
  if (!result || typeof result !== "object") {
    return "Cart Agent returned an invalid result";
  }
  if (
    result.status !== "added" &&
    result.status !== "already_present" &&
    result.status !== "skipped" &&
    result.status !== "failed"
  ) {
    return "Cart Agent returned an unsupported status";
  }
  if (!isNonEmptyString(result.ingredientId) || !isNonEmptyString(result.requested)) {
    return "Cart Agent result did not identify the requested ingredient";
  }
  if (!isNonEmptyString(result.rationale)) {
    return "Cart Agent returned no rationale";
  }
  if (
    (result.status === "skipped" || result.status === "failed") &&
    !isNonEmptyString(result.failureReason)
  ) {
    return `Cart Agent returned ${result.status} without a failure reason`;
  }
  if (
    result.status === "added" &&
    (!isNonEmptyString(result.productName) ||
      !isNonEmptyString(result.productId) ||
      !isNonEmptyString(result.packageSize) ||
      !Number.isSafeInteger(result.quantity) ||
      result.quantity < 1 ||
      result.failureReason !== null)
  ) {
    return "Cart Agent returned added without a complete product result";
  }
  if (
    result.status === "already_present" &&
    (!isNonEmptyString(result.productName) ||
      !isNonEmptyString(result.productId) ||
      !Number.isSafeInteger(result.quantity) ||
      result.quantity < 1 ||
      result.failureReason !== null)
  ) {
    return "Cart Agent returned already_present without verifiable cart identity and quantity";
  }
  if (
    (result.status === "skipped" || result.status === "failed") &&
    (result.productName !== null ||
      result.productId !== null ||
      result.packageSize !== null ||
      result.quantity !== 0 ||
      result.price !== null)
  ) {
    return `Cart Agent returned ${result.status} with product details`;
  }
  return null;
};

const makeProgress = (
  total: number,
  results: readonly CartAgentRunResult[],
  stopped: boolean,
  stopReason: string | null,
): CartAgentRunProgress => ({
  total,
  completed: results.length,
  remaining: total - results.length,
  results: [...results],
  stopped,
  stopReason,
});

const failedResult = (
  task: CartAgentTask,
  reason: string,
): CartAgentResult => ({
  ingredientId: task.ingredient.id,
  requested: task.ingredient.request,
  status: "failed",
  productName: null,
  productId: null,
  packageSize: null,
  quantity: 0,
  price: null,
  rationale: "The Cart Agent did not return a valid completed result.",
  confidence: "low",
  failureReason: reason,
});

/**
 * Invoke one fresh agent context per ingredient. The browser session is shared,
 * and final cart truth is checked once by the caller after this queue ends.
 */
export async function runCartAgentTasks<TSession>(
  options: CartAgentRunnerOptions<TSession>,
): Promise<CartAgentRunProgress> {
  const signal = options.signal ?? new AbortController().signal;
  const results: CartAgentRunResult[] = [];
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

    let result: CartAgentResult;
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
        ? `Cart Agent returned ${result.ingredientId} for ${task.ingredient.id}`
        : invalidResultReason(result);
    if (invalidReason !== null) {
      result = failedResult(task, invalidReason);
    }

    results.push({ task, result });
    if (result.status === "failed") {
      stopped = true;
      stopReason = result.failureReason ?? `Cart Agent failed for ${task.ingredient.id}`;
    }
    await publishProgress();
    if (stopped) break;
  }

  return makeProgress(options.tasks.length, results, stopped, stopReason);
}
