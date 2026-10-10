import {
  OWNER_UNSCOPED,
  type OwnerRecordScope,
  type PermissionObjectType,
  PERMISSION_OBJECT_MODULE,
  resolveOwnerRole,
  scopeForRole,
} from "@aura/shared";
import type { PoolClient } from "@aura/db";
// The SAME visibility resolver the export API uses at enqueue. Imported rather
// than reimplemented: doc 35 §4.2 only holds if both processes get the answer
// from one function - see people-visibility.ts's header.
import { resolvePeopleVisibility, visibilityAllowsTelecaller } from "@aura/db";

import type { ResolvedScope } from "./export-queries";

/**
 * Re-resolving the requester's grants inside the export worker (doc 35 SS4.2).
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * An export job has no HTTP request, so it has no guard and no `req.ownerScope`.
 * `report-schedules.ts` faces the same problem and answers it by rendering
 * UNSCOPED - its header says so plainly, and that is correct there because
 * creating a schedule is owner-only and an owner forwarding a spreadsheet is
 * the same act.
 *
 * Copying that here would be the single worst bug this feature can ship. A
 * telecaller's export must contain a telecaller's rows, and an export is not
 * owner-only. So the worker resolves the same facts the guards resolve, from
 * the same tables, with the same queries.
 *
 * ── WHY BOTH THE SNAPSHOT AND A FRESH READ ──────────────────────────────────
 *
 * `export_jobs.scope_snapshot` froze the grants at enqueue. This reads them
 * again now. The job runs under the INTERSECTION:
 *
 *   - The snapshot alone would let a job queued before a demotion run with the
 *     old, wider grant. Access revoked at 10:00, a 10:05 file still carries
 *     everything.
 *   - A fresh read alone would let a job WIDEN after a promotion, producing a
 *     file the person could not have asked for at the moment they asked.
 *
 * Intersecting is the only direction that is never surprising, and it is the
 * same "narrow, never widen" rule the persona intersection already follows.
 */

/** The half of the snapshot this module needs back. */
export interface ScopeSnapshot {
  ownerRole: string | null;
  ownerScopeKind: "all" | "own";
  telecallerId: string | null;
  userId: string | null;
  /** Grid grant per object at enqueue: 'all', 'owned', or absent = no grant. */
  grid: Record<string, "all" | "owned">;
  canExportRecordings: boolean;
  /**
   * The person a `scope: 'person'` export is about, as authorized at enqueue
   * (0188). Absent on every other scope.
   *
   * A ceiling like the rest of this snapshot, not an authorization: the worker
   * re-asks whether the requester may still see this person and refuses if the
   * answer changed. See `assertSubjectStillVisible`.
   */
  subject?: { telecallerId: string; userId: string | null } | null;
}

/**
 * The persona half, read fresh.
 *
 * The query is `owner-scope.guard.ts:112` verbatim, including its ORDER BY: a
 * person can hold an org-scope membership AND workspace-scope rows, and an
 * unordered LIMIT 1 picks a different row on a different day the moment
 * `owner_role` stops being written to all of them together.
 */
export async function readOwnerScope(
  client: PoolClient,
  userId: string,
  orgId: string,
): Promise<OwnerRecordScope> {
  const { rows } = await client.query<{ owner_role: string | null; telecaller_id: string | null }>(
    `SELECT m.owner_role, t.id AS telecaller_id
       FROM memberships m
       LEFT JOIN telecallers t
         ON t.org_id = m.org_id AND t.user_id = m.user_id AND t.status = 'active'
      WHERE m.user_id = $1 AND m.org_id = $2
      ORDER BY (m.scope_type = 'org') DESC, m.id
      LIMIT 1`,
    [userId, orgId],
  );

  // No membership means the person has left since the job was queued. Deny by
  // narrowing to an identity that matches nothing, rather than falling back to
  // OWNER_UNSCOPED the way the guard does - the guard's fallback is for a route
  // that is not an owner-console route at all, which is not a case that can
  // arise here.
  if (rows.length === 0) {
    return { role: "telecaller", scope: "own", userId, telecallerId: null };
  }

  const role = resolveOwnerRole(rows[0].owner_role);
  return { role, scope: scopeForRole(role), userId, telecallerId: rows[0].telecaller_id };
}

/**
 * The grid half for ONE object, read fresh.
 *
 * `crm-permissions.guard.ts` verbatim, module join included: a tenant whose CRM
 * was switched off still has its `roles`/`role_permissions` rows, and without
 * the module join those rows would keep granting access to a module the org no
 * longer has.
 */
export async function readGridGrant(
  client: PoolClient,
  userId: string,
  orgId: string,
  object: PermissionObjectType,
): Promise<"all" | "owned" | null> {
  const { rows } = await client.query<{ scope: string }>(
    `SELECT rp.scope
       FROM memberships m
       JOIN organizations o
         ON o.id = m.org_id AND $5 = ANY(o.enabled_modules)
       JOIN roles r
         ON r.org_id = m.org_id
        AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
       JOIN role_permissions rp
         ON rp.role_id = r.id AND rp.object_type = $3 AND rp.action = $4
      WHERE m.user_id = $1 AND m.org_id = $2
      ORDER BY rp.scope
      LIMIT 1`,
    [userId, orgId, object, "export", PERMISSION_OBJECT_MODULE[object]],
  );
  const scope = rows[0]?.scope;
  return scope === "all" || scope === "owned" ? scope : null;
}

