import type { CartDecision } from "./cart-decision.js";
import type { CartNetworkItem, CartNetworkSnapshot } from "./cart-network.js";
import type { CartItemResult, CartItemSnapshot, GroceryIngredient, ShoppingList } from "./types.js";
import type { ProductCandidate } from "./wfm-page.js";

export interface CartTask {
  ingredient: GroceryIngredient;
  recipeContext: { id?: string; name: string; context?: string; text?: string }[];
}

export function cartTasks(list: ShoppingList): CartTask[] {
  const entries = list.ingredients?.map((ingredient) => ({ ingredient, recipeContext: [] })) ??
    list.recipes!.flatMap((recipe) => recipe.ingredients.map((ingredient) => ({
      ingredient, recipeContext: [{ id: recipe.id, name: recipe.name, context: recipe.context }],
    })));
  return entries.map(({ ingredient, recipeContext }) => ({
    ingredient,
    recipeContext: ingredient.purchaseRequirement
      ? ingredient.purchaseRequirement.sources.map((sourceName) => {
          const source = list.sourceRecipes?.find((entry) => entry.sourceName === sourceName);
          if (!source) throw new Error(`Missing source recipe: ${sourceName}`);
          return { name: sourceName, text: source.text };
        })
      : recipeContext,
  }));
}

export interface CartFlowFailure {
  task: CartTask;
  stage: "search" | "decision" | "interaction";
  reason: string;
  mayHaveCommitted: boolean;
  candidate: ProductCandidate | null;
  quantity: number | null;
}

export interface CartFlowProgress {
  total: number;
  completed: number;
  results: readonly CartItemResult[];
  timings: readonly CartItemTiming[];
  stopped: boolean;
  stopReason: string | null;
}

export interface CartItemTiming {
  ingredientId: string;
  searchMs: number;
  decisionMs: number;
  interactionAndConfirmationMs: number;
  totalMs: number;
  modelCalls: number;
  searches: number;
  outcome: CartItemResult["status"];
}

export interface CartFlowOptions {
  tasks: readonly CartTask[];
  baseline: readonly CartItemSnapshot[];
  search(query: string): Promise<ProductCandidate[]>;
  decide(task: CartTask, candidates: readonly ProductCandidate[], cart: readonly CartItemSnapshot[]): Promise<CartDecision>;
  add(
    task: CartTask,
    candidate: ProductCandidate,
    quantity: number,
    option: string | null,
    before: readonly CartNetworkItem[],
    cart: readonly CartItemSnapshot[],
    recordAdditionalDecision: (durationMs: number) => void,
  ): Promise<CartNetworkSnapshot | { snapshot: CartNetworkSnapshot; quantity: number; reason: string | null }>;
  onProgress?(progress: CartFlowProgress): void | Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
}

export interface CartFlowResult extends CartFlowProgress {
  latestSnapshot: CartNetworkSnapshot | null;
  failure: CartFlowFailure | null;
}

export class CartNoMutationError extends Error {
  constructor(message: string, readonly snapshot: CartNetworkSnapshot) {
    super(message);
    this.name = "CartNoMutationError";
  }
}

/** A mutation could not be correlated, but a full cart snapshot can safely seed the next item. */
export class CartUnresolvedMutationError extends Error {
  constructor(message: string, readonly snapshot: CartNetworkSnapshot) {
    super(message);
    this.name = "CartUnresolvedMutationError";
  }
}

export class CartRunFatalError extends Error {}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function failed(task: CartTask, reason: string): CartItemResult {
  return {
    ingredientId: task.ingredient.id, requested: task.ingredient.request,
    status: "failed", productName: null, productId: null, packageSize: null,
    quantity: 0, price: null, rationale: reason, confidence: "low", failureReason: reason,
  };
}

function skipped(task: CartTask, reason: string): CartItemResult {
  return { ...failed(task, reason), status: "skipped" };
}

