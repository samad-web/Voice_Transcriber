import { z } from "zod";

/**
 * In-app notifications (migration 0048).
 *
 * Nothing here can reach a person who is not signed in to the console. That
 * is the property worth keeping: an unread badge is not a message, and it
 * cannot arrive in somebody's inbox, on their phone, or in front of a
 * customer. A digest email would be a different decision with a different
 * consent question.
 */

export const NotificationKind = z.enum([
  /** Somebody gave you a task. */
  "task_assigned",
  /** A task you own is due today or already late. */
  "task_due",
  /** A deal you own moved. */
  "deal_stage_changed",
  /** A deal you own has gone quiet. */
  "deal_idle",
  /** A Layer 2 automation rule fired and wanted you to know. */
  "automation",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/**
 * Only a same-site path may be stored as a notification's link.
 *
 * Same reasoning as `safeRedirectPath` in the OAuth module: this value ends
 * up in an href that a person clicks by reflex, so an absolute or
 * protocol-relative value would be an open redirect wearing a bell icon.
 * Returns null rather than a default, because a notification with no link is
 * fine and one that quietly links somewhere unrelated is not.
 */
export function safeNotificationPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return path;
}

export const NotificationInput = z.object({
  userId: z.string().uuid(),
  kind: NotificationKind,
  title: z.string().min(1).max(200),
  body: z.string().max(1000).nullish(),
  linkPath: z.string().max(500).nullish(),
  dealId: z.string().uuid().nullish(),
  contactId: z.string().uuid().nullish(),
  taskId: z.string().uuid().nullish(),
  /**
   * Present for anything a SWEEP produces, absent for anything an EVENT
   * produces. "This task is overdue" stays true on every pass and must
   * collapse to one row; "Priya replied" is a new fact each time and must
   * not.
   */
  dedupeKey: z.string().max(200).nullish(),
});
export type NotificationInput = z.infer<typeof NotificationInput>;
