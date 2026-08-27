import { getAdminPool } from "@aura/db";
import { quietHoursFromEnv, quietWindowEndsAt, shouldHoldForQuietHours } from "@aura/shared";
import type { MessageChannel, MessageTemplateKey } from "@aura/shared";
import { backoffSeconds, type DbClient } from "./crm-dispatch";
import { getFollowUpDispatcher } from "./funnel-followup";
import { renderMessage } from "./message-templates";
import { mintRescheduleLink } from "./reschedule-tokens";
import { getWhatsAppSender } from "./whatsapp";

/**
 * The booking outbox — everything sent because of a CALL, not because of a
 * person.
 *
 * ── WHY A SECOND OUTBOX ────────────────────────────────────────────────────
 *
 * `marketing.funnel_followups` is keyed (submission_id, template, channel), and
 * that key is the feature: it makes "never message the same person twice for
 * the same stage" a database guarantee. It is the right rule for a rejection or
 * a went-quiet nudge, which happen at most once in a person's life here.
 *
 * It is the wrong rule for anything attached to a booking. Somebody who
 * reschedules needs a SECOND 24h/1h/5m sequence; somebody who no-shows, gets
 * nurtured, books again and no-shows again needs a second drip. Under the
 * per-person key the second sequence would silently ON CONFLICT DO NOTHING into
 * oblivion — the worst kind of bug, because it looks like the feature working.
 *
 * So this table is keyed (booking_slot_id, template, channel). Everything else
 * about it is `funnel-followup-outbox.ts` unchanged: the queue is the table,
 * attempts and exponential backoff, a terminal `dead` state, and a restart
 * loses nothing.
 *
 * ── THE NURTURE GUARD IS THE PART WORTH READING ────────────────────────────
 *
 * A nurture message is queued up to 72 hours before it is sent, and the whole
 * point of it is that the person has not become a customer. Three days is
 * plenty of time for them to have signed. So the drain re-checks conversion at
 * SEND time, not at queue time — the same shape as the resume nudge's "did they
 * finish the form in the meantime" check, and for the same reason: the worst
 * message in the catalogue is the one that is correct about a state that has
 * since changed.
 */

const MAX_ATTEMPTS = positiveInt(process.env.BOOKING_NOTIFY_MAX_ATTEMPTS, 6);

/**
 * Past this age a queued notification is dropped rather than sent.
 *
 * Tighter than the follow-up outbox's 14 days, because everything here is
 * anchored to a specific hour in the diary. A "your call is tomorrow" that
 * escapes a stuck queue three days late is not merely stale, it is wrong — it
 * describes an appointment that has already been and gone. Two days is enough
 * to survive a weekend outage and short enough that nothing arrives describing
 * the past.
 */
const MAX_AGE_DAYS = positiveInt(process.env.BOOKING_NOTIFY_MAX_AGE_DAYS, 2);

/** The stages whose whole premise is that the lead has not converted. */
function isNurture(template: string): boolean {
  return template === "nurture_1" || template === "nurture_2" || template === "nurture_3";
}

