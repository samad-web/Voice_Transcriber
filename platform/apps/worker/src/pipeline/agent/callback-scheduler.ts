import { getAdminPool, type PoolClient, gateFor, gateSubjectForTelecaller, withOrgContext } from "@aura/db";
import {
  type CallbackPolicy,
  DEFAULT_CALLBACK_POLICY,
  HANDSET_ALERT_STYLE,
  HANDSET_ALERT_TTL_MINUTES,
  autoCompletes,
  shouldDeliverReminder,
} from "@aura/shared";
import { announce } from "../realtime";

/**
 * §10A.4 - REMINDERS, DELIVERED BY A SERVER
 * (Build docs/transcript-agent-build-plan §10A.2, §10A.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  "DELIVERED BY A SERVER-SIDE SCHEDULER, NOT CLIENT TIMERS"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §10A.4 asks for three properties and this sweep is all three:
 *
 *   "Reminders SURVIVE RESTARTS"  - the schedule is rows, not `setTimeout`.
 *   "are IDEMPOTENT"              - the claim is an optimistic UPDATE, so two
 *                                   workers draining one tick produce one
 *                                   popup.
 *   "have TRACKED STATES"         - `scheduled -> delivered -> acted`, plus
 *                                   `held` for §10A.4's smart suppression.
 *
 * A browser timer fails all three: it dies at lunchtime, it fires twice if the
 * tab is duplicated, and nothing anywhere records that it fired.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  TWO DELIVERY CHANNELS, BECAUSE MOST TELECALLERS NEVER SIGN IN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `notifications` (0048) reaches a person signed in to the console.
 * `handset_alerts` (0150) reaches a paired phone. 0150's header is explicit
 * that most telecallers carry a phone and nothing else - "a bell item
 * addressed to them is addressed to nobody" - so a reminder that only wrote a
 * notification would silently reach no one on a real floor.
 *
 * Both are written where both identities exist. The dedupe keys differ so one
 * person with both does not get one popup and lose the other.
 */

const FEATURE = "transcript_agent" as const;

export interface ReminderSweepResult {
  delivered: number;
  held: number;
  expired: number;
  due: number;
  autoCompleted: number;
}

/**
 * One tick.
 *
 * ── THE ORDER IS DELIBERATE ──────────────────────────────────────────────
 *
 *   1. AUTO-COMPLETE first. §10A.2: a connected call inside the window closes
 *      the callback. Doing this before the reminders means a telecaller who
 *      has already rung does not get a popup telling them to.
 *   2. The DUE transition, so the list's sections are right before anything
 *      is delivered.
 *   3. The reminders themselves.
 *
 * The reverse order is the one that annoys people: popup, then the system
 * notices they already called.
 */
