import { getAdminPool, type PoolClient, gateFor, gateSubjectForTelecaller, withOrgContext } from "@aura/db";
import {
  type CallbackPolicy,
  type EscalationRecipient,
  HANDSET_ALERT_STYLE,
  HANDSET_ALERT_TTL_MINUTES,
  callbackToTask,
  dueEscalations,
  isMissed,
  nextCallbackRetryAt,
  placeInCallingHours,
  shouldEscalate,
} from "@aura/shared";
import { announce } from "../realtime";
import { loadPolicy } from "./callback-scheduler";

/**
 * §10A.5 - MISSED CALLBACKS, THE LADDER, AND THE RETRIES
 * (Build docs/transcript-agent-build-plan §10A.5, §10A.7).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE ONE DISTINCTION EVERYTHING HERE TURNS ON
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §10A.5: "an unanswered attempt is NOT 'missed'; it counts as an attempt and
 * follows the retry rules."
 *
 * A telecaller who rang and got no answer did their job. Escalating them to
 * their manager for it is how a floor learns that the system is wrong about
 * them - and once a floor believes that, every alert this module sends is
 * noise. `isMissed` in `@aura/shared` holds the rule and is tested at the
 * boundary; this sweep only applies it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  DND SILENCES A REMINDER AND NEVER AN ESCALATION
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §10A.4: "respect quiet hours and the telecaller's Do Not Disturb.
 * MISSED-CALLBACK RULES STILL APPLY DURING DND."
 *
 * So this file does not read `callback_preferences.dnd_until` at all. That is
 * not an omission - it is the enforcement: if the escalation path consulted
 * the same switch the reminder path does, Do Not Disturb would become a way to
 * silently drop commitments.
 *
 * Quiet hours DO apply to the alert's delivery channel, which is a different
 * thing: the owner's +60 level is a DIGEST by default (§18) precisely so that
 * nobody's phone goes off at 02:00 about a callback.
 */

const FEATURE = "transcript_agent" as const;

export interface EscalationSweepResult {
  missed: number;
  escalated: number;
  reassigned: number;
  retried: number;
  unreachable: number;
}

