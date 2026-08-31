import { z } from "zod";

/**
 * Dynamic extraction schema - deliberately constrained (design doc §7):
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

export const ExtractionField = z
  .object({
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
  })
  /**
   * An enum with no options is unsatisfiable, so it is rejected where the agent
   * author can still do something about it.
   *
   * Left through, it compiles to `{ enum: [] }` and validates against an empty
   * list: EVERY call for that agent then validates as failed, and the default
   * lead rules treat a failed validation as "not a lead" (leads.ts). One
   * un-filled dropdown in the agent editor and the tenant's board goes silently
   * dry - no error, no failed call, just nothing arriving. The message names the
   * field because the editor shows it against that row.
   */
  .superRefine((field, ctx) => {
    if (field.type === "enum" && (field.enumValues?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["enumValues"],
        message: `enum field "${field.key}" must list at least one option - an enum with no options can never be satisfied, so every call for this agent would fail validation`,
      });
    }
  });
export type ExtractionField = z.infer<typeof ExtractionField>;

export const ExtractionSchema = z.object({
  fields: z.array(ExtractionField).max(64),
});
export type ExtractionSchema = z.infer<typeof ExtractionSchema>;

/**
 * The same schema, for reading an agent version that was STORED before the rule
 * above existed.
 *
 * Agents are versioned and immutable (entities.ts), so a saved version cannot be
 * corrected in place - and a call being analysed months later must not blow up
 * on a config that was legal when it was written. Reading therefore degrades an
 * optionless enum to an unconstrained string instead of throwing: the field
 * stops being a validation trap and starts collecting whatever the caller
 * actually said, which is what the author meant by leaving the options blank.
 * Nothing else about the stored version is altered.
 *
 * Use this for anything loaded out of `agents.field_schema`; use
 * ExtractionSchema for anything an author is submitting.
 */
export const StoredExtractionSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null) return raw;
  const fields = (raw as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return raw;
  return {
    ...raw,
    fields: fields.map((field) => {
      if (typeof field !== "object" || field === null) return field;
      const f = field as { type?: unknown; enumValues?: unknown };
      const options = Array.isArray(f.enumValues) ? f.enumValues : [];
      return f.type === "enum" && options.length === 0 ? { ...f, type: "string" } : field;
    }),
  };
}, ExtractionSchema);

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
 * ISO-8601 calendar date, optionally with a time and an offset.
 *
 * `Date.parse` alone is not this check, despite reading like it: it accepts a
 * bare year, so a model that answers `quotation_date` with the QUANTITY -
 * "5000" - validated cleanly and landed in the customer's CRM as the year 5000.
 * The shape is asserted first and `Date.parse` only confirms the components are
 * a real date ("2026-13-01" matches the shape and is not a date).
 *
 * Deliberately permissive about what a model legitimately returns: date-only,
 * seconds omitted, fractional seconds, offset present or absent, and a space in
 * place of the "T" (RFC 3339 §5.6 allows it and models emit it). All of those
 * are unambiguous dates; a bare number is not.
 */
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function isIsoDateTime(value: unknown): boolean {
  return typeof value === "string" && ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Runtime validator - consumer (b) of the single field definition. Returns a
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
        if (!isIsoDateTime(value)) {
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
