/**
 * Everything that points at a contact or an account, and how a merge moves it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A merge used to repoint `deals` and nothing else (doc 23, D1). Every other
 * row naming the merged-away record - its calls and emails on the timeline,
 * its tasks, WhatsApp threads, quotations, invoices, outreach journeys, tags,
 * custom-field values - stayed on the tombstone. The survivor's page showed
 * none of it, and because list pages hide merged records, that history became
 * reachable only by id. Merging two ACCOUNTS left every contact at the company
 * filed under the dead one.
 *
 * ── HOW IT STAYS COMPLETE ───────────────────────────────────────────────────
 *
 * MERGE_REFERENCES is the full list, and merge-references.spec.ts reads every
 * `REFERENCES contacts(` / `REFERENCES accounts(` out of packages/db/migrations
 * and fails unless each one is either here or in NOT_REPOINTED with a reason.
 * A migration that adds a new reference therefore cannot reopen this gap
 * without a test naming it.
 *
 * ── REVERSIBLE ──────────────────────────────────────────────────────────────
 *
 * Every row moved is recorded (merge_log.reassigned_refs, migration 0105), and
 * every row a conflict forced out is kept whole (merge_log.dropped_refs), so a
 * revert inside the window puts the victim back exactly as it was.
 */

export type MergeObjectType = "contact" | "account";

type Queryable = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};

/**
 * How one referencing column is moved.
 *
 *   simple    - the table has an `id`; move every row, record the ids.
 *   pair      - the column is half of a composite key with `key`; where the
 *               survivor already holds the same key the victim's row is
 *               dropped (the survivor's own value wins), the rest move.
 *   scored    - lead_score_events: unique on (contact_id, action, source_id),
 *               so a score both records earned from the same source is kept
 *               once, on the survivor.
 *   journeys  - outreach_journeys: one ACTIVE journey per contact per cadence,
 *               so a victim journey that would collide is stopped, not moved.
 */
export interface MergeReference {
  table: string;
  column: string;
  kind: "simple" | "pair" | "scored" | "journeys";
  /** The other half of the composite key, for `pair`. */
  key?: string;
}

export const MERGE_REFERENCES: Record<MergeObjectType, MergeReference[]> = {
  contact: [
    { table: "deals", column: "contact_id", kind: "simple" },
    { table: "interactions", column: "contact_id", kind: "simple" },
    { table: "tasks", column: "contact_id", kind: "simple" },
    { table: "conversations", column: "contact_id", kind: "simple" },
    { table: "quotations", column: "contact_id", kind: "simple" },
    { table: "invoices", column: "contact_id", kind: "simple" },
    { table: "notifications", column: "contact_id", kind: "simple" },
    { table: "lead_intake_events", column: "contact_id", kind: "simple" },
    { table: "meta_leadgen_events", column: "contact_id", kind: "simple" },
    { table: "crm_reconciliation_log", column: "contact_id", kind: "simple" },
    { table: "outreach_journeys", column: "contact_id", kind: "journeys" },
    { table: "lead_score_events", column: "contact_id", kind: "scored" },
    { table: "contact_tags", column: "contact_id", kind: "pair", key: "tag_id" },
    { table: "contact_custom_field_values", column: "contact_id", kind: "pair", key: "field_id" },
  ],
  account: [
    { table: "contacts", column: "account_id", kind: "simple" },
    { table: "deals", column: "account_id", kind: "simple" },
    { table: "tasks", column: "account_id", kind: "simple" },
    { table: "quotations", column: "account_id", kind: "simple" },
    { table: "invoices", column: "account_id", kind: "simple" },
    { table: "interactions", column: "account_id", kind: "simple" },
    { table: "account_custom_field_values", column: "account_id", kind: "pair", key: "field_id" },
  ],
};

/** References a merge deliberately leaves alone, each with the reason. */
export const NOT_REPOINTED: Record<MergeObjectType, { table: string; column: string; reason: string }[]> = {
  contact: [
    {
      table: "contacts",
      column: "merged_into_id",
      reason: "earlier tombstones keep pointing at the record they merged into; lookups follow the chain",
    },
  ],
  account: [
    {
      table: "accounts",
      column: "merged_into_id",
      reason: "earlier tombstones keep pointing at the record they merged into; lookups follow the chain",
    },
  ],
};

/** `table.column` -> moved ids (simple/scored/journeys) or moved keys (pair). */
export type ReassignedRefs = Record<string, string[]>;
/** `table.column` -> whole rows removed or stopped because of a conflict. */
export type DroppedRefs = Record<string, Record<string, unknown>[]>;

const refKey = (ref: MergeReference) => `${ref.table}.${ref.column}`;

/**
 * Move every reference from `victimId` to `survivorId`. Runs inside the merge's
 * transaction; the caller has already locked both records.
 */