export async function sweepCallbackEscalations(): Promise<EscalationSweepResult> {
  const pool = getAdminPool();
  const result: EscalationSweepResult = {
    missed: 0,
    escalated: 0,
    reassigned: 0,
    retried: 0,
    unreachable: 0,
  };

  const { rows: orgs } = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM callbacks
      WHERE status IN ('scheduled', 'due', 'reminded', 'missed', 'escalated')`,
  );

  for (const { org_id: orgId } of orgs) {
    try {
      await withOrgContext(orgId, async (client) => {
        const policy = await loadPolicy(client);
        result.missed += await detectMissed(client, orgId, policy);
        const sent = await runLadder(client, orgId, policy);
        result.escalated += sent.escalated;
        result.reassigned += sent.reassigned;
        const retries = await driveRetries(client, orgId, policy);
        result.retried += retries.retried;
        result.unreachable += retries.unreachable;
      });
    } catch (error) {
      console.error(`callback escalation sweep failed for org ${orgId}:`, error);
    }
  }

  return result;
}

/** §10A.5's definition, applied. */
async function detectMissed(
  client: PoolClient,
  orgId: string,
  policy: CallbackPolicy,
): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    status: string;
    due_at: string;
    attempts: number;
    last_attempt_at: string | null;
    committed: boolean;
  }>(
    `SELECT id, status, due_at, attempts, last_attempt_at, committed
       FROM callbacks
      WHERE status IN ('scheduled', 'due', 'reminded')
        AND due_at < now() - ($1 || ' minutes')::interval
      ORDER BY due_at
      LIMIT 500`,
    [String(policy.graceMinutes)],
  );

  const now = new Date();
  let missed = 0;

  for (const row of rows) {
    const yes = isMissed(
      {
        status: row.status as never,
        dueAt: new Date(row.due_at),
        attempts: row.attempts,
        lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : null,
        committed: row.committed,
      },
      policy,
      now,
    );
    if (!yes) continue;

    const { rowCount } = await client.query(
      `UPDATE callbacks SET status = 'missed', updated_at = now()
        WHERE id = $1 AND status IN ('scheduled', 'due', 'reminded')`,
      [row.id],
    );
    missed += rowCount ?? 0;
  }

  if (missed > 0) announce(orgId, "lead", "updated", null);
  return missed;
}

/**
 * §10A.5's ladder.
 *
 * ── LEVELS ARE PLANNED LAZILY, FROM `due_at` ─────────────────────────────
 *
 * `escalationLadder` computes the instants from the callback's own `due_at`,
 * so the ladder means what the owner configured regardless of how late this
 * sweep notices. Measured from the DETECTION instead, a sweep running every
 * five minutes would escalate at +20 on a good day and +35 on a slow one, and
 * the owner's "+60 min" level would land at an hour and a half.
 *
 * The rows are written only as each level comes DUE, not all at once on the
 * miss. A callback actioned at +30 should leave no trace of a +60 level that
 * was never going to fire.
 */
async function runLadder(
  client: PoolClient,
  orgId: string,
  policy: CallbackPolicy,
): Promise<{ escalated: number; reassigned: number }> {
  const { rows } = await client.query<CallbackForLadder>(
    `SELECT cb.id, cb.due_at, cb.committed, cb.status, cb.requested_text,
            cb.contact_name, cb.contact_phone_last3, cb.lead_id,
            cb.assigned_user_id, cb.assigned_telecaller_id,
            COALESCE(
              (SELECT array_agg(e.level) FROM callback_escalations e
                WHERE e.callback_id = cb.id AND e.sent_at IS NOT NULL),
              '{}') AS sent_levels,
            -- §10A.5: "acknowledgement stops further escalation FOR THAT
            -- LEVEL." A level somebody has acknowledged is not re-sent; the
            -- ladder continues above it.
            EXISTS (
              SELECT 1 FROM callback_escalations e2
               WHERE e2.callback_id = cb.id
                 AND e2.outcome IN ('reassigned', 'called', 'extended', 'dismissed')
            ) AS actioned
       FROM callbacks cb
      WHERE cb.status IN ('missed', 'escalated')
      ORDER BY cb.due_at
      LIMIT 300`,
  );

  const now = new Date();
  let escalated = 0;
  let reassigned = 0;

  for (const row of rows) {
    // §10A.5: "by default, escalate only COMMITTED callbacks. Soft and vague
    // ones remind only the telecaller."
    if (!shouldEscalate({ committed: row.committed }, policy)) continue;
    // A manager who has already dealt with it stops the ladder entirely -
    // which is different from acknowledging one level, and is why both are
    // read above.
    if (row.actioned) continue;

    // §3A.4's per-telecaller gate: an owner who switched the assistant off for
    // this person must not have their manager woken about its callbacks.
    if (row.assigned_telecaller_id) {
      const subject = await gateSubjectForTelecaller(client, row.assigned_telecaller_id);
      const gate = await gateFor(client, FEATURE, subject);
      if (!gate.enabled || !gate.capabilities.includes("callbacks")) continue;
    }

    const due = dueEscalations(
      new Date(row.due_at),
      policy,
      now,
      (row.sent_levels ?? []).map(Number),
    );

    for (const level of due) {
      const recipients = await resolveRecipients(client, row, level.recipients);

      if (recipients.length === 0) {
        // §10A.5: "if a recipient is VACANT or ON LEAVE, skip to the next
        // level or the configured fallback." Recorded rather than silently
        // skipped, so an owner can see that their ladder has a hole in it -
        // which is 0177's `position_vacant` problem in its most consequential
        // form.
        await client.query(
          `INSERT INTO callback_escalations
             (org_id, callback_id, level, recipient_kind, channel, action,
              scheduled_at, sent_at, resolution)
           VALUES ($1, $2, $3, 'owner', 'in_app', $4, $5, now(), 'no_recipient')
           ON CONFLICT DO NOTHING`,
          [orgId, row.id, level.level, level.action, level.at],
        );
        continue;
      }

      for (const recipient of recipients) {
        for (const channel of level.channels) {
          const { rowCount } = await client.query(
            `INSERT INTO callback_escalations
               (org_id, callback_id, level, recipient_kind, recipient_user_id,
                recipient_telecaller_id, recipient_position_id, channel, action,
                scheduled_at, sent_at, resolution)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), 'resolved')
             -- One row per level per recipient. A sweep that runs twice must
             -- not send the manager two alerts about one missed call.
             ON CONFLICT (callback_id, level, recipient_kind, recipient_user_id, recipient_position_id)
             DO NOTHING`,
            [
              orgId,
              row.id,
              level.level,
              recipient.kind,
              recipient.userId,
              recipient.telecallerId,
              recipient.positionId,
              channel,
              level.action,
              level.at,
            ],
          );
          if ((rowCount ?? 0) === 0) continue;

          await notifyEscalation(client, orgId, row, recipient, channel, level.level);
          escalated += 1;
        }
      }

      // §10A.5 level 3's action.
      if (level.action === "reassign") {
        reassigned += await autoReassign(client, orgId, row, policy);
      } else if (level.action === "raise_priority") {
        await client.query(
          `UPDATE callbacks
              SET priority_score = priority_score + 25,
                  priority_reason = priority_reason || $2::jsonb,
                  updated_at = now()
            WHERE id = $1`,
          [
            row.id,
            JSON.stringify([{ factor: "escalated and still not done", points: 25 }]),
          ],
        );
      }

      await client.query(
        `UPDATE callbacks SET status = 'escalated', updated_at = now()
          WHERE id = $1 AND status = 'missed'`,
        [row.id],
      );
    }
  }

  return { escalated, reassigned };
}

interface ResolvedRecipient {
  kind: EscalationRecipient["kind"];
  userId: string | null;
  telecallerId: string | null;
  positionId: string | null;
  name: string | null;
}

/**
 * §10A.5: "recipients are roles, positions or named users, RESOLVED THROUGH
 * THE ORG CHART'S REPORTING LINE."
 *
 * ── A SEAT, AND THEN WHOEVER IS SITTING IN IT ────────────────────────────
 *
 * The `manager` recipient walks `reporting_lines` from the assignee's own seat
 * to the seat above it, and then reads who currently holds that seat. Two
 * steps, because 0177's whole design is that the tree is made of SEATS: a
 * `memberships.manager_user_id` would have died with the person, and "the
 * manager resigned so their reports have no escalation path" is exactly the
 * Tuesday the org chart module exists for.
 *
 * `owner` falls back to every member holding the `owner` persona, and the
 * `owner_role = 'owner'` predicate is written with the NULL guard that the
 * 2026-10-02 fix added everywhere: a member added through the operator's
 * Members screen has a NULL persona and `resolveOwnerRole` reads that as
 * `owner`, so a bare equality reaches nobody in exactly the orgs most likely
 * to need it.
 */
async function resolveRecipients(
  client: PoolClient,
  callback: CallbackForLadder,
  recipients: readonly EscalationRecipient[],
): Promise<ResolvedRecipient[]> {
  const out: ResolvedRecipient[] = [];

  for (const recipient of recipients) {
    if (recipient.kind === "assignee") {
      if (callback.assigned_user_id || callback.assigned_telecaller_id) {
        out.push({
          kind: "assignee",
          userId: callback.assigned_user_id,
          telecallerId: callback.assigned_telecaller_id,
          positionId: null,
          name: null,
        });
      }
      continue;
    }

    if (recipient.kind === "user") {
      out.push({
        kind: "user",
        userId: recipient.userId,
        telecallerId: null,
        positionId: null,
        name: null,
      });
      continue;
    }

    if (recipient.kind === "position") {
      const { rows } = await client.query<{ user_id: string | null }>(
        `SELECT pa.user_id FROM position_assignments pa
          WHERE pa.position_id = $1 AND pa.end_date IS NULL
          LIMIT 1`,
        [recipient.positionId],
      );
      // A VACANT seat yields nothing, which is what makes §10A.5's "skip to
      // the next level" happen rather than an alert addressed to a position.
      if (rows[0]?.user_id) {
        out.push({
          kind: "position",
          userId: rows[0].user_id,
          telecallerId: null,
          positionId: recipient.positionId,
          name: null,
        });
      }
      continue;
    }

    if (recipient.kind === "manager") {
      const { rows } = await client.query<{ user_id: string; position_id: string }>(
        `WITH my_seat AS (
           SELECT pa.position_id
             FROM position_assignments pa
            WHERE pa.user_id = $1 AND pa.end_date IS NULL
            LIMIT 1
         )
         SELECT pa2.user_id, rl.manager_position_id AS position_id
           FROM my_seat
           JOIN reporting_lines rl ON rl.position_id = my_seat.position_id
                                  AND rl.effective_to IS NULL
           JOIN position_assignments pa2 ON pa2.position_id = rl.manager_position_id
                                        AND pa2.end_date IS NULL
          LIMIT 1`,
        [callback.assigned_user_id],
      );
      if (rows[0]) {
        out.push({
          kind: "manager",
          userId: rows[0].user_id,
          telecallerId: null,
          positionId: rows[0].position_id,
          name: null,
        });
      }
      continue;
    }

    // `owner`
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m
        -- The NULL guard. A member added through the operator's Members screen
        -- has no persona, and resolveOwnerRole reads an absent one as
        -- owner - so owner_role = 'owner' alone reaches nobody in exactly
        -- the orgs most likely to need an escalation path.
        WHERE m.owner_role = 'owner' OR m.owner_role IS NULL
        LIMIT 5`,
    );
    for (const row of rows) {
      out.push({
        kind: "owner",
        userId: row.user_id,
        telecallerId: null,
        positionId: null,
        name: null,
      });
    }
  }

  // Deduplicated by user: a floor where the manager IS an owner should get one
  // alert, not two.
  const seen = new Set<string>();
  return out.filter((recipient) => {
    const key = recipient.userId ?? recipient.telecallerId ?? "";
    if (!key || seen.has(key)) return key ? false : true;
    seen.add(key);
    return true;
  });
}

