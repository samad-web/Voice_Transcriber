import { getAdminPool } from "@aura/db";
import type { MessageTemplateKey } from "@aura/shared";
import { backoffSeconds, type DbClient } from "./crm-dispatch";
import {
  getFollowUpDispatcher,
  renderFollowUp,
  type FollowUpTemplate,
} from "./funnel-followup";
import { renderWhatsAppMessage } from "./message-templates";
import { getWhatsAppSender } from "./whatsapp";

/**
 * Durable queue for funnel follow-up messages — doc 16 §3.6.
 *
 * Deliberately the same shape as `outbox.ts`: the queue IS the table, one row
 * per (submission, template), holding the pending send and when it may next be
 * tried. Attempts, exponential backoff (shared with the CRM outbox — the same
 * `backoffSeconds`), and a terminal `dead` state. A worker restart loses
 * nothing. §3.6 says to reuse this pattern rather than invent a second delivery
 * mechanism, and the reason is the same one that justified it for CRM sends: a
 * lead that cost real money to acquire must not be destroyed by an
 * infrastructure hiccup.
 *
 * ── Three differences from the CRM outbox, each forced ──────────────────────
 *
 * 1. **No RLS context.** `marketing.funnel_submissions` has no `org_id` — doc 16
 *    §3.1 puts pre-customer personal data outside the tenant model on purpose.
 *    So this runs on the admin pool throughout and never calls
 *    `withOrgContext`. There is no tenant to scope to, and inventing one would
 *    be exactly the fake-org hack §3.1 rejects.
 *
 * 2. **No inline first attempt.** The CRM outbox tries once immediately so the
 *    happy path is instant. This one does not: §3.6 requires the follow-up be
 *    "async via the worker, not inline in the request", and the enqueue happens
 *    in a public, unauthenticated server action where an SMTP timeout would
 *    become the visitor's page load.
 *
 * 3. **It tolerates its own table not existing.** See `tableReady()`.
 *
 * ── The table ───────────────────────────────────────────────────────────────
 *
 * `marketing.funnel_followups` EXISTS. Created by migration 0024 and applied to
 * production on 2026-08-08, after living only as a comment here since slice 4.
 * Migration 0025 then added `channel`.
 *
 * Current shape, in short: (submission_id, template, channel) is unique, status
 * is pending | sent | dead, and `next_attempt_at IS NULL` means terminal — the
 * same convention crm_sync_log uses. The authoritative definition is the two
 * migration files; this comment is a pointer, not a second copy, because a
 * duplicated schema in a comment is a schema that goes out of date.
 *
 * TEMPLATES: 'disqualified_neutral' | 'custom_crm_info' | 'rejected'.
 * CHANNELS:  'email' | 'whatsapp'.
 */

const MAX_ATTEMPTS = positiveInt(process.env.FUNNEL_FOLLOWUP_MAX_ATTEMPTS, 6);

/** The stages `renderFollowUp` has email copy for. See the email branch below. */
const EMAIL_TEMPLATES: readonly FollowUpTemplate[] = [
  "disqualified_neutral",
  "custom_crm_info",
  "rejected",
];

/**
 * Past this age a queued follow-up is dropped rather than sent.
 *
 * The CRM outbox has no such guard and does not need one: a lead landing in a
 * customer's CRM three weeks late is merely late. An email that says "thanks
 * for getting in touch" arriving three weeks after someone filled a form reads
 * as incompetence, and if the delay was a month-long outage it arrives to
 * people who have long since bought elsewhere. Dropping it is the better
 * outcome, and the row keeps `error = 'expired'` so the miss is visible rather
 * than silent.
 */
const MAX_AGE_DAYS = positiveInt(process.env.FUNNEL_FOLLOWUP_MAX_AGE_DAYS, 14);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Queue a follow-up. Idempotent per (submission, template).
 *
 * `ON CONFLICT DO NOTHING`, NOT the CRM outbox's `DO UPDATE`: re-processing a
 * call must redeliver the same lead to a CRM, but a repeat form fill must not
 * re-send the same email to a human. Different rule, opposite conflict clause,
 * and getting that backwards is how a mildly interested visitor receives the
 * same message five times.
 *
 * Takes a `DbClient` so it can be driven from a fake in tests and from
 * whichever pool or transaction the caller already holds. The funnel's server
 * action is expected to call this inside the same transaction that writes the
 * submission, so a rolled-back submission cannot leave an orphan follow-up.
 */
