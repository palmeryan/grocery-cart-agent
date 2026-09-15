import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type {
  AttachmentReport,
  AuthReport,
  CartReport,
  GroceryRequest,
  CartAgentResult,
  ShoppingPlan,
} from "./types.js";
import { assertShoppingPlanIntegrity } from "./meal-plan.js";
import type { MealPlanDraft } from "./meal-plan.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });

const compile = (relativePath: string): ValidateFunction => {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return ajv.compile(JSON.parse(readFileSync(path, "utf8")));
};

const requestValidator = compile("../schemas/request.schema.json");
const reportValidator = compile("../schemas/report.schema.json");
const authReportValidator = compile("../schemas/auth-report.schema.json");
const attachmentReportValidator = compile(
  "../schemas/attachment-report.schema.json",
);
const cartAgentResultValidator = compile(
  "../schemas/cart-agent-result.schema.json",
);
const shoppingPlanValidator = compile("../schemas/shopping-plan.schema.json");
const mealPlanDraftValidator = compile("../schemas/meal-plan-draft.schema.json");

const formatErrors = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");

export class ValidationFailure extends Error {
  constructor(
    kind:
      | "request"
      | "report"
      | "auth report"
      | "attachment report"
      | "cart agent result"
      | "shopping plan"
      | "meal plan draft",
    errors: ErrorObject[] | null | undefined,
  ) {
    super(`Invalid ${kind}: ${formatErrors(errors)}`);
    this.name = "ValidationFailure";
  }
}

const uniqueDuplicates = (values: string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates];
};

export function assertRequestIdentity(request: GroceryRequest): void {
  const recipeIds = request.recipes.map((recipe) => recipe.id);
  const ingredientIds = request.recipes.flatMap((recipe) =>
    recipe.ingredients.map((ingredient) => ingredient.id),
  );
  const duplicateRecipes = uniqueDuplicates(recipeIds);
  const duplicateIngredients = uniqueDuplicates(ingredientIds);
  const problems = [
    duplicateRecipes.length > 0
      ? `duplicate recipe IDs: ${duplicateRecipes.join(", ")}`
      : "",
    duplicateIngredients.length > 0
      ? `duplicate ingredient IDs: ${duplicateIngredients.join(", ")}`
      : "",
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(`Invalid request identity: ${problems.join("; ")}`);
  }
}

export function loadRequest(path: string): GroceryRequest {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!requestValidator(value)) {
    throw new ValidationFailure("request", requestValidator.errors);
  }
  const request = value as GroceryRequest;
  assertRequestIdentity(request);
  return request;
}

export function parseReport(text: string): CartReport {
  const value: unknown = JSON.parse(text);
  if (!reportValidator(value)) {
    throw new ValidationFailure("report", reportValidator.errors);
  }
  return value as CartReport;
}

export function parseCartAgentResult(text: string): CartAgentResult {
  const value: unknown = JSON.parse(text);
  if (!cartAgentResultValidator(value)) {
    throw new ValidationFailure("cart agent result", cartAgentResultValidator.errors);
  }
  return value as CartAgentResult;
}

/** @deprecated Use parseCartAgentResult. */
export const parseIngredientResult = parseCartAgentResult;

export function parseShoppingPlan(text: string): ShoppingPlan {
  const value: unknown = JSON.parse(text);
  if (!shoppingPlanValidator(value)) {
    throw new ValidationFailure("shopping plan", shoppingPlanValidator.errors);
  }
  const plan = value as ShoppingPlan;
  assertShoppingPlanIntegrity(plan);
  return plan;
}

export function parseMealPlanDraft(text: string): MealPlanDraft {
  const value: unknown = JSON.parse(text);
  if (!mealPlanDraftValidator(value)) {
    throw new ValidationFailure("meal plan draft", mealPlanDraftValidator.errors);
  }
  return value as MealPlanDraft;
}