async function notifyEscalation(
  client: PoolClient,
  orgId: string,
  callback: CallbackForLadder,
  recipient: ResolvedRecipient,
  channel: string,
  level: number,
): Promise<void> {
  const who = callback.contact_name?.trim() || `…${callback.contact_phone_last3 ?? ""}`;
  const title =
    recipient.kind === "assignee"
      ? `You still owe ${who} a call`
      : `A promised call to ${who} was missed`;
  const body = callback.requested_text
    ? `They asked: "${callback.requested_text.slice(0, 160)}"`
    : "They were promised a call back.";

  // §18: the owner's level is a DIGEST, "to avoid alert fatigue". A digest row
  // is a notification with `deliver_after` set to the digest hour - 0109's own
  // mechanism, so one preference system governs both.
  if ((channel === "in_app" || channel === "digest") && recipient.userId) {
    await client.query(
      `INSERT INTO notifications
         (org_id, user_id, kind, title, body, link_path, dedupe_key, deliver_after)
       VALUES ($1, $2, 'callback_missed', $3, $4, $5, $6,
               CASE WHEN $7 = 'digest'
                    THEN date_trunc('day', now()) + interval '1 day' + interval '9 hours'
                    ELSE NULL END)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        orgId,
        recipient.userId,
        title,
        body,
        "/owner/callbacks",
        // The LEVEL is in the key, so a manager at +15 and an owner at +60 are
        // two rows while a sweep running twice is one.
        `callback_missed:${callback.id}:${level}`,
        channel,
      ],
    );
  }

  if (channel === "push") {
    const telecallerId =
      recipient.telecallerId ??
      (recipient.userId
        ? (
            await client.query<{ id: string }>(
              `SELECT id FROM telecallers WHERE user_id = $1 LIMIT 1`,
              [recipient.userId],
            )
          ).rows[0]?.id ?? null
        : null);
    if (telecallerId) {
      await client.query(
        `INSERT INTO handset_alerts
           (org_id, telecaller_id, kind, style, title, body, expires_at, dedupe_key, lead_id)
         VALUES ($1, $2, 'callback_escalated', $3, $4, $5,
                 now() + ($6 || ' minutes')::interval, $7, $8)
         ON CONFLICT (telecaller_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          orgId,
          telecallerId,
          HANDSET_ALERT_STYLE.callback_escalated,
          title,
          body,
          HANDSET_ALERT_TTL_MINUTES.callback_escalated,
          `callback_missed:${callback.id}:${level}`,
          callback.lead_id,
        ],
      );
    }
  }
}

