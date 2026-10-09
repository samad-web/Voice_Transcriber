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
  /**
   * A platform operator tried to open this org's call content and was refused
   * (migration 0122). Raised on the FIRST blocked attempt; the repeats that
   * follow from one console page bump a counter instead of ringing again.
   *
   * Goes to the org's designated call-access administrator, or to every member
   * holding the `owner` persona when none is named. This is the one kind whose
   * subject is the vendor rather than the customer's own work, which is
   * exactly why it cannot be turned off.
   */
  "call_access_requested",
  /**
   * The workspace's stored recordings crossed 80 % or 100 % of the storage
   * quota an operator set (doc 27 §6.6, migration 0128). Told to owners, once
   * per threshold crossed - the sweep records the last one it sent - and
   * never anywhere outside Aura. Uploads are not refused at 100 %; this is the
   * whole of the quota's teeth, deliberately.
   */
  "storage_quota",
  /**
   * A missed call (migration 0134): either an existing lead's owner is told a
   * call from their customer went unanswered, or the callback task on a lead
   * the missed-call sweep just created for an unknown caller. NOT raised
   * alongside `lead_assigned` for that second case - the assignment
   * notification already says "new work", and a second bell for the same
   * event is noise, not information.
   */
  "missed_call",
  /**
   * Somebody accepted or declined a task you gave them (migration 0135). Told
   * to the task's creator only - the people it was shared with see the answer
   * on the task itself, and ringing all of them for each other's replies is
   * the noise that teaches people to ignore the bell.
   */
  "task_response",
  /**
   * A telecaller applied for leave, booked a break outside the allowance or
   * asked to change their hours (migration 0140). Told to the request's
   * approver - their `reports_to` manager - or to every owner when there is
   * none, and to the owners again on escalation.
   */
  "attendance_request",
  /** A break has run past its end by the alert threshold (0140). Managers only. */
  "attendance_break_overrun",
  /** A telecaller did not answer a presence check (0140). Their approver only. */
  "attendance_away",
  /** A stretch of a day needs a person to decide what it was (0140 §4 review). */
  "attendance_review",
  /** 0143: a telecaller never started a shift whose grace period has passed. */
  "attendance_absent",
  /**
   * We have answered a problem this business reported about one of its calls
   * (migration 0147, doc 36) - acknowledged it, asked them something, or
   * resolved it.
   *
   * ONE kind for the whole thread, not one per state. The bell's job is to get
   * somebody to open the ticket; a second kind for the same conversation is the
   * noise that teaches people to stop reading it. The dedupe key carries the
   * status, so five internal notes do not ring five times.
   *
   * Goes to the person who filed it, falling back to every member holding the
   * `owner` persona when they have since left - resolved at notify time, the
   * same rule 0122 uses when no call-access administrator is named.
   */
  "call_issue_update",
  /**
   * An export you asked for is ready to download (migration 0148, doc 35).
   * Goes to the requester only.
   */
  "export_ready",
  /**
   * An export you asked for failed for good - after its retries, not on the
   * first stumble. The requester only, for the same reason `export_ready` is:
   * nobody else was waiting for the file.
   */
  "export_failed",
  /**
   * SOMEBODY STARTED AN EXPORT in this workspace (migration 0148, doc 35).
   * Goes to every member holding the `owner` persona, and never to the person
   * who ran it.
   *
   * The governance kind, and the reason it is separate from `export_ready`
   * rather than a flavour of it: an owner must be able to digest "somebody
   * exported something" without also silencing the bell for their own files.
   *
   * Fires at CREATION, not completion. The act worth recording is the
   * request - a job that then fails, is cancelled or expires unread is still
   * somebody who asked for the data. The alert carries no download link, and
   * the download route's ownership check is unchanged by it: an owner learns
   * that an export happened, not what was in it.
   */
  "export_created",
  /**
   * A telecaller escalated a call and it now sits with you (migration 0151,
   * doc 38) - raised to you, or passed up to you by a senior. Goes to the
   * assigned person, or to every owner and manager when nobody is.
   */
  "call_escalated",
  /**
   * An escalation you raised was answered. Only reaches a telecaller who has a
   * console login; the phone gets the same news as an `escalation_update`
   * phone alert.
   */
  "call_escalation_update",
  /**
   * SOMEBODY YOU INVITED IS IN (migration 0152). Raised once, when a 0137
   * invite is accepted - which is the invitee's first sign-in, since accepting
   * one IS signing in with the invited address.
   *
   * Goes to whoever sent that invite, and to every member holding the `owner`
   * persona. The inviter because they are the person waiting for the answer;
   * the owners because somebody gaining a login to the workspace is theirs to
   * know about whether or not they issued it - the same reasoning as
   * `export_created`.
   *
   * ONE row per invite, and nothing on the sign-ins that follow. A bell that
   * rang on every login would be noise of the kind this file's header warns
   * about, and the person's own sign-in history already exists, privately, on
   * their Login activity page (`auth_events`, 0127).
   */
  "invite_accepted",
  /**
   * §10's four, from the organization chart (migrations 0177/0178).
   *
   * All four are listed in 0177's single rewrite of `notifications_kind_check`,
   * including the two 0178's tables raise - because this enum and that CHECK
   * drift silently and then throw 23514 at runtime (0100's header records it
   * happening in production), and `notification-kinds.test.ts` pins them
   * against the LAST CHECK in apply order. One rewrite, one place to get it
   * wrong.
   */

  /**
   * A SEAT HAS BEEN EMPTY TOO LONG AND PEOPLE REPORT TO IT (§10, default 14
   * days, `org_chart_settings.vacancy_alert_days`).
   *
   * The "and people report to it" half is the whole alert. An empty seat with
   * no reports is a hiring decision somebody is already aware of; an empty
   * seat WITH reports is a team whose escalation path currently ends nowhere,
   * which is §9's "reroute needed" in its most consequential form.
   *
   * A `frozen` seat never raises it. That is what the stored status is for -
   * headcount deliberately parked is not a vacancy, and alerting on it weekly
   * is how a business learns to ignore this bell.
   */
  "position_vacant",
  /**
   * YOUR OWN SEAT OR REPORTING LINE CHANGED (§10).
   *
   * Goes to the person affected AND their new manager - §10 says "notify the
   * person and their manager", and the manager half is the one that is easy to
   * skip and worst to miss: somebody acquiring a report without being told is
   * how a new joiner's first week has nobody in it.
   *
   * Raised by a move, an assignment and an unassignment. NOT by a title or
   * responsibility edit, which would make this fire on every typo fix.
   */
  "reporting_change",
  /**
   * A CONTRACT IS RUNNING OUT (§10/§14: 60 / 30 / 7 days).
   *
   * `dedupeKey` carries the offset that was crossed, not the date, so the
   * sweep produces exactly three notifications over a contract's last two
   * months instead of one a day - `reminderOffsetFor` returns the TIGHTEST
   * window for this reason.
   */
  "contract_expiring",
  /**
   * A PROBATION PERIOD IS ENDING (§10/§14: 14 / 3 days).
   *
   * Separate from `contract_expiring` because the action is the opposite one.
   * An expiring contract needs renewing or letting go; a probation ending
   * needs a DECISION recorded, and a business that misses it has confirmed
   * somebody by default.
   */
  "probation_ending",
  /**
   * ── The finance module's two (migrations 0172-0176, re-stated by 0179) ──
   *
   * `notification-kinds.test.ts` pins this enum against the LAST literal
   * `notifications_kind_check` in apply order, and that is now **0179**, not
   * 0177: 0177 rewrote the constraint with an explicit list that could not
   * contain these two, so 0179 restates the whole list with them in it. Both
   * halves of that pair have to move together or the test goes red - which is
   * the mechanism working, and the reason 0179 is a literal restatement rather
   * than the dynamic append it started as.
   */

  /**
   * THE ADVISOR HAS FOUND MONEY GOING MISSING (§12.4).
   *
   * Raised to the person closest to it - for a slipped promise that is the
   * deal's own telecaller, for an unmatched payment the finance handler - and
   * escalated up the ladder if nobody acknowledges it (§12.5).
   *
   * It is suppressed inside QUIET HOURS, but the alert itself is not: the
   * detector still runs and the inbox still shows it, so an owner opening the
   * console at 23:00 sees what is wrong while nobody's phone goes off at 02:00
   * about an instalment. Suppressing detection instead would mean a problem
   * found at 21:05 is never found.
   */
  "finance_alert",
  /**
   * AN INCENTIVE STATEMENT IS READY FOR THE PERSON IT BELONGS TO (§10).
   *
   * Goes to the earner, never about them to somebody else: §3 is explicit that
   * "a telecaller must never be able to read another telecaller's pay", and a
   * notification is as capable of leaking that as an API is.
   */
  "finance_payout",
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
