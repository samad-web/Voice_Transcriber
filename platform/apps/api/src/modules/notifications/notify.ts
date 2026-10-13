import { safeNotificationPath, type NotificationInput } from "@aura/shared";

/**
 * Writing a notification. One function, so every producer agrees on what a
 * notification row means.
 *
 * Callers so far: task assignment (tasks.controller.ts) and the Layer 2 rule
 * engine. Both go through here rather than writing the table, because the
 * dedupe and link rules below are easy to get subtly wrong in a way nothing
 * fails loudly about - a duplicated notification just quietly trains people
 * to ignore the bell.
 */

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;
};

/**
 * Returns whether a row was actually written - false means either that an
 * identical notification already existed and the dedupe key collapsed it, or
 * that the recipient is a suspended member and 0198's trigger dropped the row.
 *
 * ── WHY THE SUSPENSION RULE IS A TRIGGER AND NOT A LINE IN HERE ────────────
 *
 * It is both, in effect, but the enforcement is the trigger. This function is
 * the ONE place every producer is supposed to agree on what a notification
 * means, and it has two callers; seventeen other files write the table
 * directly, each with its own CTE picking a recipient out of a join - the task
 * sweep from `tasks.assignee_user_id`, the missed-call notice from a lead's
 * telecaller, the call-back escalation from `callbacks.assigned_user_id`. A
 * guard added here would be correct and would miss every one of them, which is
 * how a departed rep's bell goes on filling up for months.
 * `notifications_skip_suspended` (migration 0198) sits under all of those paths
 * and under the eighteenth nobody has written yet.
 *
 * It skips only a SUSPENDED member - never a recipient with no membership in
 * the org at all, who may legitimately be an operator or a platform-level
 * alert's audience. 0198's header has the reasoning.
 *
 * Never notifies a person about their own action. Being told "you assigned
 * this task to yourself" is noise, and noise is how a notification system
 * dies: people stop reading the bell, and then the one that mattered gets
 * missed too. `actorUserId` is the person who caused it, if any.
 */
export async function notify(
  client: Queryable,
  orgId: string,
  input: NotificationInput,
  actorUserId?: string | null,
): Promise<boolean> {
  if (actorUserId && actorUserId === input.userId) return false;

  const { rowCount } = await client.query(
    `INSERT INTO notifications
       (org_id, user_id, kind, title, body, link_path, deal_id, contact_id, task_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
     DO NOTHING`,
    [
      orgId,
      input.userId,
      input.kind,
      input.title,
      input.body ?? null,
      // Validated, not trusted: this ends up in an href somebody clicks by
      // reflex, and an absolute URL would make it an open redirect.
      safeNotificationPath(input.linkPath),
      input.dealId ?? null,
      input.contactId ?? null,
      input.taskId ?? null,
      input.dedupeKey ?? null,
    ],
  );
  return (rowCount ?? 0) > 0;
}
