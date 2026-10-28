import type {
  AuthReport,
  CartItemSnapshot,
  CartReport,
  CartSelection,
  ShoppingList,
  CartItemResult,
} from "./types.js";
import {
  computeCartDelta,
  getTotalItemCount,
  type CartInspectionResult,
} from "./cart-state.js";

export interface BuildCartReportInput {
  request: ShoppingList;
  requestSha256: string;
  preflight: AuthReport;
  baseline: CartInspectionResult;
  final: CartInspectionResult;
  results: readonly CartItemResult[];
  stopped?: boolean;
  stopReason?: string | null;
  additionalVerificationNotes?: readonly string[];
}

export function completeCartItemResults(
  request: ShoppingList,
  results: readonly CartItemResult[],
  reason: string,
): CartItemResult[] {
  const byId = new Map(results.map((result) => [result.ingredientId, result]));
  return (request.ingredients ?? request.recipes!.flatMap((recipe) => recipe.ingredients))
    .map((ingredient) =>
      byId.get(ingredient.id) ?? {
        ingredientId: ingredient.id,
        requested: ingredient.request,
        status: "failed",
        productName: null,
        productId: null,
        packageSize: null,
        quantity: 0,
        price: null,
        rationale: "The cart run did not reach this shopping-list item.",
        confidence: "low",
        failureReason: reason,
      },
    );
}

const emptySelection = (
  result: CartItemResult,
  rationale: string,
): CartSelection => ({
  ingredientId: result.ingredientId,
  requested: result.requested,
  status: "skipped",
  productName: null,
  productId: null,
  packageSize: null,
  quantity: 0,
  price: null,
  rationale,
  confidence: result.confidence,
});

const asSelection = (result: CartItemResult): CartSelection => {
  if (result.status === "added" || result.status === "already_present") {
    return {
      ingredientId: result.ingredientId,
      requested: result.requested,
      status: result.status,
      productName: result.productName,
      productId: result.productId,
      packageSize: result.packageSize,
      quantity: result.quantity,
      price: result.price,
      rationale: result.rationale,
      confidence: result.confidence,
    };
  }
  return emptySelection(
    result,
    result.failureReason ?? result.rationale,
  );
};

const normalizeName = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

/**
 * Cart item quantity is a count of purchase units. Whole Foods cart controls
 * normally expose that same count, but weighted produce can instead expose the
 * selected weight (for example, one 0.25 lb ginger purchase appears as 0.25).
 * A positive cart value therefore proves a single reported purchase unit; only
 * multi-unit results require a numeric quantity comparison.
 */
const quantityMatchesResult = (
  item: CartItemSnapshot,
  result: CartItemResult,
): boolean => result.quantity === 1 ? item.quantity > 0 : item.quantity >= result.quantity;

const itemMatchesResult = (
  item: CartItemSnapshot,
  result: CartItemResult,
): boolean => {
  if (result.productName === null || result.quantity < 1) return false;
  if (item.productId && result.productId) {
    return (
      item.productId.toLocaleUpperCase() === result.productId.toLocaleUpperCase() &&
      quantityMatchesResult(item, result)
    );
  }
  const actual = normalizeName(item.productName);
  const expected = normalizeName(result.productName);
  const expectedWithPackage = result.packageSize
    ? normalizeName(`${result.productName} ${result.packageSize}`)
    : expected;
  return (
    (actual === expected || actual === expectedWithPackage) &&
    quantityMatchesResult(item, result)
  );
};

const cartItemsContain = (
  items: readonly CartItemSnapshot[],
  result: CartItemResult,
): boolean => items.some((item) => itemMatchesResult(item, result));

interface VerificationNote {
  ingredientId: string;
  note: string;
}

const verifyResults = (
  results: readonly CartItemResult[],
  baseline: CartInspectionResult,
  final: CartInspectionResult,
): VerificationNote[] => {
  const delta = computeCartDelta(baseline.items, final.items).map((item) => ({ ...item }));
  const deltaAvailable =
    baseline.extractionStatus !== "degraded" &&
    final.extractionStatus !== "degraded";
  const notes: VerificationNote[] = [];
  for (const result of results) {
    if (result.status === "skipped" || result.status === "failed") continue;
    if (!deltaAvailable) continue;
    const verified =
      result.status === "added"
        ? cartItemsContain(delta, result)
        : cartItemsContain(baseline.items, result) ||
          cartItemsContain(final.items, result);
    if (verified && result.status === "added") {
      // Allocate each observed unit once across reported additions of the same product.
      const matched = delta.find((item) => itemMatchesResult(item, result))!;
      matched.quantity -= result.quantity === 1 ? Math.min(1, matched.quantity) : result.quantity;
    }
    if (!verified) {
      notes.push({
        ingredientId: result.ingredientId,
        note:
          `Final cart verification did not match the cart item result for ${result.ingredientId}: ` +
          `expected ${result.quantity} of ${result.productName ?? "an identified product"}.`,
      });
    }
  }
  return notes;
};

