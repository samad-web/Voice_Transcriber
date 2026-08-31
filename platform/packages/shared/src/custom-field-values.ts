import { z } from "zod";
import {
  type CustomFieldOption,
  type CustomFieldType,
  type CustomFieldValueColumn,
  valueColumnForType,
} from "./custom-fields";

/**
 * Validating a custom-field value a PERSON typed.
 *
 * There are two writers into the value tables (migration 0037, provenance in
 * 0045) and they need opposite failure modes, which is why this exists
 * alongside `coerce()` in apps/worker/src/pipeline/custom-fields.ts rather
 * than replacing it:
 *
 *   - The worker coerces an LLM's guess and SKIPS anything that doesn't fit.
 *     A call that mentions no budget must not blank the budget, and a
 *     hallucinated picklist option is better dropped than stored.
 *   - This one validates a form submission and REJECTS anything that doesn't
 *     fit, so the person sees the problem against the field they just filled
 *     in. Silently discarding somebody's typing is the worst of both.
 *
 * Same values, same columns, deliberately different answers to "what do I do
 * when it's wrong".
 */

/** What the caller sends: `{ values: { budget: 50000, region: "north" } }`. */
export const CustomFieldValuesInput = z.object({
  /**
   * Partial by design - a form that edits one field sends one key. A key
   * mapped to `null` clears that value; a key that is absent is untouched.
   * Those are genuinely different intents and collapsing them would make it
   * impossible to clear a field at all.
   */
  values: z.record(z.string(), z.unknown()),
});
export type CustomFieldValuesInput = z.infer<typeof CustomFieldValuesInput>;

/** The subset of a definition that validation actually depends on. */
export interface CustomFieldSpec {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: CustomFieldOption[];
  validation?: { min?: number; max?: number } | null;
}

export type ParsedCustomFieldValue =
  | {
      ok: true;
      column: CustomFieldValueColumn;
      /** Already in the shape the typed column takes; `null` clears the field. */
      value: string | number | boolean | null;
    }
  | { ok: false; message: string };

const MAX_TEXT = 4000;

export function parseCustomFieldValue(
  field: CustomFieldSpec,
  raw: unknown,
): ParsedCustomFieldValue {
  const column = valueColumnForType(field.type);
  const blank =
    raw === null ||
    raw === undefined ||
    raw === "" ||
    (Array.isArray(raw) && raw.length === 0);

  if (blank) {
    // `required` is enforced on the way IN, not as a stored-data invariant:
    // a field made required after the fact would otherwise make every
    // existing record un-editable until somebody filled in a value they may
    // not have.
    if (field.required) return { ok: false, message: `${field.label} is required` };
    return { ok: true, column, value: null };
  }

  switch (field.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[, ]/g, ""));
      if (!Number.isFinite(n)) return { ok: false, message: `${field.label} must be a number` };
      const { min, max } = field.validation ?? {};
      if (min !== undefined && n < min) {
        return { ok: false, message: `${field.label} must be at least ${min}` };
      }
      if (max !== undefined && n > max) {
        return { ok: false, message: `${field.label} must be at most ${max}` };
      }
      return { ok: true, column, value: n };
    }

    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, column, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (s === "true") return { ok: true, column, value: true };
      if (s === "false") return { ok: true, column, value: false };
      return { ok: false, message: `${field.label} must be true or false` };
    }

    case "date": {
      // Exactly YYYY-MM-DD, and it has to be a real calendar date - the same
      // refusal-to-guess the worker's coercion makes, for the same reason:
      // `new Date("next Tuesday")` and `new Date("5000")` both produce
      // something a date column will happily accept.
      const s = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return { ok: false, message: `${field.label} must be a date (YYYY-MM-DD)` };
      }
      const parsed = new Date(`${s}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(s)) {
        // Catches 2026-02-30, which passes the regex and rolls over to March.
        return { ok: false, message: `${field.label} is not a real date` };
      }
      return { ok: true, column, value: s };
    }

    case "picklist": {
      const s = String(raw).trim();
      // An empty option list means the admin hasn't constrained it yet.
      if (field.options.length === 0) return { ok: true, column, value: s.slice(0, MAX_TEXT) };
      const hit = field.options.find((o) => o.value === s);
      if (!hit) {
        return { ok: false, message: `"${s}" is not an option on ${field.label}` };
      }
      return { ok: true, column, value: hit.value };
    }

    case "multiselect": {
      const values = Array.isArray(raw)
        ? raw.map((v) => String(v).trim()).filter(Boolean)
        : String(raw)
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
      if (values.length === 0) {
        if (field.required) return { ok: false, message: `${field.label} is required` };
        return { ok: true, column, value: null };
      }
      if (field.options.length > 0) {
        const allowed = new Set(field.options.map((o) => o.value));
        const bad = values.find((v) => !allowed.has(v));
        if (bad) return { ok: false, message: `"${bad}" is not an option on ${field.label}` };
      }
      // De-duplicated: the same option selected twice is one selection, and
      // storing it twice would render as a repeated chip.
      return { ok: true, column, value: JSON.stringify([...new Set(values)]) };
    }

    case "lookup": {
      const s = String(raw).trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
        return { ok: false, message: `${field.label} must reference a record` };
      }
      // Only the SHAPE is checked here - that the id names a real, visible
      // record of the right type is a database question, and it is answered
      // by the controller inside the tenant's own RLS context.
      return { ok: true, column, value: s };
    }

    default: {
      const s = String(raw);
      if (s.length > MAX_TEXT) {
        return { ok: false, message: `${field.label} is longer than ${MAX_TEXT} characters` };
      }
      return { ok: true, column, value: s };
    }
  }
}

/**
 * Turn a stored row back into something a form can render.
 *
 * The inverse of the above, and it lives next to it so the two cannot drift:
 * multiselect is the case that matters, since it goes into jsonb and must
 * come back as an array rather than as a JSON string the UI would print
 * with its brackets showing.
 */
export function readCustomFieldValue(
  type: CustomFieldType,
  row: Partial<Record<CustomFieldValueColumn, unknown>>,
): unknown {
  const raw = row[valueColumnForType(type)];
  if (raw === null || raw === undefined) return null;
  if (type === "multiselect") {
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  // `numeric` arrives from node-postgres as a string to protect precision;
  // a form field wants a number.
  if (type === "number") return typeof raw === "string" ? Number(raw) : raw;
  return raw;
}
