import { Injectable } from "@nestjs/common";
import {
  APPOINTMENT_SUPPRESSED_SQL,
  type AppointmentNotificationTemplate,
  appointmentNurturePlan,
  appointmentReminderPlan,
} from "@aura/shared/dist/appointments";

/**
 * The appointment outbox's WRITE side (migration 0166, Build docs/39 §25).
 *
 * Ported from `booking-notifications-outbox.ts` and `call-reminders.ts`, with
 * one structural change: the funnel had to SWEEP for new bookings because the
 * public marketing role holds no grant on the outbox, so nothing on the
 * booking path could insert. A tenant appointment is created by this API,
 * inside a `withOrg` transaction that already has the grant - so the enqueue
 * rides that same transaction and there is no window in which an appointment
 * exists with no reminders owed.
 *
 * ── NOTHING IN THIS FILE SENDS ─────────────────────────────────────────────
 *
 * It writes rows. The drain that turns a row into a message is a later wave
 * (§34's `startAppointmentReminderDrain`), and when it lands it must clear all
 * four gates in `APPOINTMENT_SEND_GATES` - the owner's switch
 * (`organizations.appointment_reminders_enabled`, default FALSE),
 * WHATSAPP_SENDING_ENABLED, the opt-out check and quiet hours.
 *
 * Queueing ahead of a sender is deliberate rather than premature. The rows are
 * the record of what is OWED, which is useful to an operator on its own, and
 * the schedule has to live in the row for the reason the funnel learned: a
 * sweep that asks "is anything due in roughly an hour" loses everything inside
 * its window whenever the worker is down.
 *
 * ── THE OPT-OUT CHECK RUNS TWICE, AND THAT IS NOT BELT AND BRACES ──────────
 *
 * Here, so a reminder is never queued for somebody who has already asked to be
 * left alone; and again at SEND time in the drain, because a reminder sits for
 * up to a day and a nurture message for a week, and "stop messaging me" can
 * arrive at any point in between. The predicate itself lives once, in
 * @aura/shared, so the two cannot disagree - the same reasoning the reprocess
 * panel uses for its single window predicate.
 */

export interface Queryable {
  query: <T = unknown>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Idempotent per (appointment, sequence, template, channel) - 0166's unique
 * index. A retried request, or two tabs saving at once, cannot produce two
 * reminders for one appointment.
 *
 * `next_attempt_at` is the instant the row becomes DUE, not "now". That is the
 * one real difference from the follow-up outbox and it is what lets a worker
 * that was down for six hours send what it owes on its next tick, in order,
 * rather than losing the window.
 *
 * ── WHATSAPP ONLY, AND THE CHANNEL IS LITERAL FOR A REASON ─────────────────
 *
 * The CHECK admits `email` too, and the column exists so the ladder can gain
 * that channel without a migration. Nothing queues it today: `call-reminders.ts`
 * queues the funnel's email copy only when a provider is actually configured,
 * because a log-only dispatcher marks a row `sent` with a `log-only:` id -
 * right for a rejection, wrong here, where it would double the table with
 * undeliverable rows and make "what did we send this person" harder to read.
 * A tenant has no per-org mail sender at all yet, so the literal stays.
 */
export const ENQUEUE_SQL = `INSERT INTO appointment_notifications
     (org_id, appointment_id, sequence, template, channel, status, attempts, next_attempt_at)
   VALUES ($1, $2, $3, $4, 'whatsapp', 'pending', 0, $5::timestamptz)
   ON CONFLICT (appointment_id, sequence, template, channel) DO NOTHING`;

/**
 * Stop anything still queued for a sequence that is no longer happening.
 *
 * `dead` with a reason rather than deleted, for the reason 0032 gives: the
 * outbox is what an operator consults to find out what was sent to somebody,
 * and a message deliberately NOT sent is a fact worth keeping. Somebody who
 * moved their Tuesday appointment to Friday would otherwise still get "your
 * appointment is in about an hour" on Tuesday, from a row queued before they
 * moved it.
 */
export const CANCEL_SQL = `UPDATE appointment_notifications
      SET status = 'dead', error = $3, next_attempt_at = NULL
    WHERE appointment_id = $1
      AND sequence = $2
      AND status = 'pending'`;

/**
 * Has this customer asked to be left alone?
 *
 * One parameter: the appointment id. Every address the predicate checks - the
 * lead's number key, the contact's email, the peer address of any conversation
 * with that contact - is resolved from the appointment's own rows, so a caller
 * cannot pass the wrong person's identity by mistake.
 */
export const SUPPRESSED_SQL = `SELECT ${APPOINTMENT_SUPPRESSED_SQL} AS suppressed`;

@Injectable()
export class AppointmentRemindersService {
  /**
   * Queue the 24h / 1h / 5m ladder for a sequence.
   *
   * Returns how many rows were written - 0 is an ordinary outcome, not a
   * failure: an appointment booked ninety minutes out gets two reminders, one
   * booked inside five minutes gets none, and one for a customer who has
   * opted out gets none either.
   *
   * PAST INSTANTS ARE SKIPPED, NOT QUEUED (0053's rule, in
   * `appointmentReminderPlan`). Queueing a 24-hour reminder whose send time is
   * yesterday gives a drain the choice between firing it immediately ("your
   * appointment is tomorrow" - it is not) and expiring it as overdue. Both are
   * noise.
   */
  async scheduleReminders(
    client: Queryable,
    args: {
      orgId: string;
      appointmentId: string;
      sequence: number;
      startsAt: Date;
      now?: Date;
    },
  ): Promise<number> {
    const plan = appointmentReminderPlan(args.startsAt, args.now ?? new Date());
    if (plan.length === 0) return 0;
    if (await this.suppressed(client, args.appointmentId)) return 0;
    return this.insert(client, args.orgId, args.appointmentId, args.sequence, plan);
  }

