import {
  deriveLeadTemperature,
  entryStage,
  isFilled,
  leadTitle,
  parseLeadRules,
  parseLeadStages,
  qualifyLead,
  stageAfter,
  type LeadQualification,
} from "@aura/shared";
import { isLeadStageMove, recordLeadStageTransition } from "@aura/db";
import { confidenceScore, type DbClient } from "./crm-dispatch";

/**
 * Lead projection: turn a qualified extraction into a row the customer's owner
 * can work in the console.
 *
 * This is deliberately separate from crm-dispatch. That path pushes the call
 * OUT to a system the tenant already owns; this one keeps a prospect IN the
 * platform, so a customer with no CRM still has a pipeline. Both read the same
 * call_facts and neither blocks the other - a CRM outage must not cost the
 * owner their board, and a board write must not delay a CRM delivery.
 *
 * Not every call is a lead. The agent's lead_rules decide (see @aura/shared
 * qualifyLead); the default is "extraction validated and something came back",
 * which rejects wrong numbers and unanswered calls without any tenant setup.
 */

interface CallRow {
  workspace_id: string;
  device_id: string | null;
  telecaller_id: string | null;
  remote_name: string | null;
  remote_number_hash: string | null;
  remote_number_prefix: string | null;
  remote_number_last3: string | null;
  started_at: Date | null;
  agent_id: string | null;
  agent_version: number | null;
  lead_rules: unknown;
  lead_stages: unknown;
  summary: string | null;
  /** `transcripts.intelligence` - what the analysis made of the conversation. */
  outcome: string | null;
  sentiment: string | null;
  facts: Record<string, unknown> | null;
  validation_status: string | null;
}

export interface LeadUpsertResult {
  leadId: string | null;
  created: boolean;
  reason: string;
}

// The card heading. Moved to @aura/shared so the API's projection names a
// record exactly as this one does (doc 23, B3); re-exported for existing importers.
export { leadTitle };

/**
 * Qualify a completed call and write (or update) its lead.
 *
 * Idempotent in both directions:
 *  - reprocessing a call updates the same lead rather than forking one, because
 *    the dedup key is the counterparty number, not the call;
 *  - call_count is recomputed from the calls table instead of incremented, so a
 *    reprocess cannot inflate it.
 *
 * Never moves a lead BACKWARDS, and never touches status. Once an owner drags
 * a card to Negotiation, a follow-up call enriches the lead - it does not send
 * it back to New. The one automatic move is forward and only out of the entry
 * stage, on a lead nobody has worked: see the `stage = CASE` in the upsert.
 */
