import { getAdminPool, withOrgContext } from "@aura/db";
import { qualifyWhatsAppConversation } from "@aura/llm";
import type { QualifiableMessage } from "@aura/shared";

/**
 * The WhatsApp qualification sweep (migration 0080).
 *
 * ── WHAT IT DOES, AND WHAT IT REFUSES TO DO ───────────────────────────────
 *
 * Reads inbound WhatsApp threads nobody has claimed, asks a model whether each
 * one looks like a sales enquiry, and writes a scored PROPOSAL to
 * `conversation_qualifications`. It does not create a contact, a lead or a
 * deal, and it must not be extended to: safety rule 2 says a human's judgment
 * outranks the machine's, and 0055 already decided that an inbound WhatsApp
 * message never silently becomes a CRM record. Approval lives in the API,
 * behind a signed-in user whose id is recorded on the row.
 *
 * Same shape as every other sweep here: cross-tenant off the admin pool to
 * find work, then re-enter each org's RLS context to write it.
 *
 * ── STATED BOUNDS ─────────────────────────────────────────────────────────
 *
 * 1. UNMATCHED THREADS ONLY (`conversations.contact_id IS NULL`). A thread
 *    whose sender is already a contact is not a dead end - it is on the
 *    contact's timeline, and lead scoring (0064) already credits the reply. The
 *    gap this closes is the unmatched queue, where an enquiry from an unknown
 *    number currently stops forever. Widening it to known contacts is a
 *    one-line change to the WHERE clause, and would mean paying for a verdict
 *    on every "thanks!" a customer sends.
 *
 * 2. RECENT THREADS ONLY. A thread whose last inbound message is older than
 *    QUALIFY_LOOKBACK_DAYS is not qualified. Speed-to-lead is the entire value
 *    of this feature; a verdict on a four-month-old "what's your price" is an
 *    archaeology report, not a lead. The first run after enabling the feature
 *    is bounded by this too, which is what stops it spending a month's LLM
 *    budget on a backlog in one tick.
 *
 * 3. SETTLED JUNK STAYS SETTLED. Once a human rejects a thread as spam or a
 *    wrong number, further messages on it are not re-qualified. A spammer who
 *    keeps sending is not a reason to keep paying for verdicts.
 */

/** How far back a thread's last inbound message may be and still be qualified. */
const LOOKBACK_DAYS = Number(process.env.QUALIFY_LOOKBACK_DAYS ?? 30);

/**
 * Conversations qualified per org per tick.
 *
 * A ceiling on spend, not on throughput: the sweep runs again in fifteen
 * minutes and takes the next batch, so a genuine backlog drains over a few
 * hours instead of arriving as one unbounded bill. Ordered by recency, so the
 * threads a person would most want to see are the ones that get done first.
 */
const MAX_PER_TICK = Number(process.env.QUALIFY_MAX_PER_TICK ?? 25);

interface CandidateRow {
  id: string;
  last_message_id: string;
  message_count: string | number;
}

interface MessageRow {
  direction: "incoming" | "outgoing";
  body: string | null;
  occurred_at: Date | null;
}

/**
 * Threads worth spending a verdict on.
 *
 * The LATERAL is what makes "the newest message" available to the NOT EXISTS
 * that follows it - the watermark test needs the id it is comparing against,
 * and a correlated subquery repeated in three places would be three chances to
 * order it differently. `count(*) OVER ()` is evaluated across the whole
 * partition before LIMIT applies, so it really is the thread's total, not 1.
 *
 * ORDER BY occurred_at DESC, id DESC: occurred_at is provider-supplied and two
 * messages genuinely can share a timestamp, so the id breaks the tie
 * deterministically. Without it the "latest message" could alternate between
 * two rows on successive ticks and re-qualify the same thread forever.
 */
async function findCandidates(orgId: string): Promise<CandidateRow[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<CandidateRow>(
      `SELECT c.id, l.last_message_id, l.message_count
         FROM conversations c
         JOIN LATERAL (
           SELECT m.id AS last_message_id,
                  count(*) OVER () AS message_count
             FROM conversation_messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.occurred_at DESC, m.id DESC
            LIMIT 1
         ) l ON true
        WHERE c.channel = 'whatsapp'
          AND c.contact_id IS NULL
          AND c.status <> 'closed'
          AND c.last_inbound_at IS NOT NULL
          AND c.last_inbound_at > now() - ($1 || ' days')::interval
          AND EXISTS (
                SELECT 1 FROM conversation_messages m
                 WHERE m.conversation_id = c.id AND m.direction = 'incoming'
              )
          AND NOT EXISTS (
                SELECT 1 FROM conversation_qualifications q
                 WHERE q.conversation_id = c.id
                   AND (
                     q.last_message_id = l.last_message_id
                     OR (q.status = 'rejected'
                         AND q.disposition IN ('spam', 'wrong_number'))
                   )
              )
        ORDER BY c.last_inbound_at DESC
        LIMIT $2`,
      [String(LOOKBACK_DAYS), MAX_PER_TICK],
    );
    return rows;
  });
}