/** The stages that describe a call that has not happened yet. */
function isPreCallReminder(template: string): boolean {
  return (
    template === "reminder_call_24h" ||
    template === "reminder_call_1h" ||
    template === "reminder_call_5m"
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The zone booked times are stated in.
 *
 * Read exactly the way the website reads it — `SCHEDULER_TIMEZONE` or
 * Asia/Kolkata — including the empty-string handling, because compose passes
 * these as `${VAR:-}` and `??` keeps the empty string. That precise mistake
 * silently disabled the calendar on 2026-08-10; here it would hand Postgres
 * `AT TIME ZONE ''` and throw on every send instead, which is louder but no
 * more correct.
 */
function bookingTimeZone(): string {
  const raw = process.env.SCHEDULER_TIMEZONE;
  return raw && raw.trim() ? raw.trim() : "Asia/Kolkata";
}

/**
 * Queue a notification. Idempotent per (booking, template, channel).
 *
 * `ON CONFLICT DO NOTHING`, so a sweep that runs twice, or two workers racing,
 * cannot produce two reminders for one call.
 *
 * `sendAt` is the instant it becomes due — this is the one real difference from
 * the follow-up outbox, which always queues for "now". A reminder is inserted
 * the moment the booking is noticed and sits until its hour arrives, so the
 * schedule lives in the row rather than in a sweep that has to run at the right
 * minute. A worker down for six hours sends everything it owes on its next
 * tick, in order, rather than losing the window.
 */
export async function enqueueBookingNotification(
  client: DbClient,
  bookingSlotId: string,
  template: MessageTemplateKey,
  channel: MessageChannel,
  sendAt: Date | "now" = "now",
): Promise<void> {
  await client.query(
    `INSERT INTO marketing.booking_notifications
       (booking_slot_id, template, channel, status, attempts, next_attempt_at)
     VALUES ($1, $2, $3, 'pending', 0, COALESCE($4::timestamptz, now()))
     ON CONFLICT (booking_slot_id, template, channel) DO NOTHING`,
    [bookingSlotId, template, channel, sendAt === "now" ? null : sendAt.toISOString()],
  );
}

/**
 * Stop anything still queued for a booking that is no longer happening.
 *
 * Called when a slot is released — a rejection, or a reschedule. Without it,
 * somebody who moved their Tuesday call to Friday would still get "your call is
 * in about an hour" on Tuesday, from a row queued before they moved it.
 *
 * `dead` with a reason rather than deleted, for the reason 0032 gives: the
 * outbox is what an operator consults to find out what was sent to someone, and
 * a message deliberately not sent is a fact worth keeping.
 */
export async function cancelBookingNotifications(
  client: DbClient,
  bookingSlotId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE marketing.booking_notifications
        SET status = 'dead', error = $2, next_attempt_at = NULL, updated_at = now()
      WHERE booking_slot_id = $1
        AND status = 'pending'`,
    [bookingSlotId, reason.slice(0, 500)],
  );
}

/**
 * Whether migration 0053 has landed.
 *
 * Same tolerance the follow-up outbox keeps: without it, an environment where
 * the migration has not run would throw an undefined-table error every 60
 * seconds forever, burying real errors in the log. Only the positive answer is
 * cached, so the drain starts working the moment the migration runs, with no
 * restart.
 */
let tableConfirmed = false;
async function tableReady(): Promise<boolean> {
  if (tableConfirmed) return true;
  const { rows } = await getAdminPool().query<{ exists: string | null }>(
    `SELECT to_regclass('marketing.booking_notifications')::text AS exists`,
  );
  tableConfirmed = Boolean(rows[0]?.exists);
  return tableConfirmed;
}

/** Tests only. */
export function resetBookingNotificationCacheForTests(): void {
  tableConfirmed = false;
}

/**
 * Send everything due. Returns how many rows were attempted.
 *
 * The join to `booking_slots` and `funnel_submissions` supplies the recipient
 * and the call time, so an erasure request takes the queued message with it
 * — and an INNER join to the submission means a booking whose enquirer has been
 * detached (`submission_id` is ON DELETE SET NULL) is simply never picked up,
 * rather than dead-lettering with "no recipient".
 */
export async function drainBookingNotifications(limit = 100): Promise<number> {
  if (!(await tableReady())) return 0;

  const pool = getAdminPool();

  // Expire the stale ones first, so they are never rendered or sent.
  const { rowCount: expired } = await pool.query(
    `UPDATE marketing.booking_notifications
        SET status = 'dead', error = 'expired', next_attempt_at = NULL, updated_at = now()
      WHERE status = 'pending'
        AND next_attempt_at < now() - make_interval(days => $1)`,
    [MAX_AGE_DAYS],
  );
  if (expired) {
    console.warn(
      `booking notifications: expired ${expired} message(s) more than ${MAX_AGE_DAYS}d overdue`,
    );
  }

  const { rows: due } = await pool.query<{
    id: string;
    booking_slot_id: string;
    template: MessageTemplateKey;
    channel: MessageChannel;
    attempts: number;
    name: string;
    salutation: string | null;
    email: string;
    phone_e164: string | null;
    whatsapp_e164: string | null;
    converted: boolean;
    slot_label: string;
    meeting_url: string | null;
    starts_at: string;
    slot_status: string;
  }>(
    /**
     * The slot label is formatted in SQL, in the booking timezone, with the
     * SAME `to_char` masks the website used to tell them the time
     * (apps/marketing/lib/funnel/slots.ts). A message that names a different
     * hour from the confirmation screen — because one rendered in IST and the
     * other in the container's UTC — reads as a second, conflicting
     * appointment.
     */
    `SELECT n.id, n.booking_slot_id, n.template, n.channel, n.attempts,
            s.name, s.salutation, s.email, s.phone_e164, s.whatsapp_e164,
            (s.converted_org_id IS NOT NULL) AS converted,
            to_char(b.starts_at AT TIME ZONE $2, 'Dy, DD Mon')
              || ' at '
              || to_char(b.starts_at AT TIME ZONE $2, 'HH24:MI') AS slot_label,
            b.meeting_url,
            b.starts_at,
            b.status AS slot_status
       FROM marketing.booking_notifications n
       JOIN marketing.booking_slots b       ON b.id = n.booking_slot_id
       JOIN marketing.funnel_submissions s  ON s.id = b.submission_id
      WHERE n.status = 'pending'
        AND n.next_attempt_at IS NOT NULL
        AND n.next_attempt_at <= now()
      ORDER BY n.next_attempt_at
      LIMIT $1`,
    [limit, bookingTimeZone()],
  );
  if (due.length === 0) return 0;

  const dispatcher = getFollowUpDispatcher();
  let processed = 0;

  // Read once per drain, not per row: every row in this batch is being judged
  // against the same instant, and re-reading the clock mid-loop could hold
  // half a batch and send the other half across a 21:00 boundary.
  const quiet = quietHoursFromEnv();
  const now = new Date();

  for (const row of due) {
    // ── quiet hours ──────────────────────────────────────────────────────
    //
    // Before every other check, and deliberately NOT counted as an attempt: a
    // message held because of the hour has not failed to deliver. Letting it
    // consume a retry would walk it up the backoff ladder and eventually
    // dead-letter something that was never broken — a nurture message queued
    // on a Friday evening could exhaust itself over a weekend of quiet
    // windows and never be sent at all.
    //
    // Time-critical templates are exempt inside shouldHoldForQuietHours, so a
    // "your call starts in an hour" still goes out at 06:00.
    if (quiet && shouldHoldForQuietHours(row.template, now, quiet)) {
      await pool.query(
        `UPDATE marketing.booking_notifications SET next_attempt_at = $2 WHERE id = $1`,
        [row.id, quietWindowEndsAt(now, quiet)],
      );
      continue;
    }

    const attempts = row.attempts + 1;

    let result:
      | { ok: true; messageId: string }
      | { ok: false; error: string; terminal?: boolean };

    try {
      /**
       * Three state checks, all re-run at SEND time rather than trusted from
       * when the row was queued. Every one of them is a real gap between the
       * two moments.
       */
      if (row.slot_status !== "booked") {
        // Released or cancelled since. `cancelBookingNotifications` normally
        // catches this at the moment of release; this is the backstop for a
        // release that happened by some other path.
        result = {
          ok: false,
          error: `the booking is no longer held (slot is ${row.slot_status})`,
          terminal: true,
        };
      } else if (isNurture(row.template) && row.converted) {
        // They became a customer between the no-show and this message. Sending
        // a "still worth a look?" testimonial to somebody who has already
        // signed is the exact failure the drip's own premise forbids.
        result = { ok: false, error: "they converted before this was sent", terminal: true };
      } else if (isPreCallReminder(row.template) && new Date(row.starts_at) <= new Date()) {
        // The call has already started. A reminder that arrives afterwards is
        // worse than silence — it tells someone to join a meeting that is over.
        result = { ok: false, error: "the call had already started", terminal: true };
      } else {
        // Minted at SEND time, not at queue time, so the token's life starts
        // when the link reaches the person rather than when the sweep ran.
        // Optional: a null drops the reschedule sentence and the reminder still
        // says when the call is.
        const rescheduleLink = (await mintRescheduleLink(row.booking_slot_id)) ?? undefined;

        const rendered = await renderMessage(row.template, row.channel, {
          name: row.name,
          salutation: row.salutation,
          slot: row.slot_label,
          meetLink: row.meeting_url ?? undefined,
          rescheduleLink,
        });

        if (!rendered.ok) {
          // A missing, disabled, or wrong-channel template. All terminal:
          // retrying one an operator deliberately switched off would send the
          // message they told us not to, as soon as a backoff happened to land
          // after they re-enabled it.
          result = { ok: false, error: rendered.reason, terminal: true };
        } else if (row.channel === "whatsapp") {
          // whatsapp_e164 first, then phone_e164: the form asks whether
          // WhatsApp is the same number and stores the answer, so preferring it
          // honours what the person actually told us.
          const to = row.whatsapp_e164 || row.phone_e164;
          if (!to) {
            result = { ok: false, error: "no phone number on submission", terminal: true };
          } else {
            const wa = await getWhatsAppSender().send({ to, text: rendered.text });
            // Normalised into the email dispatcher's shape so one status machine
            // governs both channels: `retryable` inverts to `terminal`.
            result = wa.ok
              ? { ok: true, messageId: wa.providerMessageId }
              : { ok: false, error: wa.error, terminal: !wa.retryable };
          }
        } else {
          result = await dispatcher.send({
            to: { name: row.name, email: row.email },
            subject: rendered.subject ?? "",
            text: rendered.text,
          });
        }
      }
    } catch (err) {
      // Terminal either way — both are bugs, and retrying a bug six times only
      // delays noticing it.
      result = { ok: false, error: `render/send threw: ${(err as Error).message}`, terminal: true };
    }

    const exhausted = attempts >= MAX_ATTEMPTS;
    const status = result.ok ? "sent" : result.terminal || exhausted ? "dead" : "pending";
    const nextAttempt = status === "pending" ? backoffSeconds(attempts) : null;

    await pool.query(
      `UPDATE marketing.booking_notifications
          SET status = $2, attempts = $3, error = $4,
              provider_message_id = COALESCE($5, provider_message_id),
              last_attempt_at = now(), updated_at = now(),
              next_attempt_at = CASE WHEN $6::int IS NULL
                                     THEN NULL
                                     ELSE now() + make_interval(secs => $6::int) END
        WHERE id = $1`,
      [
        row.id,
        status,
        attempts,
        result.ok ? null : result.error.slice(0, 500),
        result.ok ? result.messageId : null,
        nextAttempt,
      ],
    );

    if (status === "dead") {
      const via = row.channel === "whatsapp" ? getWhatsAppSender().name : dispatcher.name;
      console.error(
        `booking notification ${row.id} (${row.template}/${row.channel}): ` +
          `gave up after ${attempts} attempt(s) via ${via} — ${result.ok ? "" : result.error}`,
      );
    }
    processed++;
  }

  if (processed > 0) {
    const wa = due.filter((r) => r.channel === "whatsapp").length;
    const mail = due.length - wa;
    const parts = [
      wa > 0 ? `${wa} via ${getWhatsAppSender().name}` : null,
      mail > 0 ? `${mail} via ${dispatcher.name}` : null,
    ].filter(Boolean);
    console.log(`booking notifications: attempted ${processed} message(s) — ${parts.join(", ")}`);
  }
  return processed;
}

/**
 * Every 60 seconds, matching the follow-up drain.
 *
 * The five-minute reminder is the tightest thing this queue carries, so a
 * minute of jitter on it is the worst case and is acceptable — the alternative
 * is a tighter loop on a process already running eight timers, to shave
 * seconds off a message whose whole job is "your call is about to start".
 */
export function startBookingNotificationDrain(): NodeJS.Timeout {
  const interval = positiveInt(process.env.BOOKING_NOTIFY_INTERVAL_MS, 60_000);
  return setInterval(
    () =>
      void drainBookingNotifications().catch((err) =>
        console.error("booking notifications:", err),
      ),
    interval,
  );
}
