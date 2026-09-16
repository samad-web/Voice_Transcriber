/**
 * Point many records at one new owner in a single statement - the list views'
 * "Reassign" bulk action (CRM dashboard, Phase 5).
 *
 * ── WHAT THE CALLER MUST ALREADY HAVE DONE ──────────────────────────────────
 *
 * Inside the same `withOrg` transaction, BEFORE calling this:
 *   - `assertInOrg` over the ids, and `assertMembers` / `assertInOrg` over the
 *     new owner (org-references.ts). Foreign keys ignore RLS, and `users` has
 *     none, so this helper never trusts an id it was handed.
 *   - resolved the caller's record scope into `owned`. It is ANDed into the
 *     UPDATE itself, not checked beforehand: a scoped rep who lists a
 *     colleague's ids matches no row for them, and the response only counts
 *     how many were skipped.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TOUCH ─────────────────────────────────────
 *
 * `last_activity_at`. The single-record PATCH routes bump it because an edit
 * there is somebody working the record; reassigning a pile of them is
 * administration, and bumping it would clear every stale-deal flag (0106) on
 * exactly the deals a manager is redistributing BECAUSE they went stale.
 *
 * Table, column and filter SQL come from the call sites, never the request.
 */

type Queryable = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};

export interface BulkAssignSpec {
  orgId: string;
  table: "contacts" | "deals" | "tasks" | "leads";
  /** The owner column being set. */
  column: "owner_user_id" | "assignee_user_id" | "assigned_telecaller_id";
  /** The new owner, or null to clear. Already verified by the caller. */
  value: string | null;
  ids: string[];
  /** Extra fixed predicate on `r`, e.g. excluding merged contacts. */
  extra?: string | null;
  /** The caller's record scope, from scopeFilter/ownerScopeFilter with alias "r". */
  owned?: { sql: string; value: string } | null;
  /** audit_log row per record. */
  audit: { targetType: "contact" | "deal" | "task" | "lead"; action: string; actorId: string };
}

/** Returns the ids actually reassigned - the caller reports the rest as skipped. */
export async function assignInBulk(client: Queryable, spec: BulkAssignSpec): Promise<string[]> {
  const params: unknown[] = [spec.orgId, spec.ids, spec.value];
  const where = ["r.org_id = $1", "r.id = ANY($2::uuid[])"];
  if (spec.extra) where.push(spec.extra);
  if (spec.owned) {
    params.push(spec.owned.value);
    // Global replace: the task and lead scope clauses carry two placeholders
    // bound to the same value (crm-scope.ts, owner-scope.ts).
    where.push(spec.owned.sql.replace(/\$\?/g, `$${params.length}`));
  }

  const { rows } = await client.query<{ id: string }>(
    `UPDATE ${spec.table} r SET ${spec.column} = $3::uuid
      WHERE ${where.join(" AND ")}
      RETURNING r.id`,
    params,
  );
  const updated = rows.map((row) => row.id);

  if (updated.length > 0) {
    // One audit row per record, like the single PATCH writes - "who moved
    // this contact to Ravi" must be answerable per contact, not per click.
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       SELECT $1, 'user', $2, $3, $4, t.id::text, $5::jsonb
         FROM unnest($6::uuid[]) AS t(id)`,
      [
        spec.orgId,
        spec.audit.actorId,
        spec.audit.action,
        spec.audit.targetType,
        JSON.stringify({ [spec.column]: spec.value, bulk: true, selected: spec.ids.length }),
        updated,
      ],
    );
  }
  return updated;
}
