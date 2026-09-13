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

export function loadRequest(path: string): GroceryRequest {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!requestValidator(value)) {
    throw new ValidationFailure("request", requestValidator.errors);
  }
  return value as GroceryRequest;
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
