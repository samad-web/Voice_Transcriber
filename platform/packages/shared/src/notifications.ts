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
  /**
   * The lead distribution engine (0094) routed a lead to you.
   *
   * Reaches only a telecaller BOUND TO A USER (`telecallers.user_id`). An
   * unbound telecaller is a name on a handset with no console login, and
   * there is nobody to tell - so the assignment still happens and this is
   * silently skipped, rather than the lead going unrouted for want of a
   * notification.
   */
  "lead_assigned",
  /**
   * A scheduled report finished. Added to the DB's CHECK by 0077 and to this
   * enum here, where it had been missing - the two lists had drifted in both
   * directions at once, which is what migration 0100's header records.
   */
  "report_ready",
  /**
   * A customer may have asked to stop being messaged (migration 0100).
   *
   * Raised for BOTH levels, and only one of them blocks anything. A `certain`
   * opt-out is enforced silently by the send path, so without this the rep
   * would watch their reply refuse to send with no idea why.
   */
  "opt_out_requested",
  /**
   * A WhatsApp channel cannot carry messages (migration 0099) - a refused key,
   * or replies being discarded for want of a forward secret.
   */
  "channel_needs_attention",
  /**
   * A lead has waited longer than the org's response SLA for a first response
   * (migration 0109, the worker's sla-breach sweep). Told to the assigned
   * telecaller's user and to owners/managers, once per lead.
   */
  "sla_breach",
  /**
   * Something a machine proposed is waiting for a person to approve - today, a
   * WhatsApp thread the qualification sweep scored as a prospect (0109).
   */
  "review_pending",
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

/**
 * How a person wants each kind delivered (migration 0109).
 *
 * `digestKinds` lists the kinds held back until `digestHour` (local, in the
 * org's reporting timezone); every other kind is instant. The database applies
 * it to every writer through a trigger, so this schema is only the shape of the
 * choice, never the enforcement.
 *
 * No `.default()` on either field: a PUT that omitted one must fail, not reset
 * a person's choice (the partial/default trap).
 */
export const NotificationPreferencesInput = z.object({
  digestKinds: z
    .array(NotificationKind)
    .max(NotificationKind.options.length)
    .transform((kinds) => [...new Set(kinds)]),
  digestHour: z.number().int().min(0).max(23),
});
export type NotificationPreferencesInput = z.infer<typeof NotificationPreferencesInput>;
