import type { OwnerRole } from "@aura/shared";

/**
 * WHOSE RECORDS A PERSON MAY SEE, resolved from the org chart.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS IN `packages/db` AND NOT IN EITHER APP
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Three callers need the same answer and two of them are different processes:
 *
 *   1. the transcript agent's review queue, deciding which calls' suggestions
 *      a person may read (§3A.3 "managers see their branch");
 *   2. the export API, deciding whether a requester may export a named
 *      person's data AT ENQUEUE;
 *   3. the export WORKER, re-deciding the same thing AT RENDER, minutes or
 *      hours later, because doc 35 §4.2 requires the job to re-resolve the
 *      requester's scope rather than trust what was frozen into it.
 *
 * (2) and (3) are the whole reason this is not a private method on a Nest
 * controller. An export job that renders under the enqueue-time answer is an
 * export that keeps working after somebody was moved out of a manager's
 * branch, and the only structural defence is that both processes call ONE
 * function. Copying the recursive walk into the worker would pass every test
 * and drift the first time the walk changes.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE BRANCH IS THE ORG CHART'S SUBTREE, NOT A TEAM
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A team is one node. A branch is everything beneath a manager's seat, which
 * is what a manager with two team leads under them expects to see.
 * `reporting_lines` (0177) is the only place that shape exists, so this walks
 * it recursively rather than taking a `team_id =` shortcut that would silently
 * exclude a sub-team - and silently is the problem: the manager sees a shorter
 * list and has no way to tell it is short.
 */

/** A person this visibility can reach, as the pickers and the queries need them. */
export interface VisiblePerson {
  telecallerId: string | null;
  userId: string | null;
}

export type PeopleVisibility =
  /** An owner, an admin, an operator or a bare admin key. Nothing narrows. */
  | { kind: "all" }
  /**
   * One person's own records.
   *
   * Both ids are carried because they scope DIFFERENT objects: calls, leads,
   * deals and the productivity rollup scope on the telecaller identity, while
   * a task belongs to a `users` row. `owner-scope.ts` makes that split and
   * this has to be able to express both sides of it or a person-scoped export
   * of tasks silently matches nothing.
   */
  | { kind: "own"; telecallerId: string | null; userId: string | null }
  /**
   * A manager's subtree, as explicit id lists.
   *
   * Lists rather than a predicate because the caller needs to ENUMERATE them
   * (the person picker shows who you may export) as well as filter by them.
   * `userIds` is a superset of the people in `telecallerIds`: a manager or an
   * analyst in the subtree may hold a seat and own tasks without ever having
   * a telecaller identity, and leaving them out would make them unexportable
   * by the one person responsible for them.
   */
  | { kind: "branch"; telecallerIds: string[]; userIds: string[] };

/** What this module needs to know about the caller. Deliberately not a Nest request. */
export interface VisibilityActor {
  userId: string | null;
  ownerRole: OwnerRole | null;
  /** An operator or a script holding the bare admin key. */
  viaAdminKey: boolean;
}

interface QueryClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/**
 * The recursive subtree walk: the actor's own seats, then everything reporting
 * into them, transitively.
 *
 * `end_date IS NULL` / `effective_to IS NULL` on both joins, because 0177/0178
 * model seats and reporting lines as effective-dated history - without them a
 * manager inherits the branch of a seat they left, which is the exact failure
 * the org chart exists to prevent (see ORG_CHART_DECISIONS.md: "seats not
 * people").
 */
const BRANCH_SQL = `
  WITH RECURSIVE my_seats AS (
    SELECT p.id
      FROM position_assignments pa
      JOIN positions p ON p.id = pa.position_id
     WHERE pa.user_id = $1 AND pa.end_date IS NULL
    UNION
    SELECT rl.position_id
      FROM reporting_lines rl
      JOIN my_seats ms ON rl.manager_position_id = ms.id
     WHERE rl.effective_to IS NULL
  ),
  people AS (
    SELECT DISTINCT pa2.user_id
      FROM my_seats ms
      JOIN position_assignments pa2
        ON pa2.position_id = ms.id AND pa2.end_date IS NULL
     WHERE pa2.user_id IS NOT NULL
  )
  SELECT pe.user_id,
         t.id AS telecaller_id
    FROM people pe
    LEFT JOIN telecallers t
      ON t.user_id = pe.user_id AND t.status = 'active'`;

/**
 * Resolve whose records this actor may see.
 *
 * `client` must already be inside the org's transaction - the same contract
 * `gateFor` has, and for the same reason: RLS is what scopes these reads to
 * the tenant, so a caller that forgets `withOrgContext` gets nothing rather
 * than everything.
 */
