import {
  entryStage,
  parseLeadRules,
  parseLeadStages,
  qualifyLead,
  type LeadQualification,
} from "@aura/shared";
import { confidenceScore, type DbClient } from "./crm-dispatch";

/**
 * Lead projection: turn a qualified extraction into a row the customer's owner
 * can work in the console.
 *
 * This is deliberately separate from crm-dispatch. That path pushes the call
 * OUT to a system the tenant already owns; this one keeps a prospect IN the
 * platform, so a customer with no CRM still has a pipeline. Both read the same
 * call_facts and neither blocks the other — a CRM outage must not cost the
 * owner their board, and a board write must not delay a CRM delivery.
 *
 * Not every call is a lead. The agent's lead_rules decide (see @aura/shared
 * qualifyLead); the default is "extraction validated and something came back",
 * which rejects wrong numbers and unanswered calls without any tenant setup.
 */

interface CallRow {
  workspace_id: string;
  device_id: string | null;
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
  facts: Record<string, unknown> | null;
  validation_status: string | null;
}

export interface LeadUpsertResult {
  leadId: string | null;
  created: boolean;
  reason: string;
}

/**
 * The card heading.
 *
 * Falls back the same way the Call Explorer labels a call: extracted name →
 * the number's leading digits → nothing identifiable. An owner should never
 * see a raw uuid on a board card.
 */
export function leadTitle(
  extractedName: string | null,
  remoteName: string | null,
  numberPrefix: string | null,
  numberLast3: string | null,
): string {
  const name = extractedName?.trim() || remoteName?.trim();
  if (name) return name.slice(0, 200);
  if (numberPrefix) return `${numberPrefix}…`;
  if (numberLast3) return `…${numberLast3}`;
  return "Unknown caller";
}

/**
 * Qualify a completed call and write (or update) its lead.
 *
 * Idempotent in both directions:
 *  - reprocessing a call updates the same lead rather than forking one, because
 *    the dedup key is the counterparty number, not the call;
 *  - call_count is recomputed from the calls table instead of incremented, so a
 *    reprocess cannot inflate it.
 *
 * Never resets stage or status. Once an owner drags a card to Negotiation, a
 * follow-up call enriches the lead — it does not send it back to New.
 */
export async function upsertLead(
  client: DbClient,
  orgId: string,
  callId: string,
): Promise<LeadUpsertResult> {
  const {
    rows: [row],
  } = await client.query<CallRow>(
    `SELECT c.workspace_id, c.device_id, c.remote_name, c.remote_number_hash,
            c.remote_number_prefix, c.remote_number_last3, c.started_at,
            c.agent_id, c.agent_version,
            COALESCE(a.lead_rules, '{}'::jsonb) AS lead_rules,
            o.lead_stages,
            t.intelligence ->> 'summary' AS summary,
            (SELECT jsonb_object_agg(f.field_key,
                      COALESCE(to_jsonb(f.value_num), to_jsonb(f.value_bool), to_jsonb(f.value_text)))
               FROM call_facts f WHERE f.call_id = c.id) AS facts,
            (SELECT ao.validation_status FROM ai_outputs ao
              WHERE ao.call_id = c.id ORDER BY ao.created_at DESC LIMIT 1) AS validation_status
       FROM calls c
       JOIN organizations o   ON o.id = c.org_id
       LEFT JOIN agents a     ON a.id = c.agent_id AND a.version = c.agent_version
       LEFT JOIN transcripts t ON t.call_id = c.id
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
  // never blank a fact an earlier call established.
  const incomingFacts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value !== null && value !== undefined && value !== "") incomingFacts[key] = value;
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
  ];

  // A numberless call (the handset had no call-log permission) has no dedup
  // key, so the unique index can't catch a replay — match on the call itself.
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
                last_activity_at = GREATEST(last_activity_at, $7::timestamptz)
          WHERE id = $1`,
        [existing.id, title, row.summary, score, verdict.valueNum, JSON.stringify(incomingFacts), activityAt],
      );
      return { leadId: existing.id, created: false, reason: "updated (no contact number)" };
    }
  }

  const {
    rows: [lead],
  } = await client.query<{ id: string; created: boolean }>(
    `INSERT INTO leads
       (org_id, workspace_id, contact_name, contact_number_hash, contact_number_prefix,
        contact_number_last3, title, stage, score, value_num, summary, facts,
        telecaller_device_id, first_call_id, last_call_id, agent_id, agent_version,
        last_activity_at, call_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $14, $15, $16, $17,
             GREATEST(1, (SELECT count(*)::int FROM calls c
                           WHERE c.workspace_id = $2 AND c.remote_number_hash = $4)))
     ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
     DO UPDATE SET
       -- Stage and status are the owner's, never the pipeline's.
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
       last_call_id  = EXCLUDED.last_call_id,
       agent_id      = EXCLUDED.agent_id,
       agent_version = EXCLUDED.agent_version,
       call_count    = EXCLUDED.call_count,
       last_activity_at = GREATEST(leads.last_activity_at, EXCLUDED.last_activity_at)
     RETURNING id, (xmax = 0) AS created`,
    params,
  );

  return {
    leadId: lead.id,
    created: lead.created,
    reason: lead.created ? "created" : "updated",
  };
}