async function loadMessages(orgId: string, conversationId: string): Promise<QualifiableMessage[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<MessageRow>(
      `SELECT direction, body, occurred_at
         FROM conversation_messages
        WHERE conversation_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [conversationId],
    );
    return rows.map((r) => ({ direction: r.direction, body: r.body, occurredAt: r.occurred_at }));
  });
}

/**
 * Write one verdict.
 *
 * Supersede-then-insert, in ONE transaction. The partial unique index
 * `conversation_qualifications_one_pending` allows a single pending row per
 * conversation, so these two statements are not merely tidy - split across two
 * transactions they would race, and the loser's INSERT would fail on an index
 * violation after its LLM call had already been paid for.
 */
async function writeVerdict(
  orgId: string,
  candidate: CandidateRow,
  result: Awaited<ReturnType<typeof qualifyWhatsAppConversation>>,
): Promise<boolean> {
  return withOrgContext(orgId, async (client) => {
    // IS DISTINCT FROM, not a bare status filter. Without it this loses a
    // verdict outright under concurrency: two sweeps overlap, A inserts the row
    // for this watermark, then B supersedes A's brand-new pending row and its
    // own INSERT does nothing (ON CONFLICT) - leaving the thread with no pending
    // verdict at all and no way back into the queue until a new message arrives.
    // Excluding the watermark being written makes the second writer a no-op
    // instead of a destructive one.
    await client.query(
      `UPDATE conversation_qualifications
          SET status = 'superseded'
        WHERE conversation_id = $1 AND status = 'pending'
          AND last_message_id IS DISTINCT FROM $2`,
      [candidate.id, candidate.last_message_id],
    );
    const { verdict } = result;
    const res = await client.query(
      `INSERT INTO conversation_qualifications
         (org_id, conversation_id, last_message_id, message_count, status,
          disposition, score, intent, rationale,
          extracted_name, extracted_email, extracted_company, extracted_budget,
          extracted_notes, provider, model, tokens_in, tokens_out)
       VALUES ($1, $2, $3, $4, 'pending',
               $5, $6, $7, $8,
               $9, $10, $11, $12,
               $13, $14, $15, $16, $17)
       ON CONFLICT (conversation_id, last_message_id) WHERE last_message_id IS NOT NULL
         DO NOTHING`,
      [
        orgId,
        candidate.id,
        candidate.last_message_id,
        Number(candidate.message_count) || 0,
        verdict.disposition,
        verdict.score,
        verdict.intent,
        verdict.rationale,
        verdict.name,
        verdict.email,
        verdict.company,
        verdict.budget,
        verdict.notes,
        result.provider,
        result.model,
        result.tokensIn,
        result.tokensOut,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

export async function runWhatsAppQualificationSweep(): Promise<number> {
  // Opt-in per tenant. Qualification ships a tenant's customer conversations to
  // an LLM provider, which is not a thing to switch on for every org on the
  // platform because a migration ran.
  const { rows: orgs } = await getAdminPool().query<{ id: string; name: string | null }>(
    `SELECT id, name FROM organizations
      WHERE status = 'active' AND whatsapp_qualification_enabled = true`,
  );

  let total = 0;
  for (const org of orgs) {
    let candidates: CandidateRow[];
    try {
      candidates = await findCandidates(org.id);
    } catch (err) {
      // One tenant's failure must not end the pass for the others.
      console.error(`whatsapp qualification: candidate scan failed for org ${org.id}:`, err);
      continue;
    }

    for (const candidate of candidates) {
      try {
        const messages = await loadMessages(org.id, candidate.id);
        const result = await qualifyWhatsAppConversation(messages, org.name);
        if (await writeVerdict(org.id, candidate, result)) total++;
      } catch (err) {
        console.error(`whatsapp qualification: conversation ${candidate.id} failed:`, err);
      }
    }
  }

  if (total > 0) console.log(`whatsapp qualification: ${total} verdict(s) queued for review`);
  return total;
}

export function startWhatsAppQualificationSweep(): NodeJS.Timeout {
  const interval = Number(process.env.QUALIFY_INTERVAL_MS ?? 15 * 60 * 1000);
  return setInterval(() => {
    void runWhatsAppQualificationSweep().catch((err) =>
      console.error("whatsapp qualification sweep:", err),
    );
  }, interval);
}