export async function sweepCallbackReminders(limit = 200): Promise<ReminderSweepResult> {
  const pool = getAdminPool();
  const result: ReminderSweepResult = {
    delivered: 0,
    held: 0,
    expired: 0,
    due: 0,
    autoCompleted: 0,
  };

  // Orgs with any live callback at all. Cheaper than walking every tenant:
  // most have none, and this runs every minute.
  const { rows: orgs } = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM callbacks
      WHERE status IN ('scheduled', 'due', 'reminded', 'in_progress')`,
  );

  for (const { org_id: orgId } of orgs) {
    try {
      await withOrgContext(orgId, async (client) => {
        const policy = await loadPolicy(client);
        result.autoCompleted += await autoCompleteFromCalls(client, orgId, policy);
        result.due += await markDue(client, orgId, policy);
        const delivered = await deliverReminders(client, orgId, policy, limit);
        result.delivered += delivered.delivered;
        result.held += delivered.held;
        result.expired += delivered.expired;
      });
    } catch (error) {
      // One tenant's failure must not stop the sweep for the rest - the same
      // shape every other sweep in this directory has.
      console.error(`callback reminder sweep failed for org ${orgId}:`, error);
    }
  }

  return result;
}

/**
 * §10A.2's auto-complete: "a callback is auto-completed when a connected call
 * to that lead and contact finishes inside the window with duration at or
 * above a threshold (default 20 seconds)."
 *
 * ── MATCHED ON THE NUMBER KEY, NOT ON THE LEAD ─────────────────────────────
 *
 * §10A.1 lets a callback name a DIFFERENT contact ("call my brother on this
 * number"), and §10A.2 says "to that lead AND CONTACT". So a call to the
 * lead's own number must not close a callback that was about the brother.
 * `calls.remote_number_key` is the join, which is the same key 0133 and 0146
 * use.
 */
async function autoCompleteFromCalls(
  client: PoolClient,
  orgId: string,
  policy: CallbackPolicy,
): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    due_at: string;
    window_start: string | null;
    window_end: string | null;
    call_id: string;
    started_at: string;
    duration_s: number;
    status: string;
  }>(
    `SELECT cb.id, cb.due_at, cb.window_start, cb.window_end,
            c.id AS call_id, c.started_at, c.duration_s, c.status
       FROM callbacks cb
       JOIN leads l ON l.id = cb.lead_id
       JOIN calls c
         ON c.remote_number_key = COALESCE(cb.number_key, l.contact_number_key)
        AND c.started_at > cb.created_at
       WHERE cb.status IN ('scheduled', 'due', 'reminded', 'in_progress')
         AND c.started_at > now() - interval '2 days'
       ORDER BY c.started_at DESC
       LIMIT 500`,
  );

  let completed = 0;
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.id)) continue;
    const closes = autoCompletes(
      {
        startedAt: new Date(row.started_at),
        durationSeconds: Number(row.duration_s ?? 0),
        // A call that never connected is a ring-out. 0133's `NO_AUDIO` is
        // exactly that, and treating it as a completion would mark a
        // commitment kept because somebody's phone rang.
        connected: row.status !== "NO_AUDIO" && Number(row.duration_s ?? 0) > 0,
      },
      {
        dueAt: new Date(row.due_at),
        windowStart: row.window_start ? new Date(row.window_start) : null,
        windowEnd: row.window_end ? new Date(row.window_end) : null,
      },
      policy,
    );
    if (!closes) continue;

    const { rowCount } = await client.query(
      `UPDATE callbacks
          SET status = 'completed', completed_at = now(), auto_completed = true,
              completed_call_id = $2, attempts = attempts + 1,
              last_attempt_at = $3, outcome = 'reached on a later call',
              updated_at = now()
        WHERE id = $1
          AND status IN ('scheduled', 'due', 'reminded', 'in_progress')`,
      [row.id, row.call_id, row.started_at],
    );
    if ((rowCount ?? 0) === 0) continue;

    seen.add(row.id);
    completed += 1;

    // The reminders for a callback that is done are noise. Cancelled rather
    // than deleted, so the delivery history survives the completion.
    await client.query(
      `UPDATE callback_reminders
          SET state = 'cancelled', held_reason = 'the customer was reached', updated_at = now()
        WHERE callback_id = $1 AND state IN ('scheduled', 'held')`,
      [row.id],
    );
    // And the escalations that have not fired. A SENT one is history and stays.
    await client.query(
      `DELETE FROM callback_escalations WHERE callback_id = $1 AND sent_at IS NULL`,
      [row.id],
    );
  }

  if (completed > 0) announce(orgId, "lead", "updated", null);
  return completed;
}

/** §10A.2's `scheduled -> due` transition, so the list's sections are right. */
async function markDue(
  client: PoolClient,
  orgId: string,
  policy: CallbackPolicy,
): Promise<number> {
  void policy;
  const { rowCount } = await client.query(
    `UPDATE callbacks
        SET status = 'due', updated_at = now()
      WHERE status = 'scheduled' AND due_at <= now()`,
  );
  if ((rowCount ?? 0) > 0) announce(orgId, "lead", "updated", null);
  return rowCount ?? 0;
}

/**
 * §10A.4's delivery, with its suppression rules.
 *
 * ── THE GATE IS RE-CHECKED PER TELECALLER ────────────────────────────────
 *
 * §3A.4: "Scheduled jobs and sync (calendar webhooks, reminders, digests) -
 * SKIP USERS WITHOUT THE FEATURE." An owner who switched the assistant off for
 * one person this morning must not have that person's phone go off this
 * afternoon about a callback it created last week.
 *
 * Per telecaller and not per org, because that is the granularity the gate
 * has - and a per-org check would either silence a whole floor for one
 * person's setting or ignore it.
 */
async function deliverReminders(
  client: PoolClient,
  orgId: string,
  policy: CallbackPolicy,
  limit: number,
): Promise<{ delivered: number; held: number; expired: number }> {
  const { rows } = await client.query<ReminderRow>(
    `SELECT r.id, r.kind, r.channel, r.scheduled_at, r.callback_id,
            cb.due_at, cb.committed, cb.requested_text, cb.contact_name,
            cb.contact_phone_last3, cb.assigned_user_id, cb.assigned_telecaller_id,
            cb.lead_id, cb.status AS callback_status,
            pref.sound, pref.dnd_until, pref.channels AS pref_channels,
            -- §10A.4's "if the telecaller is on a call, queue the popup and
            -- show it right after the call ends". A call still in flight is
            -- one whose status is not terminal.
            EXISTS (
              SELECT 1 FROM calls c
               WHERE c.telecaller_id = cb.assigned_telecaller_id
                 AND c.started_at > now() - interval '30 minutes'
                 AND c.status NOT IN ('COMPLETE', 'NO_AUDIO',
                                      'FAILED_TRANSCODE', 'FAILED_ASR',
                                      'FAILED_ANALYZE', 'FAILED_CRM',
                                      'FAILED_UPLOAD', 'TRANSCRIPTION_OFF')
            ) AS on_call
       FROM callback_reminders r
       JOIN callbacks cb ON cb.id = r.callback_id
       LEFT JOIN callback_preferences pref ON pref.user_id = cb.assigned_user_id
      WHERE r.state IN ('scheduled', 'held')
        AND r.scheduled_at <= now()
        AND cb.status IN ('scheduled', 'due', 'reminded', 'in_progress')
      ORDER BY r.scheduled_at
      LIMIT $1`,
    [limit],
  );

  let delivered = 0;
  let held = 0;
  let expired = 0;

  for (const row of rows) {
    const decision = shouldDeliverReminder(
      new Date(row.scheduled_at),
      {
        now: new Date(),
        onCall: Boolean(row.on_call),
        // The telecaller's own Do Not Disturb. §10A.4: it silences the
        // REMINDER only - "missed-callback rules still apply during DND",
        // which the escalation sweep honours by not consulting this at all.
        doNotDisturb: row.dnd_until ? new Date(row.dnd_until).getTime() > Date.now() : false,
        timeZone: policy.quietStartMinute === null ? "UTC" : "Asia/Kolkata",
      },
      policy,
    );

    if (!decision.deliver) {
      if (decision.reason === "expired") {
        await client.query(
          `UPDATE callback_reminders
              SET state = 'expired',
                  held_reason = 'nobody collected this in time, so it was dropped',
                  updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        expired += 1;
      } else if (decision.reason !== "not_yet") {
        await client.query(
          `UPDATE callback_reminders
              SET state = 'held', held_reason = $2, attempts = attempts + 1, updated_at = now()
            WHERE id = $1`,
          [row.id, decision.reason],
        );
        held += 1;
      }
      continue;
    }

    // ── THE CLAIM. Optimistic, so two workers produce one popup. ──────────
    const { rowCount } = await client.query(
      `UPDATE callback_reminders
          SET state = 'delivered', delivered_at = now(), updated_at = now()
        WHERE id = $1 AND state IN ('scheduled', 'held')`,
      [row.id],
    );
    if ((rowCount ?? 0) === 0) continue;

    // §3A.4's per-telecaller gate.
    if (row.assigned_telecaller_id) {
      const subject = await gateSubjectForTelecaller(client, row.assigned_telecaller_id);
      const gate = await gateFor(client, FEATURE, subject);
      if (!gate.enabled || !gate.capabilities.includes("callbacks")) {
        await client.query(
          `UPDATE callback_reminders
              SET state = 'cancelled',
                  held_reason = 'the assistant is no longer switched on for this person',
                  updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        continue;
      }
    }

    const who = row.contact_name?.trim() || `…${row.contact_phone_last3 ?? ""}`;
    const title =
      row.kind === "pre"
        ? `Call ${who} in a few minutes`
        : row.kind === "nudge"
          ? `Still to call ${who}`
          : `Call ${who} now`;
    const body = row.requested_text
      ? `They asked: "${row.requested_text.slice(0, 200)}"`
      : "They asked to be called back.";

    if (row.channel === "in_app" && row.assigned_user_id) {
      await client.query(
        `INSERT INTO notifications
           (org_id, user_id, kind, title, body, link_path, dedupe_key)
         VALUES ($1, $2, 'callback_due', $3, $4, $5, $6)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          orgId,
          row.assigned_user_id,
          title,
          body,
          "/owner/callbacks",
          // The KIND is in the key, so the pre-reminder, the due popup and the
          // nudge are three rows rather than one collapsed one.
          `callback:${row.callback_id}:${row.kind}`,
        ],
      );
      delivered += 1;
    }

    if (row.channel === "push" && row.assigned_telecaller_id) {
      await client.query(
        `INSERT INTO handset_alerts
           (org_id, telecaller_id, kind, style, title, body, expires_at, dedupe_key, lead_id)
         VALUES ($1, $2, 'callback_due', $3, $4, $5,
                 -- 0150 stores an INSTANT, not a TTL. The catalogue keeps the
                 -- minutes (HANDSET_ALERT_TTL_MINUTES) because that is the
                 -- policy; the row keeps the deadline because that is what a
                 -- phone collecting alerts has to compare against.
                 now() + ($6 || ' minutes')::interval, $7, $8)
         ON CONFLICT (telecaller_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          orgId,
          row.assigned_telecaller_id,
          HANDSET_ALERT_STYLE.callback_due,
          title,
          body,
          HANDSET_ALERT_TTL_MINUTES.callback_due,
          `callback:${row.callback_id}:${row.kind}`,
          row.lead_id,
        ],
      );
      delivered += 1;
    }

    // §10A.2's `reminded`. Only from the DUE reminder: the pre-reminder is a
    // heads-up and must not make the item look acted on, and the nudge
    // follows a `reminded` item by definition.
    if (row.kind === "due") {
      await client.query(
        `UPDATE callbacks SET status = 'reminded', updated_at = now()
          WHERE id = $1 AND status IN ('scheduled', 'due')`,
        [row.callback_id],
      );
    }
  }

  if (delivered > 0) announce(orgId, "notification", "created", null);
  return { delivered, held, expired };
}

interface ReminderRow {
  id: string;
  kind: "pre" | "due" | "nudge";
  channel: string;
  scheduled_at: string;
  callback_id: string;
  due_at: string;
  committed: boolean;
  requested_text: string | null;
  contact_name: string | null;
  contact_phone_last3: string | null;
  assigned_user_id: string | null;
  assigned_telecaller_id: string | null;
  lead_id: string | null;
  callback_status: string;
  sound: boolean | null;
  dnd_until: string | null;
  pref_channels: string[] | null;
  on_call: boolean | null;
}

/**
 * The effective policy for this org. Merged over the default rather than
 * parsed strictly, for the reason `CallbacksService.context` gives: a stored
 * policy written before a field existed is missing it, and a strict parse
 * would take the to-call list down for an org whose only mistake was
 * configuring the feature early.
 */
export async function loadPolicy(client: PoolClient): Promise<CallbackPolicy> {
  const { rows } = await client.query<{ params: Record<string, unknown> | null }>(
    `SELECT params FROM callback_policies
      WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`,
  );
  const stored = rows[0]?.params;
  return stored
    ? { ...DEFAULT_CALLBACK_POLICY, ...(stored as Partial<CallbackPolicy>) }
    : DEFAULT_CALLBACK_POLICY;
}

export function startCallbackReminderSweep(): NodeJS.Timeout {
  // Every minute. §10A.4's schedule has a minute's granularity (T-10, due,
  // +5), so a slower tick would make the popup late by up to its own interval -
  // and "five minutes late" is the whole thing this module exists to prevent.
  const intervalMs = Number(process.env.CALLBACK_REMINDER_INTERVAL_MS ?? 60_000);
  return setInterval(() => {
    sweepCallbackReminders().catch((error) =>
      console.error("callback reminder sweep failed:", error),
    );
  }, intervalMs);
}