export async function upsertLead(
  client: DbClient,
  orgId: string,
  callId: string,
): Promise<LeadUpsertResult> {
  const {
    rows: [row],
  } = await client.query<CallRow>(
    `SELECT c.workspace_id, c.device_id, d.telecaller_id, c.remote_name, c.remote_number_hash,
            c.remote_number_prefix, c.remote_number_last3, c.started_at,
            c.agent_id, c.agent_version,
            COALESCE(a.lead_rules, '{}'::jsonb) AS lead_rules,
            o.lead_stages,
            t.intelligence ->> 'summary' AS summary,
            t.intelligence ->> 'outcome' AS outcome,
            t.intelligence ->> 'sentiment' AS sentiment,
            (SELECT jsonb_object_agg(f.field_key,
                      COALESCE(to_jsonb(f.value_num), to_jsonb(f.value_bool), to_jsonb(f.value_text)))
               FROM call_facts f WHERE f.call_id = c.id) AS facts,
            (SELECT ao.validation_status FROM ai_outputs ao
              WHERE ao.call_id = c.id ORDER BY ao.created_at DESC LIMIT 1) AS validation_status
       FROM calls c
       JOIN organizations o   ON o.id = c.org_id
       LEFT JOIN agents a     ON a.id = c.agent_id AND a.version = c.agent_version
       LEFT JOIN transcripts t ON t.call_id = c.id
       LEFT JOIN devices d    ON d.id = c.device_id
      WHERE c.id = $1`,
    [callId],
  );
  if (!row) return { leadId: null, created: false, reason: "call not found" };

  const facts = row.facts ?? {};
  const rules = parseLeadRules(row.lead_rules);
  const verdict: LeadQualification = qualifyLead(facts, row.validation_status, rules);
  if (!verdict.qualified) {
    return { leadId: null, created: false, reason: verdict.reason };
  }

  // Only filled values are written, so the ON CONFLICT merge below (`||`) can
  // never blank a fact an earlier call established. `isFilled` rather than a
  // local test for the same reason mergeFacts uses it: "   " and the literal
  // "[]" are how a model says "not mentioned", and jsonb `||` would happily
  // overwrite a real budget from the first call with one of them.
  const incomingFacts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (isFilled(value)) incomingFacts[key] = value;
  }

  const stages = parseLeadStages(row.lead_stages);
  const contactName = verdict.title ?? row.remote_name?.trim() ?? null;
  const title = leadTitle(
    verdict.title,
    row.remote_name,
    row.remote_number_prefix,
    row.remote_number_last3,
  );
  const score = confidenceScore(row.validation_status, verdict.filled, Object.keys(facts).length);
  const activityAt = row.started_at ?? new Date();

  // How warm this call sounded, and where a lead goes once the conversation is
  // demonstrably running. Both are null-safe: `deriveLeadTemperature` returns
  // null when the call said nothing either way, and `stageAfter` returns null
  // on a board with nowhere open to advance to. The SQL below treats both
  // nulls as "change nothing", so a tenant with a two-column board or a call
  // with no analysis simply keeps what it had.
  const temperature = deriveLeadTemperature({
    outcome: row.outcome,
    sentiment: row.sentiment,
    valueNum: verdict.valueNum,
  });
  const advanceTo = stageAfter(stages, entryStage(stages));

  const hash = row.remote_number_hash;
  const params = [
    orgId,                       // $1
    row.workspace_id,            // $2
    contactName,                 // $3
    hash,                        // $4
    row.remote_number_prefix,    // $5
    row.remote_number_last3,     // $6
    title,                       // $7
    entryStage(stages),          // $8
    score,                       // $9
    verdict.valueNum,            // $10
    row.summary,                 // $11
    JSON.stringify(incomingFacts), // $12
    row.device_id,               // $13
    callId,                      // $14
    row.agent_id,                // $15
    row.agent_version,           // $16
    activityAt,                  // $17
    row.telecaller_id,           // $18
    temperature,                 // $19
    advanceTo,                   // $20
  ];

  // A numberless call (the handset had no call-log permission) has no dedup
  // key, so the unique index can't catch a replay - match on the call itself.
  if (!hash) {
    const {
      rows: [existing],
    } = await client.query<{ id: string }>(
      `SELECT id FROM leads
        WHERE contact_number_hash IS NULL AND (first_call_id = $1 OR last_call_id = $1)
        LIMIT 1`,
      [callId],
    );
    if (existing) {
      await client.query(
        `UPDATE leads
            SET title      = $2,
                summary    = COALESCE($3, summary),
                score      = $4,
                value_num  = COALESCE($5, value_num),
                facts      = facts || $6::jsonb,
                -- Same two rules as the keyed path below: a rating a person
                -- set is never overwritten, and a call that read as nothing
                -- leaves the existing rating alone.
                temperature = CASE
                                WHEN temperature_source = 'user' THEN temperature
                                ELSE COALESCE($8, temperature)
                              END,
                last_activity_at = GREATEST(last_activity_at, $7::timestamptz)
          WHERE id = $1`,
        [
          existing.id,
          title,
          row.summary,
          score,
          verdict.valueNum,
          JSON.stringify(incomingFacts),
          activityAt,
          temperature,
        ],
      );
      return { leadId: existing.id, created: false, reason: "updated (no contact number)" };
    }
  }

  // The card as it stood before this call, LOCKED until the transaction ends,
  // so the automatic advance can go in the stage ledger with a truthful "from".
  //
  // A separate statement on purpose. Folded into the upsert as a CTE it looks
  // like one round trip saved, and it is wrong: Postgres evaluates a CTE that
  // only RETURNING references AFTER the row has been written, and FOR UPDATE
  // then skips a row "updated by this command" - so the prior read comes back
  // empty. Without FOR UPDATE it reads the pre-statement snapshot instead,
  // which two concurrent calls to the same number can both see, recording the
  // same advance twice. The lock is what makes the second call wait and read
  // the first one's result. This is the worker, not a request - one round
  // trip here costs nobody a slower page.
  const {
    rows: [prior],
  } = await client.query<{ stage: string; status: string }>(
    `SELECT stage, status FROM leads
      WHERE workspace_id = $1 AND contact_number_hash = $2
        FOR UPDATE`,
    [row.workspace_id, hash],
  );

  const {
    rows: [lead],
  } = await client.query<{ id: string; created: boolean; stage: string; status: string }>(
    `INSERT INTO leads
       (org_id, workspace_id, contact_name, contact_number_hash, contact_number_prefix,
        contact_number_last3, title, stage, score, value_num, summary, facts,
        telecaller_device_id, telecaller_id, first_call_id, last_call_id, agent_id, agent_version,
        last_activity_at, temperature, call_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $18, $14, $14, $15, $16, $17, $19,
             GREATEST(1, (SELECT count(*)::int FROM calls c
                           WHERE c.workspace_id = $2 AND c.remote_number_hash = $4)))
     ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
     DO UPDATE SET
       -- STATUS is the owner's, never the pipeline's - won and lost are human
       -- decisions and nothing here touches them. STAGE is now the one
       -- exception, and only in one direction: see below. telecaller_id is
       -- deliberately absent here too, same as telecaller_device_id: it is
       -- a write-once snapshot of who first qualified the lead, and must never
       -- move to whoever's device happens to make the next call.
       contact_name = COALESCE(leads.contact_name, EXCLUDED.contact_name),
       -- Upgrade the heading only when this call is what finally named them.
       title = CASE
                 WHEN leads.contact_name IS NULL AND EXCLUDED.contact_name IS NOT NULL
                   THEN EXCLUDED.title
                 ELSE leads.title
               END,
       summary   = COALESCE(EXCLUDED.summary, leads.summary),
       score     = EXCLUDED.score,
       value_num = COALESCE(EXCLUDED.value_num, leads.value_num),
       facts     = leads.facts || EXCLUDED.facts,
       -- The rating (0083). Two guards, both load-bearing:
       --   * a rating a PERSON set is theirs - re-deriving over it is how a
       --     field stops being trusted;
       --   * COALESCE, not assignment - a follow-up call the analysis could
       --     make nothing of returns null, and null must not erase what an
       --     earlier call established.
       temperature = CASE
                       WHEN leads.temperature_source = 'user' THEN leads.temperature
                       ELSE COALESCE(EXCLUDED.temperature, leads.temperature)
                     END,
       -- The one automatic stage move there is, and it only ever goes forward
       -- one column, out of the entry stage, on a lead nobody has worked yet.
       -- A second qualified call to the same number means the conversation is
       -- running, so the card should not still be sitting in New - which is
       -- where boards were banking up, 303 leads of 305 on one tenant.
       --
       -- $8 is the entry stage and $20 the open column after it, both
       -- computed from THIS org's own lead_stages, so a tenant that renamed
       -- its columns advances within its own board and a tenant with nowhere
       -- open to advance to gets null and keeps its stage. The status column is
       -- untouched: both columns are non-terminal, so it stays 'open'.
       --
       -- Main board only (0136): $8 and $20 are the MAIN board's keys, and a
       -- lead on another board has columns of its own - writing a Main-board
       -- key onto it would drop the card out of every column it can render.
       stage = CASE
                 WHEN $20::text IS NOT NULL
                  AND leads.board_id IS NULL
                  AND leads.stage = $8::text
                  AND leads.status = 'open'
                  AND EXCLUDED.call_count > 1
                   THEN $20::text
                 ELSE leads.stage
               END,
       last_call_id  = EXCLUDED.last_call_id,
       agent_id      = EXCLUDED.agent_id,
       agent_version = EXCLUDED.agent_version,
       call_count    = EXCLUDED.call_count,
       last_activity_at = GREATEST(leads.last_activity_at, EXCLUDED.last_activity_at)
     RETURNING id, (xmax = 0) AS created, stage, status`,
    params,
  );

  // The one automatic move, into the lead's stage ledger (0075). `automation`,
  // never `console`: 0093's trigger counts a console move as a person
  // answering the lead, and a second call arriving is not somebody answering.
  // A newly created lead is not a move - it has no "from".
  //
  // Inside its own SAVEPOINT because this function runs in the pipeline's
  // shared write transaction: a failed statement there would abort everything
  // after it (the CRM projection, dispatch) and a try/catch alone cannot undo
  // that. The ledger describes the board; it must never be what stops a call
  // reaching COMPLETE.
  const move = prior && {
    fromStage: prior.stage,
    toStage: lead.stage,
    fromStatus: prior.status,
    toStatus: lead.status,
  };
  if (!lead.created && move && isLeadStageMove(move)) {
    await client.query("SAVEPOINT lead_stage_ledger");
    try {
      await recordLeadStageTransition(client, orgId, {
        leadId: lead.id,
        ...move,
        source: "automation",
        actorLabel: "automation: second qualified call",
      });
      await client.query("RELEASE SAVEPOINT lead_stage_ledger");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT lead_stage_ledger");
      console.error(`lead ${lead.id}: stage ledger write failed (non-blocking):`, err);
    }
  }

  return {
    leadId: lead.id,
    created: lead.created,
    reason: lead.created ? "created" : "updated",
  };
}