  /**
   * Queue the no-show drip, and the one-off outcome message beside it.
   *
   * §25's conversion gate - a nurture message's whole premise is that the
   * person has not become a customer - is re-checked at SEND time rather than
   * here. A week is plenty of time for somebody to sign, and the worst message
   * in any catalogue is the one that is correct about a state that has since
   * changed. Queue time is the wrong moment to ask.
   */
  async scheduleNoShowDrip(
    client: Queryable,
    args: { orgId: string; appointmentId: string; sequence: number; recordedAt: Date },
  ): Promise<number> {
    if (await this.suppressed(client, args.appointmentId)) return 0;
    const plan: { template: AppointmentNotificationTemplate; sendAt: Date }[] = [
      { template: "appointment_no_show", sendAt: args.recordedAt },
      ...appointmentNurturePlan(args.recordedAt),
    ];
    return this.insert(client, args.orgId, args.appointmentId, args.sequence, plan);
  }

  /** The courtesy note after an appointment that happened. One row, due now. */
  async scheduleAttendedNote(
    client: Queryable,
    args: { orgId: string; appointmentId: string; sequence: number; recordedAt: Date },
  ): Promise<number> {
    if (await this.suppressed(client, args.appointmentId)) return 0;
    return this.insert(client, args.orgId, args.appointmentId, args.sequence, [
      { template: "appointment_attended", sendAt: args.recordedAt },
    ]);
  }

  /** The confirmation, due immediately. 0032's message, in tenant scope. */
  async scheduleConfirmation(
    client: Queryable,
    args: { orgId: string; appointmentId: string; sequence: number; now?: Date },
  ): Promise<number> {
    if (await this.suppressed(client, args.appointmentId)) return 0;
    return this.insert(client, args.orgId, args.appointmentId, args.sequence, [
      { template: "appointment_confirmed", sendAt: args.now ?? new Date() },
    ]);
  }

  /** Everything still pending for a sequence becomes `dead`, with a reason. */
  async cancelPending(
    client: Queryable,
    appointmentId: string,
    sequence: number,
    reason: string,
  ): Promise<number> {
    const { rowCount } = await client.query(CANCEL_SQL, [
      appointmentId,
      sequence,
      reason.slice(0, 500),
    ]);
    return rowCount ?? 0;
  }

  /** The shared predicate, asked of one appointment. */
  async suppressed(client: Queryable, appointmentId: string): Promise<boolean> {
    const { rows } = await client.query<{ suppressed: boolean }>(SUPPRESSED_SQL, [appointmentId]);
    return Boolean(rows[0]?.suppressed);
  }

  private async insert(
    client: Queryable,
    orgId: string,
    appointmentId: string,
    sequence: number,
    plan: { template: AppointmentNotificationTemplate; sendAt: Date }[],
  ): Promise<number> {
    let queued = 0;
    for (const row of plan) {
      const { rowCount } = await client.query(ENQUEUE_SQL, [
        orgId,
        appointmentId,
        sequence,
        row.template,
        row.sendAt.toISOString(),
      ]);
      queued += rowCount ?? 0;
    }
    return queued;
  }
}
