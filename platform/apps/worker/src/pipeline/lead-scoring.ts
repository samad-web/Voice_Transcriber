import { getAdminPool, withOrgContext } from "@aura/db";

/**
 * Lead scoring (Kailash gap Milestone 4) - a rule-based point ledger on
 * `contacts.lead_score`, computed from events that already exist: an inbound
 * WhatsApp/email reply, a logged meeting, and daily inactivity decay. Same
 * shape as retry.ts's sweeps: cross-tenant off the admin pool to find work,
 * then re-entering each org's RLS context to write it.
 *
 * Pure computation, no sends - this sweep never enqueues a message or an
 * automation event, so it doesn't touch any of the three safety rules.
 *
 * Idempotency is the unique index on (contact_id, action, source_id)
 * (migration 0064): every candidate row this sweep finds is INSERTed with
 * ON CONFLICT DO NOTHING, so re-scanning the same lookback window every tick
 * - rather than tracking a cursor - can never double-score the same event.
 *
 * KNOWN BOUND, STATED RATHER THAN HIDDEN: the reply/meeting scans only look
 * back 24 hours. An event the sweep somehow missed inside that window (the
 * worker was down, say) will not be scored retroactively once it ages out -
 * lead_score is a recency signal for "is this contact warm right now," not
 * an audit-complete ledger, and widening the window is a one-line change if
 * that judgment ever needs revisiting.
 */

const DEFAULT_POINTS = {
  replied: 10,
  meeting_booked: 25,
  inactivity_decay: -5,
} as const;

interface ScoringRules {
  replied?: number;
  meeting_booked?: number;
  inactivity_decay?: number;
}

function pointsFor(rules: unknown, action: keyof typeof DEFAULT_POINTS): number {
  const r = (rules && typeof rules === "object" ? (rules as ScoringRules) : {}) ?? {};
  const override = r[action];
  return typeof override === "number" && Number.isFinite(override) ? override : DEFAULT_POINTS[action];
}

async function scoreReplies(orgId: string, points: number): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    // conversation_messages has no contact_id of its own - the link lives on
    // the conversation it belongs to (conversations.contact_id, filled in by
    // ConversationsService.ingestInbound's phone/email match).
    const { rows } = await client.query<{ contact_id: string; id: string }>(
      `SELECT c.contact_id, m.id
         FROM conversation_messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'incoming' AND c.contact_id IS NOT NULL
          AND m.occurred_at > now() - interval '1 day'`,
    );
    let scored = 0;
    for (const row of rows) {
      const res = await client.query(
        `INSERT INTO lead_score_events (org_id, contact_id, action, delta, source_id)
         VALUES ($1, $2, 'replied', $3, $4)
         ON CONFLICT (contact_id, action, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
        [orgId, row.contact_id, points, row.id],
      );
      if ((res.rowCount ?? 0) > 0) {
        await client.query(`UPDATE contacts SET lead_score = lead_score + $2 WHERE id = $1`, [row.contact_id, points]);
        scored++;
      }
    }
    return scored;
  });
}

async function scoreMeetings(orgId: string, points: number): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ contact_id: string; id: string }>(
      `SELECT contact_id, id FROM interactions
        WHERE type = 'meeting' AND contact_id IS NOT NULL
          AND occurred_at > now() - interval '1 day'`,
    );
    let scored = 0;
    for (const row of rows) {
      const res = await client.query(
        `INSERT INTO lead_score_events (org_id, contact_id, action, delta, source_id)
         VALUES ($1, $2, 'meeting_booked', $3, $4)
         ON CONFLICT (contact_id, action, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
        [orgId, row.contact_id, points, row.id],
      );
      if ((res.rowCount ?? 0) > 0) {
        await client.query(`UPDATE contacts SET lead_score = lead_score + $2 WHERE id = $1`, [row.contact_id, points]);
        scored++;
      }
    }
    return scored;
  });
}

/** At most one decay event per contact per day - the synthetic source_id IS today's date. */
async function scoreInactivityDecay(orgId: string, points: number): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM contacts
        WHERE status <> 'merged' AND last_activity_at < now() - interval '7 days'`,
    );
    let scored = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const row of rows) {
      const res = await client.query(
        `INSERT INTO lead_score_events (org_id, contact_id, action, delta, source_id)
         VALUES ($1, $2, 'inactivity_decay', $3, $4)
         ON CONFLICT (contact_id, action, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
        [orgId, row.id, points, today],
      );
      if ((res.rowCount ?? 0) > 0) {
        // GREATEST(0, ...) - a score is a warmth signal, not a debt; it has no
        // meaningful negative value to decay past zero.
        await client.query(`UPDATE contacts SET lead_score = GREATEST(0, lead_score + $2) WHERE id = $1`, [row.id, points]);
        scored++;
      }
    }
    return scored;
  });
}

export async function runLeadScoringSweep(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{ id: string; lead_scoring_rules: unknown }>(
    `SELECT id, lead_scoring_rules FROM organizations WHERE status = 'active'`,
  );

  let total = 0;
  for (const org of orgs) {
    const replied = pointsFor(org.lead_scoring_rules, "replied");
    const meeting = pointsFor(org.lead_scoring_rules, "meeting_booked");
    const decay = pointsFor(org.lead_scoring_rules, "inactivity_decay");
    total += await scoreReplies(org.id, replied);
    total += await scoreMeetings(org.id, meeting);
    total += await scoreInactivityDecay(org.id, decay);
  }
  if (total > 0) console.log(`lead scoring: recorded ${total} event(s)`);
  return total;
}

export function startLeadScoringSweep(): NodeJS.Timeout {
  const interval = Number(process.env.LEAD_SCORING_INTERVAL_MS ?? 15 * 60 * 1000);
  return setInterval(() => {
    void runLeadScoringSweep().catch((err) => console.error("lead scoring sweep:", err));
  }, interval);
}
