import { z } from "zod";

/**
 * Org-definable fields on Contact/Account/Deal (packages/db/migrations/0037).
 *
 * Generalises two existing precedents rather than inventing a third: the
 * field-DEFINITION shape from ExtractionField (extraction.ts), and
 * call_facts' typed-EAV VALUE storage (see the migration's own comment).
 */

export const CustomFieldObjectType = z.enum(["contact", "account", "deal"]);
export type CustomFieldObjectType = z.infer<typeof CustomFieldObjectType>;

export const CustomFieldType = z.enum([
  "text",
  "number",
  "date",
  "boolean",
  "picklist",
  "multiselect",
  "lookup",
]);
export type CustomFieldType = z.infer<typeof CustomFieldType>;

export const CustomFieldOption = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(120),
});
export type CustomFieldOption = z.infer<typeof CustomFieldOption>;

/**
 * What an admin submits to define a field. Same key rule as
 * ExtractionField.key — both eventually address a value by a snake_case
 * identifier, one in an LLM's JSON output, the other in a form field name.
 */
export const CustomFieldDefinitionInput = z
  .object({
    objectType: CustomFieldObjectType,
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier required")
      .max(64),
    label: z.string().min(1).max(120),
    type: CustomFieldType,
    description: z.string().max(500).optional(),
    required: z.boolean().default(false),
    options: z.array(CustomFieldOption).max(64).default([]),
    lookupObjectType: CustomFieldObjectType.optional(),
    validation: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
    sortOrder: z.number().int().default(0),
  })
  /**
   * Same class of trap ExtractionField.superRefine guards against: a
   * picklist/multiselect with no options can never be filled in, and a
   * lookup with no target object silently fails wherever it is rendered
   * instead of failing here, against the row the author is looking at.
   */
  .superRefine((field, ctx) => {
    if ((field.type === "picklist" || field.type === "multiselect") && field.options.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `"${field.label}" is a ${field.type} field with no options — it can never be filled in`,
      });
    }
    if (field.type === "lookup" && !field.lookupObjectType) {
      ctx.addIssue({
        code: "custom",
        path: ["lookupObjectType"],
        message: `"${field.label}" is a lookup field but doesn't say what object it looks up`,
      });
    }
  });
export type CustomFieldDefinitionInput = z.infer<typeof CustomFieldDefinitionInput>;

export type CustomFieldValueColumn = "value_text" | "value_num" | "value_bool" | "value_date" | "value_json";

/** Which typed column a value lands in — mirrors call_facts' projection rule. */
export function valueColumnForType(type: CustomFieldType): CustomFieldValueColumn {
  switch (type) {
    case "number":
      return "value_num";
    case "boolean":
      return "value_bool";
    case "date":
      return "value_date";
    case "multiselect":
      return "value_json";
    default:
      return "value_text";
  }
}

/** contact|account|deal -> the value table that stores it (0037). */
export function valueTableForObjectType(objectType: CustomFieldObjectType): string {
  return `${objectType}_custom_field_values`;
}

/** contact|account|deal -> the FK column name on that value table. */
export function valueTableIdColumn(objectType: CustomFieldObjectType): string {
  return `${objectType}_id`;
}