export async function repointReferences(
  client: Queryable,
  objectType: MergeObjectType,
  survivorId: string,
  victimId: string,
): Promise<{ reassigned: ReassignedRefs; dropped: DroppedRefs }> {
  const reassigned: ReassignedRefs = {};
  const dropped: DroppedRefs = {};

  for (const ref of MERGE_REFERENCES[objectType]) {
    const { table, column } = ref;
    const key = refKey(ref);

    if (ref.kind === "pair") {
      // The survivor's own row for the same tag/field wins; the victim's copy
      // is kept whole so a revert can put it back.
      const { rows: clashes } = await client.query<Record<string, unknown>>(
        `DELETE FROM ${table} v
          WHERE v.${column} = $2
            AND EXISTS (SELECT 1 FROM ${table} s WHERE s.${column} = $1 AND s.${ref.key} = v.${ref.key})
        RETURNING v.*`,
        [survivorId, victimId],
      );
      if (clashes.length > 0) dropped[key] = clashes;
      const { rows: moved } = await client.query<{ k: string }>(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2 RETURNING ${ref.key} AS k`,
        [survivorId, victimId],
      );
      if (moved.length > 0) reassigned[key] = moved.map((r) => r.k);
      continue;
    }

    if (ref.kind === "scored") {
      const { rows: clashes } = await client.query<Record<string, unknown>>(
        `DELETE FROM lead_score_events v
          WHERE v.contact_id = $2 AND v.source_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM lead_score_events s
               WHERE s.contact_id = $1 AND s.action = v.action AND s.source_id = v.source_id)
        RETURNING v.*`,
        [survivorId, victimId],
      );
      if (clashes.length > 0) dropped[key] = clashes;
    }

    if (ref.kind === "journeys") {
      // Two people chased on the same cadence are one person chased twice once
      // merged, so the victim's colliding journey stops rather than doubling
      // every step. Its prior state is kept for a revert.
      const { rows: stopped } = await client.query<Record<string, unknown>>(
        `WITH clash AS (
           SELECT v.* FROM outreach_journeys v
            WHERE v.contact_id = $2 AND v.status = 'active'
              AND EXISTS (
                SELECT 1 FROM outreach_journeys s
                 WHERE s.contact_id = $1 AND s.cadence_id = v.cadence_id AND s.status = 'active')
         )
         UPDATE outreach_journeys j
            SET status = 'stopped', stop_reason = 'merged into another contact', completed_at = now()
           FROM clash
          WHERE j.id = clash.id
        RETURNING clash.*`,
        [survivorId, victimId],
      );
      if (stopped.length > 0) dropped[key] = stopped;
    }

    const { rows: moved } = await client.query<{ id: string }>(
      `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2 RETURNING id`,
      [survivorId, victimId],
    );
    if (moved.length > 0) reassigned[key] = moved.map((r) => r.id);
  }

  return { reassigned, dropped };
}

/**
 * Undo `repointReferences`: move recorded rows back, then restore what a
 * conflict removed or stopped. Only rows STILL on the survivor move back, so a
 * reference someone re-pointed by hand since the merge is left where they put it.
 */
export async function restoreReferences(
  client: Queryable,
  objectType: MergeObjectType,
  survivorId: string,
  victimId: string,
  reassigned: ReassignedRefs,
  dropped: DroppedRefs,
): Promise<void> {
  for (const ref of MERGE_REFERENCES[objectType]) {
    const { table, column } = ref;
    const key = refKey(ref);
    const moved = reassigned[key] ?? [];

    if (moved.length > 0) {
      if (ref.kind === "pair") {
        await client.query(
          `UPDATE ${table} SET ${column} = $1
            WHERE ${column} = $2 AND ${ref.key}::text = ANY($3::text[])`,
          [victimId, survivorId, moved],
        );
      } else {
        await client.query(
          `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2 AND id = ANY($3::uuid[])`,
          [victimId, survivorId, moved],
        );
      }
    }

    const removed = dropped[key] ?? [];
    if (removed.length === 0) continue;

    if (ref.kind === "journeys") {
      // Restart only journeys the merge stopped and nobody has touched since.
      await client.query(
        `UPDATE outreach_journeys
            SET status = 'active', stop_reason = NULL, completed_at = NULL
          WHERE id = ANY($1::uuid[]) AND status = 'stopped' AND stop_reason = 'merged into another contact'`,
        [removed.map((row) => row.id)],
      );
    } else {
      // `pair` and `scored` rows were deleted; put them back as they were.
      await client.query(
        `INSERT INTO ${table}
         SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)
         ON CONFLICT DO NOTHING`,
        [JSON.stringify(removed)],
      );
    }
  }
}