/**
 * §10A.5 level 3: "auto-reassign to another telecaller, or raise priority and
 * keep in Overdue, per the org rule."
 *
 * ── BOTH PEOPLE ARE TOLD ────────────────────────────────────────────────
 *
 * §10A.3 says so for the absence case and it applies here: a commitment moving
 * off somebody's list without their knowing is how the same thing gets rung
 * twice, and a commitment arriving on somebody's list without their knowing is
 * how it gets rung never.
 */
async function autoReassign(
  client: PoolClient,
  orgId: string,
  callback: CallbackForLadder,
  policy: CallbackPolicy,
): Promise<number> {
  const { rows } = await client.query<{ user_id: string; telecaller_id: string | null }>(
    `SELECT m.user_id, t.id AS telecaller_id
       FROM memberships m
       LEFT JOIN telecallers t ON t.user_id = m.user_id
      WHERE m.user_id <> COALESCE($1, '00000000-0000-0000-0000-000000000000'::uuid)
        AND (m.owner_role IS NULL OR m.owner_role IN ('telecaller', 'sales', 'manager', 'owner'))
        -- Not somebody on approved leave: handing a missed commitment to an
        -- absent person is the failure this level exists to fix, repeated.
        AND NOT EXISTS (
          SELECT 1 FROM attendance_requests lr
           WHERE lr.kind = 'leave' AND lr.status = 'approved'
             AND lr.created_by = m.user_id
             AND current_date BETWEEN lr.start_date AND lr.end_date
        )
      ORDER BY (
        -- §10A.6 step 7's round-robin pool: the longest-idle person first.
        SELECT COALESCE(max(cb2.assigned_at), 'epoch'::timestamptz)
          FROM callbacks cb2 WHERE cb2.assigned_user_id = m.user_id
      )
      LIMIT 1`,
    [callback.assigned_user_id],
  );

  const target = rows[0];
  if (!target) return 0;

  const previousUserId = callback.assigned_user_id;

  await client.query(
    `UPDATE callbacks
        SET assigned_user_id = $2, assigned_telecaller_id = $3,
            assignment_reason = $4, assigned_at = now(),
            status = 'scheduled',
            -- Re-placed into calling hours from NOW: a callback reassigned the
            -- next working day is due now, not at yesterday's time.
            due_at = $5,
            updated_at = now()
      WHERE id = $1`,
    [
      callback.id,
      target.user_id,
      target.telecaller_id,
      "nobody actioned this, so it was passed on",
      placeInCallingHours(new Date(), policy, "Asia/Kolkata").dueAt,
    ],
  );

  // Both people. See the header.
  for (const [userId, title] of [
    [target.user_id, "A missed call-back has been passed to you"],
    [previousUserId, "A call-back has been passed to somebody else"],
  ] as const) {
    if (!userId) continue;
    await client.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
       VALUES ($1, $2, 'callback_missed', $3, $4, '/owner/callbacks', $5)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        orgId,
        userId,
        title,
        callback.contact_name
          ? `It is for ${callback.contact_name}.`
          : "It is for a customer who was promised a call.",
        `callback_reassigned:${callback.id}:${userId}`,
      ],
    );
  }

  return 1;
}

