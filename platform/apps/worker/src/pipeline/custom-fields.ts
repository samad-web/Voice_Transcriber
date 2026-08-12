import {
  type CustomFieldObjectType,
  type CustomFieldType,
  valueColumnForType,
  valueTableForObjectType,
  valueTableIdColumn,
} from "@aura/shared";
import type { DbClient } from "./crm-dispatch";

/**
 * Project a record's raw `facts` blob into typed custom-field values
 * (packages/db/migrations/0037) — Track A4.
 *
 * Until now the AI extraction only ever reached the new object model as an
 * untyped jsonb blob; a field an admin had defined in /custom-fields stayed
 * empty unless the one-time backfill happened to run. This closes that: every
 * completed call writes the typed value alongside the blob, so the definition
 * an admin created is actually populated by the pipeline that produces the
 * data.
 *
 * ADDITIVE, like every other write in this projection: a value is written
 * only when the extraction produced one. A call that fails to mention the
 * budget must not blank the budget an earlier call established, so there is
 * no path here that writes NULL over an existing value.
 *
 * WORTH KNOWING when a value-EDITING UI lands: today nothing but this
 * function writes these tables, so "newest extraction wins" is unambiguous.
 * The moment a human can type into one, this needs the same human-owns-it
 * guard that keeps upsertLead off `stage`/`status`.
 */

interface FieldDefinition {
  id: string;
  key: string;
  type: string;
  options: Array<{ value: string; label: string }> | null;
}

export interface CustomFieldProjection {
  written: number;
  skipped: number;
}

export async function projectFactsToCustomFields(
  client: DbClient,
  orgId: string,
  objectType: CustomFieldObjectType,
  recordId: string,
  facts: Record<string, unknown>,
): Promise<CustomFieldProjection> {
  const keys = Object.keys(facts ?? {});
  if (keys.length === 0) return { written: 0, skipped: 0 };

  // Only fields this org actually defined, and only those the extraction
  // produced a key for — so an org with no custom fields costs exactly one
  // indexed lookup that returns nothing.
  const { rows: definitions } = await client.query<FieldDefinition>(
    `SELECT id, key, type, options
       FROM custom_field_definitions
      WHERE org_id = $1 AND object_type = $2 AND status = 'active' AND key = ANY($3::text[])`,
    [orgId, objectType, keys],
  );
  if (definitions.length === 0) return { written: 0, skipped: 0 };

  const table = valueTableForObjectType(objectType);
  const idColumn = valueTableIdColumn(objectType);

  let written = 0;
  let skipped = 0;

  for (const definition of definitions) {
    const coerced = coerce(facts[definition.key], definition);
    if (coerced === undefined) {
      skipped++;
      continue;
    }

    const column = valueColumnForType(definition.type as CustomFieldType);
    // The column name comes from valueColumnForType's closed switch and the
    // table from the object type, never from caller input — no interpolation
    // of anything a tenant controls.
    await client.query(
      `INSERT INTO ${table} (org_id, ${idColumn}, field_id, ${column})
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (${idColumn}, field_id)
       DO UPDATE SET ${column} = EXCLUDED.${column}`,
      [orgId, recordId, definition.id, coerced],
    );
    written++;
  }

  return { written, skipped };
}

/**
 * Turn one raw extracted fact into something the field's typed column will
 * accept, or `undefined` to skip it.
 *
 * Skipping is the right failure mode throughout: the extraction is an LLM's
 * best guess, and a value that does not fit the admin's declared type is
 * better absent than stored wrong — a number column holding NaN or a picklist
 * holding an option that is not on the list would both surface as a broken
 * field in the UI rather than as missing data.
 */
function coerce(raw: unknown, definition: FieldDefinition): unknown {
  if (raw === null || raw === undefined || raw === "") return undefined;

  switch (definition.type as CustomFieldType) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[, ]/g, ""));
      return Number.isFinite(n) ? n : undefined;
    }

    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return true;
      if (["false", "no", "n", "0"].includes(s)) return false;
      return undefined;
    }

    case "date": {
      // Only ISO-ish dates. Deliberately NOT `new Date(str)`, which happily
      // reads "next Tuesday" as Invalid Date and "5000" as the year 5000 —
      // both of which would land silently in a date column.
      const s = String(raw).trim();
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (!match) return undefined;
      const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
    }

    case "picklist": {
      const s = String(raw).trim();
      const options = definition.options ?? [];
      // An empty option list means the admin has not constrained it yet;
      // anything else must actually be on the list.
      if (options.length === 0) return s;
      const hit = options.find(
        (o) => o.value.toLowerCase() === s.toLowerCase() || o.label.toLowerCase() === s.toLowerCase(),
      );
      return hit ? hit.value : undefined;
    }

    case "multiselect": {
      const values = Array.isArray(raw)
        ? raw.map((v) => String(v).trim())
        : String(raw)
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
      if (values.length === 0) return undefined;
      const options = definition.options ?? [];
      const allowed =
        options.length === 0
          ? values
          : values
              .map((v) => options.find((o) => o.value.toLowerCase() === v.toLowerCase())?.value)
              .filter((v): v is string => Boolean(v));
      return allowed.length > 0 ? JSON.stringify(allowed) : undefined;
    }

    case "lookup":
      // A lookup points at another record by id, and an extraction produces
      // prose. Resolving "the Acme account" to a uuid is a matching problem
      // (A5's territory), not a coercion one.
      return undefined;

    default:
      return String(raw);
  }
}
