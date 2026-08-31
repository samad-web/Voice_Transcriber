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
 * Returns whether a row was actually written - false means an identical
 * notification already existed and the dedupe key collapsed it.
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