export async function resolvePeopleVisibility(
  client: QueryClient,
  actor: VisibilityActor,
): Promise<PeopleVisibility> {
  // An operator or a bare admin key sees everything. For CALL CONTENT they are
  // still gated by 0122's call-access rules; this decides whose records are in
  // scope, not whether the sensitive columns come with them.
  if (actor.viaAdminKey) return { kind: "all" };

  // A null persona is a membership that predates personas, and
  // `resolveOwnerRole` is fail-open for it elsewhere in the console. Matching
  // that here keeps one answer rather than two.
  if (actor.ownerRole === "owner" || actor.ownerRole === null) return { kind: "all" };

  if (!actor.userId) {
    // No resolvable user and not an admin key: nothing to scope to, and an
    // empty own-scope matches no rows. Fails closed by construction.
    return { kind: "own", telecallerId: null, userId: null };
  }

  if (actor.ownerRole === "manager") {
    const { rows } = await client.query<{ user_id: string | null; telecaller_id: string | null }>(
      BRANCH_SQL,
      [actor.userId],
    );
    const telecallerIds = [
      ...new Set(rows.map((r) => r.telecaller_id).filter((id): id is string => !!id)),
    ];
    const userIds = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id))];

    // A manager who holds no seat in the chart gets their OWN records, not the
    // whole floor. The org chart is optional - plenty of tenants never fill it
    // in - and reading "no seats" as "no restriction" would hand every
    // unmapped manager the entire tenant. Their own identity is added below so
    // the result is never an empty list that looks like a bug.
    if (telecallerIds.length === 0 && userIds.length === 0) {
      const own = await ownIdentity(client, actor.userId);
      return { kind: "own", ...own };
    }

    // The manager's own records are part of their branch: they take calls too,
    // and a branch export that omits the manager is a report with a hole in it.
    if (!userIds.includes(actor.userId)) userIds.push(actor.userId);
    const own = await ownIdentity(client, actor.userId);
    if (own.telecallerId && !telecallerIds.includes(own.telecallerId)) {
      telecallerIds.push(own.telecallerId);
    }
    return { kind: "branch", telecallerIds, userIds };
  }

  // telecaller / sales / marketing: their own work only.
  const own = await ownIdentity(client, actor.userId);
  return { kind: "own", ...own };
}

async function ownIdentity(
  client: QueryClient,
  userId: string,
): Promise<{ telecallerId: string | null; userId: string }> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM telecallers WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [userId],
  );
  return { telecallerId: rows[0]?.id ?? null, userId };
}

/**
 * May this actor see the records of the telecaller identity `telecallerId`?
 *
 * The single authorization question behind a person-scoped export, asked
 * identically at enqueue and at render.
 */
export function visibilityAllowsTelecaller(
  visibility: PeopleVisibility,
  telecallerId: string,
): boolean {
  if (visibility.kind === "all") return true;
  if (visibility.kind === "own") return visibility.telecallerId === telecallerId;
  return visibility.telecallerIds.includes(telecallerId);
}

/** The same question about a `users` row, for the objects that scope on one. */
export function visibilityAllowsUser(visibility: PeopleVisibility, userId: string): boolean {
  if (visibility.kind === "all") return true;
  if (visibility.kind === "own") return visibility.userId === userId;
  return visibility.userIds.includes(userId);
}

/** One exportable person, as the picker renders them. */
export interface ExportablePerson {
  telecallerId: string;
  userId: string | null;
  displayName: string;
  ownerRole: OwnerRole | null;
  /** Whether this person is the actor themselves, so the UI can say "you". */
  isSelf: boolean;
}

/**
 * Everyone this actor may export, newest-safe ordered by name.
 *
 * Driven from `telecallers` rather than `users` because a person-scoped export
 * is keyed on the telecaller identity: that is the column calls, leads, deals
 * and the rollup all scope on, and a `users` row with no telecaller identity
 * has no phone-side records for the export to find. Somebody who holds a seat
 * but has never been linked to a handset therefore does not appear - correctly,
 * because there is nothing to export for them - and `telecallers.user_id`
 * being nullable is why the reverse join would miss most of a floor.
 */
export async function exportablePeople(
  client: QueryClient,
  actor: VisibilityActor,
  visibility: PeopleVisibility,
): Promise<ExportablePerson[]> {
  const params: unknown[] = [];
  let predicate = "";
  if (visibility.kind === "own") {
    // A null identity must match NOTHING, not everything. An empty `= ANY($1)`
    // array does exactly that, which keeps the query shape identical in all
    // three branches instead of growing a `WHERE false` special case.
    params.push(visibility.telecallerId ? [visibility.telecallerId] : []);
    predicate = `AND t.id = ANY($${params.length}::uuid[])`;
  } else if (visibility.kind === "branch") {
    params.push(visibility.telecallerIds);
    predicate = `AND t.id = ANY($${params.length}::uuid[])`;
  }

  const { rows } = await client.query<{
    id: string;
    user_id: string | null;
    display_name: string;
    owner_role: string | null;
  }>(
    `SELECT t.id, t.user_id, t.display_name, m.owner_role
       FROM telecallers t
       LEFT JOIN memberships m ON m.user_id = t.user_id AND m.org_id = t.org_id
      WHERE t.status = 'active' ${predicate}
      ORDER BY t.display_name ASC, t.id ASC`,
    params,
  );

  return rows.map((r) => ({
    telecallerId: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    ownerRole: (r.owner_role as OwnerRole | null) ?? null,
    isSelf: !!actor.userId && r.user_id === actor.userId,
  }));
}

/** One person by id, for validating a subject the caller named. */
export async function loadPerson(
  client: QueryClient,
  telecallerId: string,
): Promise<{ telecallerId: string; userId: string | null; displayName: string } | null> {
  const { rows } = await client.query<{
    id: string;
    user_id: string | null;
    display_name: string;
  }>(
    `SELECT id, user_id, display_name FROM telecallers
      WHERE id = $1 AND status = 'active' LIMIT 1`,
    [telecallerId],
  );
  const row = rows[0];
  return row
    ? { telecallerId: row.id, userId: row.user_id, displayName: row.display_name }
    : null;
}