function fromSnapshot(
  snapshot: CartNetworkSnapshot,
  names: Map<string, string>,
): CartItemSnapshot[] {
  return snapshot.items.map(({ asin, quantity }) => ({
    productId: asin,
    productName: names.get(asin.toUpperCase()) ?? asin,
    quantity,
  }));
}

/** The harness owns cart mutations and records success only from cart snapshots. */
export async function runCartFlow(options: CartFlowOptions): Promise<CartFlowResult> {
  const results: CartItemResult[] = [];
  const timings: CartItemTiming[] = [];
  const now = options.now ?? Date.now;
  const names = new Map(options.baseline.flatMap((item) => item.productId
    ? [[item.productId.toUpperCase(), item.productName] as const] : []));
  let cart = [...options.baseline];
  let latestSnapshot: CartNetworkSnapshot | null = null;
  let failure: CartFlowFailure | null = null;

  const progress = (): CartFlowResult => ({
    total: options.tasks.length, completed: results.length, results: [...results], timings: [...timings],
    stopped: failure !== null, stopReason: failure?.reason ?? null, latestSnapshot, failure,
  });
  const publish = async (): Promise<void> => { await options.onProgress?.(progress()); };

  for (const task of options.tasks) {
    const started = now();
    let searchMs = 0;
    let decisionMs = 0;
    let interactionAndConfirmationMs = 0;
    let searches = 0;
    let modelCalls = 0;
    let stage: CartFlowFailure["stage"] = "search";
    let candidate: ProductCandidate | null = null;
    let quantity: number | null = null;
    let mayHaveCommitted = false;
    let cartUncertain = false;
    try {
      if (options.signal?.aborted) throw new Error("Cart run aborted");
      let query = task.ingredient.request;
      for (let searchCount = 0; searchCount < 2; searchCount += 1) {
        stage = "search";
        const searchStarted = now();
        searches += 1;
        let candidates: ProductCandidate[];
        try { candidates = await options.search(query); }
        finally { searchMs += now() - searchStarted; }
        stage = "decision";
        const decisionStarted = now();
        modelCalls += 1;
        let decision: CartDecision;
        try { decision = await options.decide(task, candidates, cart); }
        finally { decisionMs += now() - decisionStarted; }
        if (decision.action === "search_again") {
          if (searchCount > 0) throw new Error("Decision requested more than one revised search");
          query = decision.query;
          continue;
        }
        if (decision.action === "skip") {
          results.push({
            ingredientId: task.ingredient.id, requested: task.ingredient.request,
            status: "skipped", productName: null, productId: null, packageSize: null,
            quantity: 0, price: null, rationale: decision.reason,
            confidence: "medium", failureReason: decision.reason,
          });
          break;
        }
        if (decision.action === "already_present") {
          const existing = cart.find((item) => item.productId?.toUpperCase() === decision.cartProductId.toUpperCase());
          if (!existing) throw new Error(`Existing cart product ${decision.cartProductId} was not observed`);
          results.push({
            ingredientId: task.ingredient.id, requested: task.ingredient.request,
            status: "already_present", productName: existing.productName,
            productId: existing.productId ?? null, packageSize: null,
            quantity: Number.isSafeInteger(existing.quantity) ? existing.quantity : 1,
            price: null, rationale: "Product was already in the cart.",
            confidence: "medium", failureReason: null,
          });
          break;
        }
        if (cart.some((item) => !item.productId)) {
          throw new CartRunFatalError("Cart baseline has an item without a product ID; cannot verify the next add");
        }
        let selection = decision;
        const rejected: string[] = [];
        const rejectedIds = new Set<string>();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          candidate = candidates.find((item) => item.id.toUpperCase() === selection.candidateId.toUpperCase()) ?? null;
          quantity = selection.quantity;
          if (!candidate || candidate.available !== true) {
            throw new Error(`Selected candidate ${selection.candidateId} is missing or unavailable`);
          }
          stage = "interaction";
          const before = cart.map((item) => ({ asin: item.productId!, quantity: item.quantity }));
          mayHaveCommitted = true;
          cartUncertain = true;
          const interactionStarted = now();
          let additionalDecisionMs = 0;
          let snapshot: CartNetworkSnapshot;
          let finalReason = selection.reason;
          try {
            const added = await options.add(task, candidate, selection.quantity, selection.option, before, cart, (durationMs) => {
              modelCalls += 1;
              decisionMs += durationMs;
              additionalDecisionMs += durationMs;
            });
            if ("snapshot" in added) {
              snapshot = added.snapshot;
              quantity = added.quantity;
              finalReason = added.reason ?? finalReason;
            } else {
              snapshot = added;
            }
          } catch (error) {
            if (error instanceof CartUnresolvedMutationError) {
              cartUncertain = false;
              names.set(candidate.id.toUpperCase(), candidate.productName);
              latestSnapshot = error.snapshot;
              cart = fromSnapshot(error.snapshot, names);
              if (options.signal?.aborted) throw error;
              results.push(failed(task, error.message));
              break;
            }
            if (!(error instanceof CartNoMutationError)) throw error;
            cartUncertain = false;
            rejected.push(error.message);
            rejectedIds.add(candidate.id.toUpperCase());
            latestSnapshot = error.snapshot;
            cart = fromSnapshot(error.snapshot, names);
            const alternatives = candidates.filter((item) => item.available === true &&
              !rejectedIds.has(item.id.toUpperCase()));
            if (attempt === 1 || alternatives.length === 0) {
              results.push(skipped(task, rejected.join(" ")));
              break;
            }
            stage = "decision";
            const retryDecisionStarted = now();
            modelCalls += 1;
            let retry: CartDecision;
            try { retry = await options.decide(task, alternatives, cart); }
            catch (decisionError) {
              if (options.signal?.aborted) throw decisionError;
              results.push(skipped(task, `${rejected.join(" ")} Alternate selection failed: ${errorText(decisionError)}`));
              break;
            } finally {
              const duration = now() - retryDecisionStarted;
              decisionMs += duration;
              additionalDecisionMs += duration;
            }
            if (retry.action !== "select") {
              results.push(skipped(task, `${rejected.join(" ")} Alternate product was not selected.`));
              break;
            }
            selection = retry;
            stage = "interaction";
            continue;
          } finally {
            interactionAndConfirmationMs += Math.max(0, now() - interactionStarted - additionalDecisionMs);
          }
          latestSnapshot = snapshot;
          cartUncertain = false;
          names.set(candidate.id.toUpperCase(), candidate.productName);
          cart = fromSnapshot(snapshot, names);
          results.push({
            ingredientId: task.ingredient.id, requested: task.ingredient.request,
            status: "added", productName: candidate.productName,
            productId: candidate.id.toUpperCase(), packageSize: candidate.packageSize,
            quantity: quantity!, price: candidate.price,
            rationale: [rejected.join(" "), finalReason ?? `Selected ${candidate.productName}; cart increase confirmed.`].filter(Boolean).join(" "),
            confidence: "medium", failureReason: null,
          });
          break;
        }
        break;
      }
      if (results.length === 0 || results.at(-1)?.ingredientId !== task.ingredient.id) {
        throw new Error("Decision did not resolve the ingredient");
      }
    } catch (error) {
      const reason = `${stage}: ${errorText(error)}`;
      if (cartUncertain || options.signal?.aborted || error instanceof CartRunFatalError) {
        failure = { task, stage, reason, mayHaveCommitted, candidate, quantity };
        results.push(failed(task, reason));
      } else {
        results.push(skipped(task, reason));
      }
    }
    timings.push({
      ingredientId: task.ingredient.id, searchMs, decisionMs, interactionAndConfirmationMs,
      totalMs: now() - started, modelCalls, searches,
      outcome: results.at(-1)!.status,
    });
    await publish();
    if (failure) break;
  }
  return progress();
}
