import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { CartReport, GroceryRequest } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });

const compile = (relativePath: string): ValidateFunction => {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return ajv.compile(JSON.parse(readFileSync(path, "utf8")));
};

const requestValidator = compile("../schemas/request.schema.json");
const reportValidator = compile("../schemas/report.schema.json");

const formatErrors = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");

export class ValidationFailure extends Error {
  constructor(kind: "request" | "report", errors: ErrorObject[] | null | undefined) {
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
        ["expectedLocationConfirmed", report.expectedLocationConfirmed],
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
