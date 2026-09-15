import type {
  AuthReport,
  CartItemSnapshot,
  CartReport,
  CartSelection,
  GroceryRequest,
  IngredientResult,
} from "./types.js";
import {
  cartTextContainsSelection,
  computeCartDelta,
  type CartInspectionResult,
} from "./cart-state.js";

export interface BuildCartReportInput {
  request: GroceryRequest;
  requestSha256: string;
  preflight: AuthReport;
  baseline: CartInspectionResult;
  final: CartInspectionResult;
  results: readonly IngredientResult[];
  stopped?: boolean;
  stopReason?: string | null;
  additionalVerificationNotes?: readonly string[];
}

export function completeIngredientResults(
  request: GroceryRequest,
  results: readonly IngredientResult[],
  reason: string,
): IngredientResult[] {
  const byId = new Map(results.map((result) => [result.ingredientId, result]));
  return request.recipes.flatMap((recipe) =>
    recipe.ingredients.map((ingredient) =>
      byId.get(ingredient.id) ?? {
        ingredientId: ingredient.id,
        requested: ingredient.request,
        status: "failed",
        productName: null,
        packageSize: null,
        quantity: 0,
        price: null,
        rationale: "The outer ingredient loop did not reach this ingredient.",
        confidence: "low",
        failureReason: reason,
      },
    ),
  );
}

const emptySelection = (
  result: IngredientResult,
  rationale: string,
): CartSelection => ({
  ingredientId: result.ingredientId,
  requested: result.requested,
  status: "skipped",
  productName: null,
  packageSize: null,
  quantity: 0,
  price: null,
  rationale,
  confidence: result.confidence,
});

const asSelection = (result: IngredientResult): CartSelection => {
  if (result.status === "added" || result.status === "already_present") {
    return {
      ingredientId: result.ingredientId,
      requested: result.requested,
      status: result.status,
      productName: result.productName,
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
  value.replace(/\s+/g, " ").trim().toLocaleLowerCase();

const deltaContains = (
  delta: readonly CartItemSnapshot[],
  result: IngredientResult,
): boolean => {
  if (result.productName === null || result.quantity < 1) return false;
  const expected = normalizeName(result.productName);
  return delta.some(
    (item) =>
      normalizeName(item.productName) === expected &&
      item.quantity >= result.quantity,
  );
};

interface VerificationNote {
  ingredientId: string;
  note: string;
}

const verifyResults = (
  results: readonly IngredientResult[],
  baseline: CartInspectionResult,
  final: CartInspectionResult,
): VerificationNote[] => {
  const delta = computeCartDelta(baseline.items, final.items);
  const deltaAvailable =
    baseline.extractionStatus !== "degraded" &&
    final.extractionStatus !== "degraded";
  const notes: VerificationNote[] = [];
  for (const result of results) {
    if (result.status === "skipped" || result.status === "failed") continue;
    const hasTextEvidence =
      result.productName !== null &&
      cartTextContainsSelection(
        final.bodyText,
        result.productName,
        result.quantity,
      );
    const hasDeltaEvidence =
      !deltaAvailable ||
      result.status === "already_present" ||
      deltaContains(delta, result);
    if (!hasTextEvidence || !hasDeltaEvidence) {
      notes.push({
        ingredientId: result.ingredientId,
        note:
          `Final cart verification did not match the agent result for ${result.ingredientId}: ` +
          `expected ${result.quantity} of ${result.productName ?? "an identified product"}.`,
      });
    }
  }
  return notes;
};

export function buildCartReport(input: BuildCartReportInput): CartReport {
  const extractionNotes = [
    { phase: "baseline", inspection: input.baseline },
    { phase: "final", inspection: input.final },
  ]
    .filter(({ inspection }) => inspection.extractionStatus === "degraded")
    .map(({ phase, inspection }) =>
      `${phase} cart extraction was degraded${inspection.extractionDiagnostic ? `: ${inspection.extractionDiagnostic}` : ""}.`,
    );
  const verificationNotes = [
    ...(input.additionalVerificationNotes ?? []),
    ...extractionNotes,
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
  const notes = [
    ...agentFailures,
    ...agentSkips,
    ...(input.stopped && input.stopReason ? [input.stopReason] : []),
  ];
  const hasFailed = input.stopped === true || agentFailures.length > 0;
  const hasSkipped = agentSkips.length > 0;
  const runStatus = hasFailed ? "failed" : hasSkipped ? "partial" : "completed";
  const selections = input.results.map(asSelection);

  return {
    runStatus,
    requestSha256: input.requestSha256,
    authenticated: input.preflight.authenticated,
    deliveryModeConfirmed: input.preflight.deliveryModeConfirmed,
    deliveryAddressConfirmed: input.preflight.deliveryAddressConfirmed,
    wholeFoodsStorefrontConfirmed: input.preflight.wholeFoodsStorefrontConfirmed,
    checkoutVisited: input.preflight.checkoutVisited,
    settingsChanged: input.preflight.settingsChanged,
    baselineCartCount: input.baseline.totalItemCount,
    baselineItems: [...input.baseline.items],
    finalCartCount: input.final.totalItemCount,
    finalCartDelta: computeCartDelta(input.baseline.items, input.final.items),
    selections,
    ...(verificationNotes.length > 0 ? { verificationNotes } : {}),
    failureReason: notes.length > 0 ? notes.join(" ") : null,
  };
}

export function buildFailedCartReport(input: {
  request: GroceryRequest;
  requestSha256: string;
  preflight: AuthReport;
  failureReason: string;
  baselineItems?: readonly CartItemSnapshot[];
}): CartReport {
  const selections = input.request.recipes.flatMap((recipe) =>
    recipe.ingredients.map((ingredient) =>
      emptySelection(
        {
          ingredientId: ingredient.id,
          requested: ingredient.request,
          status: "failed",
          productName: null,
          packageSize: null,
          quantity: 0,
          price: null,
          rationale: "The cart run could not complete preflight.",
          confidence: "low",
          failureReason: input.failureReason,
        },
        input.failureReason,
      ),
    ),
  );
  const baselineItems = [...(input.baselineItems ?? [])];
  return {
    runStatus: "failed",
    requestSha256: input.requestSha256,
    authenticated: input.preflight.authenticated,
    deliveryModeConfirmed: input.preflight.deliveryModeConfirmed,
    deliveryAddressConfirmed: input.preflight.deliveryAddressConfirmed,
    wholeFoodsStorefrontConfirmed: input.preflight.wholeFoodsStorefrontConfirmed,
    checkoutVisited: input.preflight.checkoutVisited,
    settingsChanged: input.preflight.settingsChanged,
    baselineCartCount: baselineItems.reduce((total, item) => total + item.quantity, 0),
    baselineItems,
    finalCartCount: baselineItems.reduce((total, item) => total + item.quantity, 0),
    finalCartDelta: [],
    selections,
    failureReason: input.failureReason,
  };
}