export function buildCartReport(input: BuildCartReportInput): CartReport {
  const baselineExtractionFailed = input.baseline.extractionStatus === "degraded";
  const baselineExtractionNote = baselineExtractionFailed
    ? `baseline cart extraction was degraded${input.baseline.extractionDiagnostic ? `: ${input.baseline.extractionDiagnostic}` : ""}.`
    : null;
  const finalExtractionNote = input.final.extractionStatus === "degraded"
    ? `final cart extraction was degraded${input.final.extractionDiagnostic ? `: ${input.final.extractionDiagnostic}` : ""}.`
    : null;
  const verificationNotes = [
    ...(input.additionalVerificationNotes ?? []),
    ...(finalExtractionNote ? [finalExtractionNote] : []),
    ...verifyResults(input.results, input.baseline, input.final).map(
      (note) => note.note,
    ),
  ];
  const agentFailures = input.results
    .filter((result) => result.status === "failed")
    .map((result) => `${result.ingredientId}: ${result.failureReason}`);
  const agentSkips = input.results
    .filter((result) => result.status === "skipped")
    .map((result) => `${result.ingredientId}: ${result.failureReason}`);
  const failureNotes = [
    ...agentFailures,
    ...(baselineExtractionNote ? [baselineExtractionNote] : []),
    ...(input.stopped && input.stopReason ? [input.stopReason] : []),
  ];
  const hasFailed =
    input.stopped === true ||
    agentFailures.length > 0 ||
    baselineExtractionFailed;
  const hasSkipped = agentSkips.length > 0;
  const runStatus = hasFailed ? "failed" : hasSkipped ? "partial" : "completed";
  const verificationStatus = baselineExtractionFailed
    ? "not_run"
    : verificationNotes.length > 0
      ? "inconclusive"
      : "confirmed";
  const selections = input.results.map(asSelection);

  return {
    runStatus,
    verificationStatus,
    requestSha256: input.requestSha256,
    authenticated: input.preflight.authenticated,
    wholeFoodsStorefrontConfirmed: input.preflight.wholeFoodsStorefrontConfirmed,
    baselineCartCount: input.baseline.totalItemCount,
    baselineItems: [...input.baseline.items],
    finalCartCount: input.final.totalItemCount,
    finalCartDelta: computeCartDelta(input.baseline.items, input.final.items),
    selections,
    ...(verificationNotes.length > 0 ? { verificationNotes } : {}),
    failureReason:
      failureNotes.length > 0
        ? failureNotes.join(" ")
        : agentSkips.length > 0
          ? agentSkips.join(" ")
          : null,
  };
}

export function buildFailedCartReport(input: {
  request: ShoppingList;
  requestSha256: string;
  preflight: AuthReport;
  failureReason: string;
  baselineItems?: readonly CartItemSnapshot[];
}): CartReport {
  const selections = (input.request.ingredients ?? input.request.recipes!.flatMap((recipe) => recipe.ingredients))
    .map((ingredient) =>
      emptySelection(
        {
          ingredientId: ingredient.id,
          requested: ingredient.request,
          status: "failed",
          productName: null,
          productId: null,
          packageSize: null,
          quantity: 0,
          price: null,
          rationale: "The cart run could not complete preflight.",
          confidence: "low",
          failureReason: input.failureReason,
        },
        input.failureReason,
      ),
    );
  const baselineItems = [...(input.baselineItems ?? [])];
  return {
    runStatus: "failed",
    verificationStatus: "not_run",
    requestSha256: input.requestSha256,
    authenticated: input.preflight.authenticated,
    wholeFoodsStorefrontConfirmed: input.preflight.wholeFoodsStorefrontConfirmed,
    baselineCartCount: getTotalItemCount(baselineItems),
    baselineItems,
    finalCartCount: getTotalItemCount(baselineItems),
    finalCartDelta: [],
    selections,
    failureReason: input.failureReason,
  };
}
