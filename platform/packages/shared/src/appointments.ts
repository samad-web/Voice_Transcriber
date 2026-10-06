import { z } from "zod";
import { inQuietWindow, type QuietHours } from "./quiet-hours";

/**
 * The `appointments` primitive (migration 0166, Build docs/39 §25).
 *
 * Most of this is a PORT. `marketing.booking_slots` (0023) plus
 * 0027/0029/0030/0032/0047/0053 is a complete appointment lifecycle already
 * running in production on Aura's own funnel, and this file holds the parts of
 * it that are POLICY rather than plumbing: which reminder fires when, which of
 * them may be held until morning, and who must not be messaged at all.
 *
 * Everything here is pure and takes its instant explicitly. The drain that will
 * send these lives in the worker and the enqueue lives in the API, and the one
 * thing they must never disagree about is the suppression rule - so the rule is
 * here, once, and both import it.
 */

// ── Twins of 0166's CHECK constraints ───────────────────────────────────────
//
// Each of these is the TypeScript half of a CHECK in migration 0166, and
// appointments.test.ts pins them equal - once as a transcribed literal and once
// read out of the migration file, because those two fail in opposite
// directions. `notifications.kind` is the precedent: the DB CHECK and the zod
// enum drifted in BOTH directions at once, the failure was a bare 23514 that
// read like a bug in the caller, and it silently broke lead routing while every
// typecheck and lint stayed green.

/** Twin of `appointments.status`'s CHECK. */
export const AppointmentStatus = z.enum([
  "scheduled",
  "confirmed",
  "rescheduled",
  "completed",
  "no_show",
  "cancelled",
]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

/**
 * Statuses a person may set directly.
 *
 * `rescheduled` is absent: it is produced BY moving the times, not asserted
 * alongside them, and a PATCH that said `rescheduled` without new times would
 * be a booking that claims to have moved and has not. `no_show` and
 * `completed` are absent for the stronger version of the same reason - they are
 * what the attendance route writes, and setting one without recording
 * attendance is how the no-show report stops agreeing with itself.
 */
export const AppointmentManualStatus = z.enum(["scheduled", "confirmed", "cancelled"]);
export type AppointmentManualStatus = z.infer<typeof AppointmentManualStatus>;

/** Twin of `appointment_notifications.template`'s CHECK. */
export const AppointmentNotificationTemplate = z.enum([
  "appointment_confirmed",
  "appointment_reminder_24h",
  "appointment_reminder_1h",
  "appointment_reminder_5m",
  "appointment_attended",
  "appointment_no_show",
  "appointment_nurture_1",
  "appointment_nurture_2",
  "appointment_nurture_3",
]);
export type AppointmentNotificationTemplate = z.infer<typeof AppointmentNotificationTemplate>;

/** Twin of `appointment_notifications.channel`'s CHECK. */
export const AppointmentNotificationChannel = z.enum(["whatsapp", "email"]);
export type AppointmentNotificationChannel = z.infer<typeof AppointmentNotificationChannel>;

/**
 * Twin of `appointment_notifications.status`'s CHECK.
 *
 * `skipped` is the one 0053 did not have, taken from the attendance outbox
 * (0140): a row held back because a switch was off AT SEND TIME has not failed
 * and must never be retried, or turning the switch on later releases a burst of
 * stale reminders about appointments that have already happened.
 */
export const AppointmentNotificationStatus = z.enum(["pending", "sent", "dead", "skipped"]);
export type AppointmentNotificationStatus = z.infer<typeof AppointmentNotificationStatus>;

/** Same shape rule as `resource_type` - a key the console groups by, not a label. */
export const AppointmentTypeKey = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "a lower-case key like `site_visit` or `demo_class`");
export type AppointmentTypeKey = z.infer<typeof AppointmentTypeKey>;

/** What the console offers. Never what the database enforces - see 0166. */
export const APPOINTMENT_TYPE_SUGGESTIONS: readonly string[] = [
  "consultation",
  "site_visit",
  "test_drive",
  "demo_class",
  "counselling",
  "survey",
  "delivery",
  "service",
];

// ── The reminder ladder ─────────────────────────────────────────────────────

export interface AppointmentReminderStage {
  template: AppointmentNotificationTemplate;
  minutesBefore: number;
  /**
   * Exempt from quiet hours.
   *
   * Holding one of these corrupts its meaning rather than merely delaying it: a
   * "your appointment is in an hour" deferred past the quiet window arrives
   * AFTER the appointment it was about, which is worse than arriving late at
   * night because it is actively misleading. quiet-hours.ts makes exactly this
   * argument for `reminder_call_1h` / `reminder_call_5m`, and it is a named
   * flag rather than a heuristic so adding a stage forces a decision about
   * which kind it is.
   *
   * Exempt stages barely meet the window anyway - they are anchored to a
   * booked appointment, and appointments are business hours by construction.
   */
  urgent: boolean;
}