export async function enqueueFollowUp(
  client: DbClient,
  submissionId: string,
  /**
   * `MessageTemplateKey`, not `FollowUpTemplate`: the catalogue in @aura/shared
   * is the wider one, because WhatsApp has stages email has no copy for
   * (booking_confirmed, reminder_followup). Queuing one of those on the EMAIL
   * channel is caught in the drain and dead-lettered rather than sent blank.
   */
  template: MessageTemplateKey,
  /**
   * REQUIRED, with no default, on purpose. This used to insert without naming a
   * channel and the column defaults to 'email' — so a caller that simply forgot
   * would silently queue mail, which is the exact thing currently on hold.
   * Making it explicit means the compiler asks the question.
   */
  channel: "email" | "whatsapp",
): Promise<void> {
  // ON CONFLICT names all THREE columns because migration 0025 widened the
  // unique index to (submission_id, template, channel). Postgres requires the
  // conflict target to match an actual unique index, so the old two-column
  // form would not have silently over-deduped — it would have thrown
  // "no unique or exclusion constraint matching the ON CONFLICT specification"
  // on the first call. Nothing calls this yet, which is why it went unnoticed.
  await client.query(
    `INSERT INTO marketing.funnel_followups
       (submission_id, template, channel, status, attempts, next_attempt_at)
     VALUES ($1, $2, $3, 'pending', 0, now())
     ON CONFLICT (submission_id, template, channel) DO NOTHING`,
    [submissionId, template, channel],
  );
}

/**
 * Whether slice 4's migration has landed.
 *
 * Kept after migration 0024 created the table in production, because the check
 * costs one catalogue lookup and is the only thing standing between a
 * not-yet-migrated environment and an error every 60 seconds. Without it the
 * drain interval would throw an undefined-table error every 60 seconds forever,
 * burying real errors in the log — a self-inflicted outage on a service that is
 * currently processing real customers' calls.
 *
 * Only the positive answer is cached. A negative is re-checked each tick, which
 * is one cheap catalogue lookup and means the drain starts working the moment
 * the migration runs, with no restart.
 */
let tableConfirmed = false;
async function tableReady(): Promise<boolean> {
  if (tableConfirmed) return true;
  const { rows } = await getAdminPool().query<{ exists: string | null }>(
    `SELECT to_regclass('marketing.funnel_followups')::text AS exists`,
  );
  tableConfirmed = Boolean(rows[0]?.exists);
  return tableConfirmed;
}

/** Tests only. */
export function resetFollowUpTableCacheForTests(): void {
  tableConfirmed = false;
}

/**
 * Send everything due. Returns how many rows were attempted.
 *
 * The join to `funnel_submissions` is what supplies the recipient, so a
 * submission erased under a DPDP request takes its queued follow-up with it
 * (the FK cascades) and an inner join means a half-deleted row is simply never
 * picked up.
 */
