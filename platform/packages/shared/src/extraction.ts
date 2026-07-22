import { z } from "zod";

/**
 * Dynamic extraction schema — deliberately constrained (design doc §7):
 * scalar types, enums, arrays of scalars, one nesting level maximum.
 * One definition drives the LLM schema, the validator, the call_facts
 * projection, and the web UI columns.
 */
export const ExtractionFieldType = z.enum([
  "string",
  "number",
  "boolean",
  "enum",
  "datetime",
  "string[]",
]);
export type ExtractionFieldType = z.infer<typeof ExtractionFieldType>;

export const ExtractionField = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier required")
    .max(64),
  type: ExtractionFieldType,
  description: z.string().max(500),
  required: z.boolean().default(false),
  enumValues: z.array(z.string().max(100)).max(32).optional(),
  validation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .optional(),
});
export type ExtractionField = z.infer<typeof ExtractionField>;

export const ExtractionSchema = z.object({
  fields: z.array(ExtractionField).max(64),
});
export type ExtractionSchema = z.infer<typeof ExtractionSchema>;

/** Compile the tenant-defined fields into a JSON Schema for LLM structured output. */
export function compileToJsonSchema(schema: ExtractionSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of schema.fields) {
    let prop: Record<string, unknown>;
    switch (field.type) {
      case "number":
        prop = { type: "number" };
        break;
      case "boolean":
        prop = { type: "boolean" };
        break;
      case "enum":
        prop = { type: "string", enum: field.enumValues ?? [] };
        break;
      case "datetime":
        prop = { type: "string", format: "date-time" };
        break;
      case "string[]":
        prop = { type: "array", items: { type: "string" } };
        break;
      default:
        prop = { type: "string" };
    }
    prop.description = field.description;
    properties[field.key] = prop;
    if (field.required) required.push(field.key);
  }

  return { type: "object", properties, required };
}

/**
 * Runtime validator — consumer (b) of the single field definition. Returns a
 * list of problems; empty means valid. Used by the analyze stage (with one
 * repair attempt on failure) and by the agent test endpoint.
 */
export function validateExtraction(
  schema: ExtractionSchema,
  output: unknown,
): string[] {
  const errors: string[] = [];
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return ["output is not a JSON object"];
  }
  const record = output as Record<string, unknown>;

  for (const field of schema.fields) {
    const value = record[field.key];
    if (value === undefined || value === null) {
      if (field.required) errors.push(`missing required field "${field.key}"`);
      continue;
    }
    switch (field.type) {
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) {
          errors.push(`"${field.key}" must be a number`);
        } else {
          if (field.validation?.min !== undefined && value < field.validation.min)
            errors.push(`"${field.key}" below min ${field.validation.min}`);
          if (field.validation?.max !== undefined && value > field.validation.max)
            errors.push(`"${field.key}" above max ${field.validation.max}`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") errors.push(`"${field.key}" must be a boolean`);
        break;
      case "enum":
        if (typeof value !== "string" || !(field.enumValues ?? []).includes(value)) {
          errors.push(
            `"${field.key}" must be one of: ${(field.enumValues ?? []).join(", ")}`,
          );
        }
        break;
      case "datetime":
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
          errors.push(`"${field.key}" must be an ISO datetime string`);
        }
        break;
      case "string[]":
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
          errors.push(`"${field.key}" must be an array of strings`);
        }
        break;
      default:
        if (typeof value !== "string") errors.push(`"${field.key}" must be a string`);
    }
  }
  return errors;
}