/** 0053's ladder: a day before, an hour before, five minutes before. */
export const APPOINTMENT_REMINDER_STAGES: readonly AppointmentReminderStage[] = [
  { template: "appointment_reminder_24h", minutesBefore: 24 * 60, urgent: false },
  { template: "appointment_reminder_1h", minutesBefore: 60, urgent: true },
  { template: "appointment_reminder_5m", minutesBefore: 5, urgent: true },
];

/**
 * The no-show drip, ported as a SHAPE and not as copy.
 *
 * 0053's nurture_1/2/3 bodies quote two landing-page testimonials that the
 * file's own header says were never approved by the customers they are
 * attributed to. None of that prose comes across; a tenant's wording is theirs,
 * and `public.message_templates` (0098) is where it lives.
 *
 * Hours rather than days so the arithmetic is one multiplication, and spaced
 * the way a person chasing a missed appointment actually would: the next day,
 * mid-week, and once more a week later.
 */
export const APPOINTMENT_NURTURE_STAGES: readonly {
  template: AppointmentNotificationTemplate;
  hoursAfter: number;
}[] = [
  { template: "appointment_nurture_1", hoursAfter: 24 },
  { template: "appointment_nurture_2", hoursAfter: 72 },
  { template: "appointment_nurture_3", hoursAfter: 24 * 7 },
];

/** The stages whose whole premise is that the customer has not converted. */
export function isAppointmentNurture(template: string): boolean {
  return (
    template === "appointment_nurture_1" ||
    template === "appointment_nurture_2" ||
    template === "appointment_nurture_3"
  );
}

/** The stages that describe an appointment that has not happened yet. */
export function isAppointmentPreReminder(template: string): boolean {
  return (
    template === "appointment_reminder_24h" ||
    template === "appointment_reminder_1h" ||
    template === "appointment_reminder_5m"
  );
}

/**
 * The reminders still worth queueing for an appointment starting at `startsAt`.
 *
 * PAST INSTANTS ARE SKIPPED, NOT QUEUED - 0053's rule, and it is not tidiness.
 * Somebody books ninety minutes out; queueing the 24-hour reminder for them
 * means queueing a row whose send time is yesterday, which a drain would either
 * fire immediately ("your appointment is tomorrow" - it is not) or expire as
 * overdue. Both are noise. A same-day booking simply gets one or two reminders.
 */
export function appointmentReminderPlan(
  startsAt: Date,
  now: Date,
): { template: AppointmentNotificationTemplate; sendAt: Date }[] {
  const start = startsAt.getTime();
  const plan: { template: AppointmentNotificationTemplate; sendAt: Date }[] = [];
  for (const stage of APPOINTMENT_REMINDER_STAGES) {
    const sendAt = new Date(start - stage.minutesBefore * 60_000);
    if (sendAt.getTime() <= now.getTime()) continue;
    plan.push({ template: stage.template, sendAt });
  }
  return plan;
}

/** The drip, stamped from the moment the no-show was recorded. */
export function appointmentNurturePlan(
  recordedAt: Date,
): { template: AppointmentNotificationTemplate; sendAt: Date }[] {
  return APPOINTMENT_NURTURE_STAGES.map((stage) => ({
    template: stage.template,
    sendAt: new Date(recordedAt.getTime() + stage.hoursAfter * 60 * 60 * 1000),
  }));
}

/**
 * Should this message be held until the quiet window ends?
 *
 * ── WHY THIS IS NOT A DIRECT CALL TO shouldHoldForQuietHours ───────────────
 *
 * `QUIET_HOURS_EXEMPT_TEMPLATES` in quiet-hours.ts names the FUNNEL's two
 * urgent templates (`reminder_call_1h`, `reminder_call_5m`) and nothing else,
 * so passing an appointment template to `shouldHoldForQuietHours` would hold
 * `appointment_reminder_1h` until morning - which is the precise failure that
 * file's header warns about, arriving through a different door.
 *
 * Rather than mapping an appointment template onto a funnel one (a lie that
 * would read as a bug the first time somebody greps for it), the exemption is
 * decided here from the stage's own `urgent` flag and the WINDOW question is
 * delegated to `inQuietWindow` - which stays the single implementation of
 * "what counts as quiet", wrapping midnight and all. Nothing about the window
 * is reimplemented here.
 *
 * The follow-up that closes this properly is one line in quiet-hours.ts adding
 * the two urgent appointment templates to its exempt list; that file is not
 * this wave's to edit.
 */