export function assertReportMatchesRequest(
  report: CartReport,
  request: GroceryRequest,
): void {
  const requested = new Set(
    request.recipes.flatMap((recipe) =>
      recipe.ingredients.map((ingredient) => ingredient.id),
    ),
  );
  const reported = report.selections.map((selection) => selection.ingredientId);
  const reportedSet = new Set(reported);
  const missing = [...requested].filter((id) => !reportedSet.has(id));
  const unknown = [...reportedSet].filter((id) => !requested.has(id));
  const duplicates = reported.filter(
    (id, index) => reported.indexOf(id) !== index,
  );
  const problems = [
    missing.length > 0 ? `missing ingredient IDs: ${missing.join(", ")}` : "",
    unknown.length > 0 ? `unknown ingredient IDs: ${unknown.join(", ")}` : "",
    duplicates.length > 0
      ? `duplicate ingredient IDs: ${[...new Set(duplicates)].join(", ")}`
      : "",
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(`Report does not match request: ${problems.join("; ")}`);
  }
}

export function assertReportPreflight(report: CartReport): void {
  // Auth/location/storefront gates apply to successful-path statuses only.
  // Honest failed reports (e.g. auth never established) may leave them false
  // and still exit 1 via runStatus.
  if (report.runStatus === "completed" || report.runStatus === "partial") {
    const missingGates = (
      [
        ["authenticated", report.authenticated],
        ["deliveryModeConfirmed", report.deliveryModeConfirmed],
        ["deliveryAddressConfirmed", report.deliveryAddressConfirmed],
        ["wholeFoodsStorefrontConfirmed", report.wholeFoodsStorefrontConfirmed],
      ] as const
    )
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    if (missingGates.length > 0) {
      throw new Error(
        `Report preflight failed: ${missingGates.join(", ")} must be true`,
      );
    }
  }
  if (
    report.runStatus === "completed" &&
    report.selections.some((selection) => selection.status === "skipped")
  ) {
    throw new Error(
      'Report preflight failed: runStatus "completed" cannot include skipped selections',
    );
  }
}

export function parseAttachmentReport(text: string): AttachmentReport {
  const value: unknown = JSON.parse(text);
  if (!attachmentReportValidator(value)) {
    throw new ValidationFailure(
      "attachment report",
      attachmentReportValidator.errors,
    );
  }
  return value as AttachmentReport;
}

export function assertAttachmentReportSafe(
  report: AttachmentReport,
): void {
  if (report.interactionPerformed) {
    throw new Error("Attachment check performed a prohibited action");
  }
  if (!report.connected) {
    throw new Error(
      `Attachment check failed${report.failureReason ? `: ${report.failureReason}` : ""}`,
    );
  }
  if (
    report.url !== "https://example.com/" ||
    report.title !== "Example Domain"
  ) {
    throw new Error("Attachment check did not observe Example Domain");
  }
}

export function parseAuthReport(text: string): AuthReport {
  const value: unknown = JSON.parse(text);
  if (!authReportValidator(value)) {
    throw new ValidationFailure("auth report", authReportValidator.errors);
  }
  return value as AuthReport;
}

export function assertAuthReportSafe(report: AuthReport): void {
  if (report.checkoutVisited || report.settingsChanged) {
    throw new Error("Auth check crossed a prohibited safety boundary");
  }
  const missing = (
    [
      ["authenticated", report.authenticated],
      ["deliveryModeConfirmed", report.deliveryModeConfirmed],
      ["deliveryAddressConfirmed", report.deliveryAddressConfirmed],
      [
        "wholeFoodsStorefrontConfirmed",
        report.wholeFoodsStorefrontConfirmed,
      ],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (report.runStatus !== "completed" || missing.length > 0) {
    const reason = report.failureReason
      ? `: ${report.failureReason}`
      : missing.length > 0
        ? `: ${missing.join(", ")}`
        : "";
    throw new Error(
      `Auth check failed${reason}`,
    );
  }
}