/**
 * §10A.5's retries: "for an unanswered attempt, retry after configurable
 * intervals, up to a maximum number of attempts. After the last attempt:
 * notify the manager and set `closed_unreachable`."
 */
async function driveRetries(
  client: PoolClient,
  orgId: string,
  policy: CallbackPolicy,
): Promise<{ retried: number; unreachable: number }> {
  const { rows } = await client.query<{
    id: string;
    attempts: number;
    max_attempts: number;
    last_attempt_at: string | null;
    assigned_user_id: string | null;
    contact_name: string | null;
  }>(
    `SELECT id, attempts, max_attempts, last_attempt_at, assigned_user_id, contact_name
       FROM callbacks
      WHERE status IN ('missed', 'escalated')
        AND attempts > 0
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY due_at
      LIMIT 200`,
  );

  let retried = 0;
  let unreachable = 0;

  for (const row of rows) {
    const nextAt = nextCallbackRetryAt(
      row.attempts,
      row.last_attempt_at ? new Date(row.last_attempt_at) : new Date(),
      { ...policy, maxAttempts: row.max_attempts },
      "Asia/Kolkata",
    );

    if (nextAt) {
      const { rowCount } = await client.query(
        `UPDATE callbacks
            SET status = 'scheduled', due_at = $2, next_attempt_at = $2, updated_at = now()
          WHERE id = $1 AND status IN ('missed', 'escalated')`,
        [row.id, nextAt],
      );
      retried += rowCount ?? 0;
      continue;
    }

    // The budget is spent.
    const { rowCount } = await client.query(
      `UPDATE callbacks
          SET status = 'closed_unreachable', next_attempt_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('missed', 'escalated')`,
      [row.id],
    );
    if ((rowCount ?? 0) === 0) continue;
    unreachable += 1;

    // §10A.5: "notify the manager". The "we tried to reach you" template is
    // deliberately NOT sent - `TRANSCRIPT_AGENT_DECISIONS.md` §4.6 records
    // why: this platform's standing rule is that nothing automated reaches a
    // customer without a person saying yes, and the `messaging` capability is
    // off by default with T2 sends. So a person is told, and they decide.
    if (row.assigned_user_id) {
      await client.query(
        `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
         VALUES ($1, $2, 'callback_missed', $3, $4, '/owner/callbacks', $5)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          orgId,
          row.assigned_user_id,
          `Could not reach ${row.contact_name ?? "a customer"} after ${row.max_attempts} tries`,
          "Nothing has been sent to them. Decide whether to keep trying or to let it go.",
          `callback_unreachable:${row.id}`,
        ],
      );
    }
  }

  return { retried, unreachable };
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.7 - turning the feature off
// ════════════════════════════════════════════════════════════════════════════

/**
 * §10A.7, and §20's closing promise.
 *
 * "Open callbacks must NEVER be silently lost. When the feature or capability
 * is switched off for a user: stop popups and escalations, CONVERT OPEN
 * CALLBACKS INTO ORDINARY FOLLOW-UP TASKS in the standard to-do list (no
 * popups, no escalation), and show the owner a list of those tasks for manual
 * reassignment."
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  IT RUNS AS A SWEEP, NOT ON THE SWITCH
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The obvious place is the admin controller's write - switch off, convert. It
 * is the wrong place for two reasons:
 *
 *   1. The gate has FIVE scopes. A callback becomes unreachable when the
 *      platform kill switch flips, when a plan lapses, when a team row is
 *      added, when a scheduled `effective_to` passes - and only one of those
 *      is a request anybody made.
 *   2. §3A.5's `effective_from`/`effective_to` mean a switch-off can be in the
 *      FUTURE. A conversion at write time would either run too early or need
 *      its own timer.
 *
 * So the condition is checked where it can always be checked: the callback's
 * own assignee, against the live gate, on a clock.
 */
export async function convertOrphanedCallbacks(): Promise<{
  converted: number;
  orgsTouched: number;
}> {
  const pool = getAdminPool();
  const { rows: orgs } = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM callbacks
      WHERE status IN ('scheduled', 'due', 'reminded', 'missed', 'escalated')`,
  );

  let converted = 0;
  let orgsTouched = 0;

  for (const { org_id: orgId } of orgs) {
    try {
      const n = await withOrgContext(orgId, async (client) => {
        const { rows } = await client.query<{
          id: string;
          contact_name: string | null;
          contact_phone_last3: string | null;
          requested_text: string | null;
          due_at: string;
          committed: boolean;
          attempts: number;
          notes: string | null;
          assigned_user_id: string | null;
          assigned_telecaller_id: string | null;
          lead_id: string | null;
        }>(
          `SELECT id, contact_name, contact_phone_last3, requested_text, due_at,
                  committed, attempts, notes, assigned_user_id, assigned_telecaller_id, lead_id
             FROM callbacks
            WHERE status IN ('scheduled', 'due', 'reminded', 'missed', 'escalated')
              AND converted_task_id IS NULL
            LIMIT 500`,
        );

        let local = 0;
        for (const row of rows) {
          // The gate, per assignee. A callback whose person still has the
          // feature is left exactly as it is.
          if (!row.assigned_telecaller_id) continue;
          const subject = await gateSubjectForTelecaller(client, row.assigned_telecaller_id);
          const gate = await gateFor(client, FEATURE, subject);
          if (gate.enabled && gate.capabilities.includes("callbacks")) continue;

          const task = callbackToTask({
            contactName: row.contact_name,
            contactPhone: row.contact_phone_last3 ? `…${row.contact_phone_last3}` : null,
            requestedText: row.requested_text,
            dueAt: new Date(row.due_at),
            committed: row.committed,
            attempts: row.attempts,
            notes: row.notes,
          });

          const { rows: created } = await client.query<{ id: string }>(
            `INSERT INTO tasks
               (org_id, title, notes, lead_id, assignee_user_id, due_at, priority, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
             RETURNING id`,
            [
              orgId,
              task.title,
              task.notes,
              row.lead_id,
              row.assigned_user_id,
              task.dueAt,
              task.priority,
            ],
          );

          await client.query(
            `UPDATE callbacks
                SET status = 'cancelled',
                    converted_task_id = $2,
                    outcome = 'carried over to an ordinary follow-up when the assistant was switched off',
                    updated_at = now()
              WHERE id = $1`,
            [row.id, created[0]!.id],
          );
          // Stop the popups and the escalations, which is the first thing
          // §10A.7 asks for.
          await client.query(
            `UPDATE callback_reminders
                SET state = 'cancelled',
                    held_reason = 'the assistant was switched off for this person',
                    updated_at = now()
              WHERE callback_id = $1 AND state IN ('scheduled', 'held')`,
            [row.id],
          );
          await client.query(
            `DELETE FROM callback_escalations WHERE callback_id = $1 AND sent_at IS NULL`,
            [row.id],
          );

          local += 1;
        }

        if (local > 0) {
          // §10A.7: "show the owner a list of those tasks for manual
          // reassignment." One notification per sweep per org, not one per
          // task - a floor of forty open callbacks would otherwise produce
          // forty bells, which is the noise `notifications.ts`'s header warns
          // about.
          const { rows: owners } = await client.query<{ user_id: string }>(
            `SELECT m.user_id FROM memberships m
              WHERE m.owner_role = 'owner' OR m.owner_role IS NULL
              LIMIT 5`,
          );
          for (const owner of owners) {
            await client.query(
              `INSERT INTO notifications
                 (org_id, user_id, kind, title, body, link_path, dedupe_key)
               VALUES ($1, $2, 'agent_alert', $3, $4, '/owner/tasks', $5)
               ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
              [
                orgId,
                owner.user_id,
                `${local} promised call${local === 1 ? "" : "s"} moved to your task list`,
                "The assistant was switched off for somebody who had open call-backs. Nothing was lost - they are ordinary follow-ups now, with no reminders. Check who should pick them up.",
                `callbacks_converted:${new Date().toISOString().slice(0, 10)}`,
              ],
            );
          }
          announce(orgId, "task", "created", null);
        }

        return local;
      });

      converted += n;
      if (n > 0) orgsTouched += 1;
    } catch (error) {
      console.error(`callback conversion failed for org ${orgId}:`, error);
    }
  }

  return { converted, orgsTouched };
}

interface CallbackForLadder {
  id: string;
  due_at: string;
  committed: boolean;
  status: string;
  requested_text: string | null;
  contact_name: string | null;
  contact_phone_last3: string | null;
  lead_id: string | null;
  assigned_user_id: string | null;
  assigned_telecaller_id: string | null;
  sent_levels: number[] | null;
  actioned: boolean | null;
}

export function startCallbackEscalationSweep(): NodeJS.Timeout {
  // Every two minutes. The ladder's own instants come from `due_at`, so the
  // tick only bounds how LATE a level fires - not where it lands.
  const intervalMs = Number(process.env.CALLBACK_ESCALATION_INTERVAL_MS ?? 120_000);
  return setInterval(() => {
    sweepCallbackEscalations().catch((error) =>
      console.error("callback escalation sweep failed:", error),
    );
  }, intervalMs);
}

export function startCallbackConversionSweep(): NodeJS.Timeout {
  // Hourly. §10A.7's conversion is not time-critical - the popups stop the
  // moment the gate closes, because the reminder sweep checks the gate per
  // delivery - and an hourly clock means an owner who switches a person off
  // and straight back on does not find their queue converted to tasks.
  const intervalMs = Number(process.env.CALLBACK_CONVERSION_INTERVAL_MS ?? 3_600_000);
  return setInterval(() => {
    convertOrphanedCallbacks().catch((error) =>
      console.error("callback conversion sweep failed:", error),
    );
  }, intervalMs);
}