export function shouldHoldAppointmentMessage(
  template: string,
  instant: Date,
  quiet: QuietHours | null,
): boolean {
  if (!quiet) return false;
  const stage = APPOINTMENT_REMINDER_STAGES.find((s) => s.template === template);
  if (stage?.urgent) return false;
  return inQuietWindow(instant, quiet);
}

/**
 * SOMEBODY ASKED TO BE LEFT ALONE - the appointment outbox's half of it.
 *
 * ── WHY THIS IS A SQL FRAGMENT AND NOT A PREDICATE OVER ROWS ───────────────
 *
 * Two processes ask this question: the API, which should not queue a reminder
 * for somebody who has opted out, and the drain, which must re-ask at SEND time
 * because three days is plenty of time for a customer to tell a business to
 * stop. The two must never disagree - the same reasoning the reprocess panel
 * uses for its one shared window predicate, where a preview and a bill that
 * compute "the period" separately eventually name different numbers.
 *
 * The worker cannot import the API and the API cannot import the worker, so the
 * shared thing has to live in @aura/shared, and the only form that works for
 * both is the SQL itself.
 *
 * ── THE THREE ADDRESS SHAPES, AND WHY ALL THREE ARE CHECKED ────────────────
 *
 * `messaging_opt_outs.peer_address` is channel-relative by design (0111, 0158):
 *
 *   · for the `call` channel it is the NUMBER KEY - sha256(phoneMatchDigits) -
 *     which is exactly `leads.contact_number_key` (0146). The vault owns the
 *     only copy of the number, so this is the only phone-shaped thing an
 *     appointment can reach;
 *   · for email it is the lower-cased address, which is `contacts.email`;
 *   · for whatsapp/sms/instagram/facebook it is whatever
 *     `normalizePeerAddress` produced, which is stored on `conversations` and
 *     reachable from the appointment through its contact.
 *
 * ── AND WHY THE CHANNEL IS NOT PART OF THE MATCH ───────────────────────────
 *
 * Deliberately conservative. 0111 stores one row per person per channel, so the
 * narrow reading is "an email opt-out does not stop a WhatsApp reminder". For a
 * message a PERSON composes and sends, that reading is right. For an automated
 * one it is not: somebody who has said "stop messaging me" in any inbox has
 * said it, and answering them on a different channel because the row named a
 * different column is the kind of cleverness that earns a spam report.
 *
 * There is no false-positive risk in practice - an email address never equals a
 * sha256 hex digest, and neither equals an E.164.
 *
 * Only `level = 'certain'` suppresses. A `probable` is held for a person to
 * decide (opt-out.ts: the power to stop talking to a customer for good belongs
 * to a person), and `released_at IS NULL` because a released opt-out is history.
 *
 * Takes `$1` = the appointment id. The caller supplies nothing else; every
 * address is resolved from the appointment's own lead and contact.
 */
export const APPOINTMENT_SUPPRESSED_SQL = `EXISTS (
  SELECT 1
    FROM appointments sa
    LEFT JOIN leads    sl ON sl.id = sa.lead_id
    LEFT JOIN contacts sc ON sc.id = sa.contact_id
   WHERE sa.id = $1
     AND EXISTS (
       SELECT 1
         FROM messaging_opt_outs mo
        WHERE mo.org_id = sa.org_id
          AND mo.level = 'certain'
          AND mo.released_at IS NULL
          AND ( mo.peer_address = sl.contact_number_key
             OR mo.peer_address = lower(sc.email)
             OR mo.peer_address IN (SELECT cv.peer_address
                                      FROM conversations cv
                                     WHERE cv.contact_id = sa.contact_id) )
     )
)`;

/**
 * The three gates a queued appointment message passes before it may be sent,
 * in the order the drain applies them.
 *
 * Written down as data rather than as prose because §25's claim - that a
 * reminder for an appointment the customer themselves booked is
 * customer-initiated and therefore sits on the safe side of this product's
 * "nothing automated sends without a person saying yes" rule - is an argument
 * about a CLASS of message. It is a good argument. It is not a licence to skip
 * the three checks that make it true in a particular case.
 */
export const APPOINTMENT_SEND_GATES = [
  /** organizations.appointment_reminders_enabled (0166). Default false. */
  "owner_switch",
  /** The deployment-wide WHATSAPP_SENDING_ENABLED, as every other sender reads it. */
  "deployment_switch",
  /** APPOINTMENT_SUPPRESSED_SQL, re-evaluated at send time and not at queue time. */
  "opt_out",
  /** shouldHoldAppointmentMessage - a hold, not a failure, and never an attempt. */
  "quiet_hours",
] as const;
export type AppointmentSendGate = (typeof APPOINTMENT_SEND_GATES)[number];