/** Whether the membership still carries `recordings:export`. */
export async function readRecordingsExport(
  client: PoolClient,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ recordings_export: boolean | null }>(
    `SELECT recordings_export FROM memberships
      WHERE user_id = $1 AND org_id = $2
      ORDER BY (scope_type = 'org') DESC, id
      LIMIT 1`,
    [userId, orgId],
  );
  return rows[0]?.recordings_export === true;
}

/**
 * The narrower of two persona scopes.
 *
 * `own` beats `all`, and a telecaller identity that either side lacks is not
 * invented. The result can only ever be narrower than both inputs.
 */
export function narrowerOwnerScope(
  snapshot: OwnerRecordScope,
  fresh: OwnerRecordScope,
): OwnerRecordScope {
  const scope = snapshot.scope === "own" || fresh.scope === "own" ? "own" : "all";
  return {
    // The FRESH role, because it is the one that is true now; the scope above
    // is what actually gates rows, and it has already taken the narrower.
    role: fresh.role,
    scope,
    userId: fresh.userId ?? snapshot.userId,
    // A telecaller identity that has disappeared narrows to nothing rather
    // than reverting to the snapshot's - the person no longer has that desk.
    telecallerId: fresh.telecallerId,
  };
}

/** The narrower of two grid grants. A missing grant on either side denies. */
export function narrowerGridGrant(
  snapshot: "all" | "owned" | undefined,
  fresh: "all" | "owned" | null,
): "all" | "owned" | null {
  if (!snapshot || !fresh) return null;
  return snapshot === "owned" || fresh === "owned" ? "owned" : "all";
}

/** The resolved scope a dataset's query runs under. */
export function resolvedScopeFor(
  owner: OwnerRecordScope,
  grid: "all" | "owned" | null,
  subject: { telecallerId: string; userId: string | null } | null = null,
): ResolvedScope {
  return {
    owner,
    // The grid narrows on the acting USER's id, and only when the grant is
    // `owned`. `all` means the grid adds no predicate at all.
    //
    // Deliberately still the REQUESTER's id on a person export: the grid said
    // what this requester may see, and re-pointing it at the subject would let
    // an `owned` grant reach rows it was never given. The subject is a
    // separate ANDed axis - see `ResolvedScope.subject`.
    crmUserId: grid === "owned" ? owner.userId : null,
    subject,
  };
}

/**
 * RE-AUTHORIZE THE SUBJECT AT RENDER TIME (0188, doc 35 §4.2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS CANNOT BE SKIPPED BECAUSE THE API ALREADY CHECKED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Minutes or hours separate the enqueue from the render - longer if the queue
 * backs up or the job is re-published by the sweep. In that window a person
 * can be moved out of a manager's branch, have their seat ended, or the
 * manager can be demoted. An export that renders on the enqueue-time answer
 * produces a file the requester is no longer entitled to, and produces it
 * *after* somebody decided they should not have it.
 *
 * Refusing is the only safe reading, and it is PERMANENT rather than retried:
 * the second attempt reaches the same answer, so retrying would just be a
 * failing job occupying a slot.
 *
 * The identity having been DELETED is the same refusal and not a special case.
 * A subject that no longer exists cannot be re-authorized, and the alternative
 * - rendering with no subject predicate - is the whole tenant in a file
 * bearing one person's name.
 */
export async function assertSubjectStillVisible(
  client: PoolClient,
  freshOwner: OwnerRecordScope,
  subjectTelecallerId: string,
): Promise<void> {
  // Takes the ALREADY-RESOLVED fresh persona rather than re-reading the
  // membership. `readOwnerScope`'s own query carries a load-bearing
  // `ORDER BY (m.scope_type = 'org') DESC` - a person can hold an org-scope
  // membership and workspace-scope rows at once - and a second query here with
  // a different tie-break would answer this question under a different persona
  // than the one the rest of the job runs under.
  const visibility = await resolvePeopleVisibility(client, {
    userId: freshOwner.userId,
    ownerRole: freshOwner.role,
    // Always false: a job row records a real `users` id - the API refuses to
    // create an export that belongs to nobody - so there is no admin-key
    // identity to re-assert here.
    viaAdminKey: false,
  });

  if (!visibilityAllowsTelecaller(visibility, subjectTelecallerId)) {
    throw new SubjectNoLongerVisibleError(
      "the person who requested this export may no longer see that person's work",
    );
  }
}

/** Raised when the subject check fails. The caller turns it into a permanent failure. */
export class SubjectNoLongerVisibleError extends Error {}

export { OWNER_UNSCOPED };