export async function drainFollowUps(limit = 100): Promise<number> {
  if (!(await tableReady())) return 0;

  const pool = getAdminPool();

  // Expire the stale ones first, so they are never rendered or sent.
  const { rowCount: expired } = await pool.query(
    `UPDATE marketing.funnel_followups
        SET status = 'dead', error = 'expired', next_attempt_at = NULL, updated_at = now()
      WHERE status = 'pending'
        AND created_at < now() - make_interval(days => $1)`,
    [MAX_AGE_DAYS],
  );
  if (expired) {
    console.warn(`funnel follow-up: expired ${expired} message(s) older than ${MAX_AGE_DAYS}d`);
  }

  const { rows: due } = await pool.query<{
    id: string;
    submission_id: string;
    template: MessageTemplateKey;
    channel: "email" | "whatsapp";
    attempts: number;
    name: string;
    email: string;
    phone_e164: string | null;
    whatsapp_e164: string | null;
  }>(
    `SELECT f.id, f.submission_id, f.template, f.channel, f.attempts,
            s.name, s.email, s.phone_e164, s.whatsapp_e164
       FROM marketing.funnel_followups f
       JOIN marketing.funnel_submissions s ON s.id = f.submission_id
      WHERE f.status = 'pending'
        AND f.next_attempt_at IS NOT NULL
        AND f.next_attempt_at <= now()
      ORDER BY f.next_attempt_at
      LIMIT $1`,
    [limit],
  );
  if (due.length === 0) return 0;

  const dispatcher = getFollowUpDispatcher();
  let processed = 0;

  for (const row of due) {
    const attempts = row.attempts + 1;

    let result: Awaited<ReturnType<typeof dispatcher.send>>;
    try {
      if (row.channel === "whatsapp") {
        // ROUTED BY CHANNEL. Before this existed every row went to the email
        // dispatcher, so a queued WhatsApp message would have been rendered as
        // an email and sent to the address instead of the number — the wrong
        // copy, on the wrong channel, reported as a success.
        //
        // whatsapp_e164 first, then phone_e164: the form asks whether WhatsApp
        // is the same number and stores the answer, so preferring it honours
        // what the person actually told us.
        const to = row.whatsapp_e164 || row.phone_e164;
        if (!to) {
          result = { ok: false, error: "no phone number on submission", terminal: true };
        } else {
          // The copy comes from the database now, so it can be missing or
          // switched off. Both are terminal: retrying a template an operator
          // deliberately disabled would send the message they told us not to,
          // as soon as the backoff happened to land after they re-enabled it.
          const rendered = await renderWhatsAppMessage(row.template, { name: row.name });
          if (!rendered.ok) {
            result = { ok: false, error: rendered.reason, terminal: true };
          } else {
            const wa = await getWhatsAppSender().send({ to, text: rendered.text });
            // Normalised into the email dispatcher's shape so one status machine
            // governs both channels: `retryable` inverts to `terminal`.
            result = wa.ok
              ? { ok: true, messageId: wa.providerMessageId }
              : { ok: false, error: wa.error, terminal: !wa.retryable };
          }
        }
      } else if (EMAIL_TEMPLATES.includes(row.template as FollowUpTemplate)) {
        const message = renderFollowUp(row.template as FollowUpTemplate, {
          submissionId: row.submission_id,
          name: row.name,
          email: row.email,
        });
        result = await dispatcher.send(message);
      } else {
        // A WhatsApp-only stage queued on the email channel. Terminal, and said
        // plainly — the alternative is renderFollowUp throwing a generic
        // "unknown template" that reads like a corrupt row rather than a
        // missing translation.
        result = {
          ok: false,
          error: `no email copy exists for "${row.template}" — it is a WhatsApp-only stage`,
          terminal: true,
        };
      }
    } catch (err) {
      // An unknown template or a dispatcher that threw. Terminal either way —
      // both are bugs, and retrying a bug six times only delays noticing it.
      result = { ok: false, error: `render/send threw: ${(err as Error).message}`, terminal: true };
    }

    const exhausted = attempts >= MAX_ATTEMPTS;
    const status = result.ok ? "sent" : result.terminal || exhausted ? "dead" : "pending";
    const nextAttempt = status === "pending" ? backoffSeconds(attempts) : null;

    await pool.query(
      `UPDATE marketing.funnel_followups
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
      // The CHANNEL's transport, not `dispatcher.name`. A WhatsApp message that
      // dead-lettered used to be reported as having failed "via log-only",
      // because that is the EMAIL dispatcher's name and it was interpolated
      // regardless of which channel the row was on. Anyone reading that log
      // would go looking at mail configuration for a WhatsApp problem.
      const via = row.channel === "whatsapp" ? getWhatsAppSender().name : dispatcher.name;
      console.error(
        `funnel follow-up ${row.id}: gave up after ${attempts} attempt(s) via ` +
          `${via} — ${result.ok ? "" : result.error}`,
      );
    }
    processed++;
  }

  if (processed > 0) {
    // Counted per channel for the same reason: "attempted 1 message(s) via
    // log-only" was printed after a WhatsApp message had genuinely been
    // delivered through Evolution, which reads as a failure and is not one.
    const wa = due.filter((r) => r.channel === "whatsapp").length;
    const mail = due.length - wa;
    const parts = [
      wa > 0 ? `${wa} via ${getWhatsAppSender().name}` : null,
      mail > 0 ? `${mail} via ${dispatcher.name}` : null,
    ].filter(Boolean);
    console.log(`funnel follow-up: attempted ${processed} message(s) — ${parts.join(", ")}`);
  }
  return processed;
}

/**
 * Slower than the CRM outbox's 15s on purpose. A follow-up email has no
 * latency requirement worth a tighter loop, and this is one more timer on a
 * process that is already running five.
 */
export function startFollowUpDrain(): NodeJS.Timeout {
  const interval = positiveInt(process.env.FUNNEL_FOLLOWUP_INTERVAL_MS, 60_000);
  return setInterval(
    () => void drainFollowUps().catch((err) => console.error("funnel follow-up:", err)),
    interval,
  );
}
