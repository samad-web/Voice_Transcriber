import type { TaskAssignee, TaskAssigneeStatus } from "@aura/shared";

/**
 * Everyone on a task and their answer (migration 0135).
 *
 * `tasks.assignee_user_id` is the primary assignee and `task_assignees` the
 * full set; this file is what keeps the two readable as one. See 0135's header
 * for why the column was kept rather than replaced.
 */

interface Queryable {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount?: number | null }>;
}

/**
 * The `assignees` column for a task row, as a correlated subquery.
 *
 * The UNION's second half is the task a machine assigned: the worker's
 * automation and missed-call sweeps write `assignee_user_id` alone, with no
 * row here. That person reads as accepted - nobody offered them the work, so
 * there is nobody to answer. The primary sorts first, then everyone else in
 * the order they were asked.
 */
export function assigneesSql(alias: string): string {
  return `(SELECT coalesce(json_agg(json_build_object('user_id', x.user_id, 'name', x.name, 'status', x.status)
                                    ORDER BY x.primary_rank, x.assigned_at), '[]'::json)
             FROM (
               SELECT ta.user_id, au.name, ta.status, ta.assigned_at,
                      CASE WHEN ta.user_id = ${alias}.assignee_user_id THEN 0 ELSE 1 END AS primary_rank
                 FROM task_assignees ta
                 JOIN users au ON au.id = ta.user_id
                WHERE ta.task_id = ${alias}.id
               UNION ALL
               SELECT pu.id, pu.name, 'accepted', ${alias}.created_at, 0
                 FROM users pu
                WHERE pu.id = ${alias}.assignee_user_id
                  AND NOT EXISTS (SELECT 1 FROM task_assignees tx
                                   WHERE tx.task_id = ${alias}.id AND tx.user_id = ${alias}.assignee_user_id)
             ) x) AS assignees`;
}

/**
 * "Tasks this person is on" - primary, or asked and not declined. `$?` is the
 * user id, substituted by the list endpoint's add() helper (every occurrence).
 */
export function onTaskSql(alias: string): string {
  return `(${alias}.assignee_user_id = $? OR EXISTS (SELECT 1 FROM task_assignees ta
             WHERE ta.task_id = ${alias}.id AND ta.user_id = $? AND ta.status <> 'declined'))`;
}

/** "Waiting for this person's answer." `$?` as above. */
export function awaitingSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM task_assignees ta
             WHERE ta.task_id = ${alias}.id AND ta.user_id = $? AND ta.status = 'pending')`;
}

/**
 * Adds `my_status` - the reader's own answer, which is what decides whether
 * their row shows Accept / Decline. Worked out here from `assignees` rather
 * than in SQL, so the list query does not need the caller's id bound twice.
 */
export function withMyStatus<T extends { assignees?: TaskAssignee[] | null }>(
  row: T,
  me: string | null,
): T & { my_status: TaskAssigneeStatus | null } {
  const mine = me ? (row.assignees ?? []).find((a) => a.user_id === me) : undefined;
  return { ...row, my_status: mine?.status ?? null };
}

/**
 * Give a machine-assigned task its row before anyone edits the set.
 *
 * Without this, reassigning a worker-created task to [its current person,
 * somebody else] would insert the current person as PENDING - asking them to
 * accept work they already had.
 */
export async function materializePrimary(client: Queryable, orgId: string, taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  await client.query(
    `INSERT INTO task_assignees (org_id, task_id, user_id, status, assigned_by, assigned_at, responded_at)
     SELECT t.org_id, t.id, t.assignee_user_id, 'accepted', t.created_by, t.created_at, t.created_at
       FROM tasks t
      WHERE t.org_id = $1 AND t.id = ANY($2::uuid[]) AND t.assignee_user_id IS NOT NULL
     ON CONFLICT (task_id, user_id) DO NOTHING`,
    [orgId, taskIds],
  );
}

/**
 * Make `userIds` the whole set of people on each task.
 *
 * People already on it keep their answer - re-saving the dialog must not
 * un-accept somebody. Anybody new is pending, and so is anybody who had
 * DECLINED and is being put back: that is asking them again, and they should
 * be able to say no again. Giving a task to yourself is accepted on the spot.
 *
 * Returns who was newly asked, per task, so the caller notifies exactly them.
 * Set-based on purpose: the bulk Reassign sends hundreds of ids, and the
 * database is a quarter-second round trip away (see prod-latency notes).
 *
 * Does NOT touch `tasks.assignee_user_id` - both callers already write it in
 * their own scoped UPDATE, which is also what enforces the task scope.
 */
export async function replaceAssignees(
  client: Queryable,
  orgId: string,
  taskIds: string[],
  userIds: string[],
  actor: string | null,
): Promise<Array<{ task_id: string; user_id: string }>> {
  if (taskIds.length === 0) return [];
  await client.query(
    `DELETE FROM task_assignees
      WHERE org_id = $1 AND task_id = ANY($2::uuid[]) AND NOT (user_id = ANY($3::uuid[]))`,
    [orgId, taskIds, userIds],
  );
  if (userIds.length === 0) return [];

  const { rows } = await client.query<{ task_id: string; user_id: string; status: TaskAssigneeStatus }>(
    `INSERT INTO task_assignees (org_id, task_id, user_id, status, assigned_by, assigned_at, responded_at)
     SELECT $1, t.id, u.id,
            CASE WHEN u.id = $4::uuid THEN 'accepted' ELSE 'pending' END,
            $4::uuid, now(),
            CASE WHEN u.id = $4::uuid THEN now() END
       FROM unnest($2::uuid[]) AS t(id)
       CROSS JOIN unnest($3::uuid[]) AS u(id)
     ON CONFLICT (task_id, user_id) DO UPDATE
        SET status = EXCLUDED.status,
            assigned_by = EXCLUDED.assigned_by,
            assigned_at = EXCLUDED.assigned_at,
            responded_at = EXCLUDED.responded_at,
            decline_reason = NULL
      WHERE task_assignees.status = 'declined'
     RETURNING task_id, user_id, status`,
    [orgId, taskIds, userIds, actor],
  );
  return rows.filter((r) => r.status === "pending").map(({ task_id, user_id }) => ({ task_id, user_id }));
}
