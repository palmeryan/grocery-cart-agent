import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface JsonSchema {
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  type?: unknown;
}

const outputSchemas = [
  "attachment-report.schema.json",
  "auth-report.schema.json",
  "meal-plan-draft.schema.json",
  "report.schema.json",
  "shopping-plan.schema.json",
];

const findPropertiesWithoutTypes = (
  schema: JsonSchema,
  path = "$",
): string[] => {
  const missing: string[] = [];

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const propertyPath = `${path}.properties.${name}`;
    if (property.type === undefined) missing.push(propertyPath);
    missing.push(...findPropertiesWithoutTypes(property, propertyPath));
  }

  if (schema.items) {
    missing.push(...findPropertiesWithoutTypes(schema.items, `${path}.items`));
  }

  return missing;
};

describe.each(outputSchemas)("%s", (schemaName) => {
  it("declares an explicit type for every structured-output property", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(`../schemas/${schemaName}`, import.meta.url),
        "utf8",
      ),
    ) as JsonSchema;

    expect(findPropertiesWithoutTypes(schema)).toEqual([]);
  });
});
