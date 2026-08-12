import { entryStage, parsePipelineStages } from "@aura/shared";
import type { DbClient } from "./crm-dispatch";
import { projectFactsToCustomFields } from "./custom-fields";
import { leadTitle } from "./leads";

/**
 * Project a lead the pipeline already qualified onto the new Contact/Deal
 * object model (packages/db/migrations/0035-0036), alongside — not instead
 * of — the existing `leads` row.
 *
 * Strangler-fig, CRM Phase 1 (see the Phase 1 plan): this function is not
 * yet called from pipeline.ts's live call-processing path — that wiring is a
 * later, separately-reviewed milestone (M3). For now it exists so
 * scripts/backfill-crm-objects.js can replay it over history, and the live
 * dual-write (when it lands) will call this exact function too, so backfill
 * and live projection can never drift from each other.
 *
 * Read-after-write from `leads`, keyed on the leadId upsertLead() already
 * returned, rather than re-deriving qualification from the call — the call
 * already decided whether it's a lead; this only decides where else that
 * lead's data lives.
 *
 * Mirrors upsertLead's own contract deliberately: stage/status/telecaller are
 * never touched on a deal update, so a follow-up call can never silently move
 * a deal a human is already working.
 */

interface LeadRow {
  org_id: string;
  workspace_id: string;
  contact_name: string | null;
  contact_number_hash: string | null;
  contact_number_prefix: string | null;
  contact_number_last3: string | null;
  score: number | null;
  value_num: number | null;
  summary: string | null;
  facts: Record<string, unknown> | null;
  telecaller_id: string | null;
  first_call_id: string | null;
  last_call_id: string | null;
  call_count: number;
  last_activity_at: Date;
}

export interface CrmObjectProjection {
  contactId: string | null;
  dealId: string | null;
  reason: string;
}

interface CallRow {
  workspace_id: string;
  direction: string;
  started_at: Date;
  duration_s: number;
  status: string;
  telecaller: string | null;
}

/**
 * Put one call on the interaction timeline (migrations/0040), attached to the
 * Contact and Deal it produced.
 *
 * Idempotent on `interactions(call_id) WHERE type = 'call'`, which is what
 * lets the live dual-write, a reprocess, and the backfill all run over the
 * same call without stacking duplicate timeline entries — the same role
 * `deals(source_lead_id)` plays for the lead projection.
 *
 * `account_id` is deliberately left NULL: a call's account is whatever
 * account its contact belongs to, and contacts get re-parented (by a merge,
 * or by an admin). Reading it through the contact at query time stays correct
 * when that happens; a denormalised copy written here would not.
 */
export async function projectCallToInteraction(
  client: DbClient,
  orgId: string,
  callId: string,
  contactId: string | null,
  dealId: string | null,
): Promise<"created" | "updated" | "skipped"> {
  const {
    rows: [call],
  } = await client.query<CallRow>(
    `SELECT c.workspace_id, c.direction, c.started_at, c.duration_s, c.status,
            COALESCE(d.telecaller_name, d.label) AS telecaller
       FROM calls c
       LEFT JOIN devices d ON d.id = c.device_id
      WHERE c.id = $1`,
    [callId],
  );
  if (!call) return "skipped";

  const {
    rows: [row],
  } = await client.query<{ created: boolean }>(
    `INSERT INTO interactions
       (org_id, workspace_id, type, direction, contact_id, deal_id, call_id,
        occurred_at, duration_s, actor_label, metadata)
     VALUES ($1, $2, 'call', $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (call_id) WHERE call_id IS NOT NULL AND type = 'call'
     DO UPDATE SET
       -- COALESCE, not overwrite: a reprocess that fails to re-derive a lead
       -- must not strip the contact/deal an earlier successful run attached.
       contact_id = COALESCE(EXCLUDED.contact_id, interactions.contact_id),
       deal_id    = COALESCE(EXCLUDED.deal_id, interactions.deal_id),
       -- occurred_at is the call's start time and never changes; omitted so a
       -- reprocess cannot shuffle the timeline's ordering.
       duration_s = EXCLUDED.duration_s,
       metadata   = interactions.metadata || EXCLUDED.metadata
     RETURNING (xmax = 0) AS created`,
    [
      orgId,
      call.workspace_id,
      call.direction,
      contactId,
      dealId,
      callId,
      call.started_at,
      call.duration_s,
      call.telecaller,
      JSON.stringify({ status: call.status }),
    ],
  );
  return row.created ? "created" : "updated";
}

export async function projectLeadToCrm(
  client: DbClient,
  orgId: string,
  leadId: string,
): Promise<CrmObjectProjection> {
  const {
    rows: [lead],
  } = await client.query<LeadRow>(
    `SELECT org_id, workspace_id, contact_name, contact_number_hash, contact_number_prefix,
            contact_number_last3, score, value_num, summary, facts,
            telecaller_id, first_call_id, last_call_id, call_count, last_activity_at
       FROM leads WHERE id = $1`,
    [leadId],
  );
  if (!lead) return { contactId: null, dealId: null, reason: "lead not found" };

  const {
    rows: [pipeline],
  } = await client.query<{ id: string; stages: unknown }>(
    `SELECT id, stages FROM deal_pipelines WHERE org_id = $1 AND is_default = true LIMIT 1`,
    [orgId],
  );
  if (!pipeline) return { contactId: null, dealId: null, reason: "no default pipeline for org" };

  const facts = lead.facts ?? {};
  const hash = lead.contact_number_hash;
  const displayName = leadTitle(
    lead.contact_name,
    null,
    lead.contact_number_prefix,
    lead.contact_number_last3,
  );

  // ── Contact ────────────────────────────────────────────────────────────
  let contactId: string;
  if (hash) {
    const {
      rows: [contact],
    } = await client.query<{ id: string }>(
      `INSERT INTO contacts
         (org_id, workspace_id, display_name, phone_hash, phone_prefix, phone_last3,
          source_lead_id, facts, first_call_id, last_call_id, call_count, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       ON CONFLICT (org_id, phone_hash) WHERE phone_hash IS NOT NULL AND status <> 'merged'
       DO UPDATE SET
         -- Only upgrade the name once a call has actually named the contact —
         -- otherwise a later unnamed/numberless call would overwrite a real
         -- name with the "Unknown caller" fallback.
         display_name   = CASE WHEN EXCLUDED.display_name <> 'Unknown caller'
                                THEN EXCLUDED.display_name ELSE contacts.display_name END,
         source_lead_id = COALESCE(contacts.source_lead_id, EXCLUDED.source_lead_id),
         facts          = contacts.facts || EXCLUDED.facts,
         last_call_id   = EXCLUDED.last_call_id,
         call_count     = EXCLUDED.call_count,
         last_activity_at = GREATEST(contacts.last_activity_at, EXCLUDED.last_activity_at)
       RETURNING id`,
      [
        orgId,
        lead.workspace_id,
        displayName,
        hash,
        lead.contact_number_prefix,
        lead.contact_number_last3,
        leadId,
        JSON.stringify(facts),
        lead.first_call_id,
        lead.last_call_id,
        lead.call_count,
        lead.last_activity_at,
      ],
    );
    contactId = contact.id;
  } else {
    // No dedup key — same fallback upsertLead itself uses for a numberless
    // call: match by the call/lead this contact was already anchored to,
    // or create a fresh row.
    const {
      rows: [existing],
    } = await client.query<{ id: string }>(
      `SELECT id FROM contacts
        WHERE org_id = $1 AND phone_hash IS NULL
          AND (first_call_id = $2 OR last_call_id = $2 OR source_lead_id = $3)
        LIMIT 1`,
      [orgId, lead.last_call_id, leadId],
    );
    if (existing) {
      await client.query(
        `UPDATE contacts SET
            facts = facts || $2::jsonb,
            last_call_id = COALESCE($3, last_call_id),
            call_count = $4,
            last_activity_at = GREATEST(last_activity_at, $5::timestamptz)
          WHERE id = $1`,
        [existing.id, JSON.stringify(facts), lead.last_call_id, lead.call_count, lead.last_activity_at],
      );
      contactId = existing.id;
    } else {
      const {
        rows: [created],
      } = await client.query<{ id: string }>(
        `INSERT INTO contacts
           (org_id, workspace_id, display_name, source_lead_id, facts,
            first_call_id, last_call_id, call_count, last_activity_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         RETURNING id`,
        [
          orgId,
          lead.workspace_id,
          displayName,
          leadId,
          JSON.stringify(facts),
          lead.first_call_id,
          lead.last_call_id,
          lead.call_count,
          lead.last_activity_at,
        ],
      );
      contactId = created.id;
    }
  }

  // ── Deal ───────────────────────────────────────────────────────────────
  const stages = parsePipelineStages(pipeline.stages);
  const {
    rows: [deal],
  } = await client.query<{ id: string; created: boolean }>(
    `INSERT INTO deals
       (org_id, workspace_id, pipeline_id, contact_id, name, stage, amount, summary,
        telecaller_id, source_lead_id, facts, first_call_id, last_call_id, call_count, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)
     ON CONFLICT (source_lead_id) WHERE source_lead_id IS NOT NULL
     DO UPDATE SET
       -- Stage/status/telecaller are the owner's, never the pipeline's —
       -- deliberately absent here, mirroring upsertLead's own DO UPDATE SET
       -- (apps/worker/src/pipeline/leads.ts).
       contact_id   = EXCLUDED.contact_id,
       summary      = COALESCE(EXCLUDED.summary, deals.summary),
       amount       = COALESCE(EXCLUDED.amount, deals.amount),
       facts        = deals.facts || EXCLUDED.facts,
       last_call_id = EXCLUDED.last_call_id,
       call_count   = EXCLUDED.call_count,
       last_activity_at = GREATEST(deals.last_activity_at, EXCLUDED.last_activity_at)
     RETURNING id, (xmax = 0) AS created`,
    [
      orgId,
      lead.workspace_id,
      pipeline.id,
      contactId,
      displayName,
      entryStage(stages),
      lead.value_num,
      lead.summary,
      lead.telecaller_id,
      leadId,
      JSON.stringify(facts),
      lead.first_call_id,
      lead.last_call_id,
      lead.call_count,
      lead.last_activity_at,
    ],
  );

  // ── Stage history (migration 0046) ─────────────────────────────────────
  // Only on creation. This projection deliberately never MOVES a deal —
  // stage is the owner's, as the ON CONFLICT above says — so the one and only
  // transition it can honestly record is the deal entering the pipeline.
  // Writing anything on an update would put a move in the ledger that never
  // happened.
  if (deal.created) {
    await client.query(
      `INSERT INTO deal_stage_transitions
         (org_id, deal_id, from_stage, to_stage, from_status, to_status, source, actor_label)
       VALUES ($1, $2, NULL, $3, NULL, 'open', 'pipeline', 'call pipeline')`,
      [orgId, deal.id, entryStage(stages)],
    );
  }

  // ── Typed custom fields (Track A4) ─────────────────────────────────────
  // The same `facts` blob written above, projected into whatever fields this
  // org has actually defined. Runs for both objects because a definition can
  // exist on either; costs one indexed lookup that returns nothing when an
  // org has defined none, which is the common case.
  await projectFactsToCustomFields(client, orgId, "contact", contactId, facts);
  await projectFactsToCustomFields(client, orgId, "deal", deal.id, facts);

  // ── Timeline ───────────────────────────────────────────────────────────
  // The calls this lead actually knows about. On the live path last_call_id
  // IS the call just processed, so every completed call lands on the timeline
  // as it happens; the backfill's second pass reaches the rest of history by
  // walking `calls` directly.
  //
  // Inside the same transaction as the Contact/Deal writes above, so a
  // timeline row can never reference a deal that got rolled back — and
  // outside any try/catch here, deliberately: pipeline.ts already wraps this
  // whole function non-blockingly, and swallowing an error a second time
  // would hide it from that log.
  const callIds = [...new Set([lead.first_call_id, lead.last_call_id].filter(Boolean))] as string[];
  for (const callId of callIds) {
    await projectCallToInteraction(client, orgId, callId, contactId, deal.id);
  }

  return { contactId, dealId: deal.id, reason: deal.created ? "created" : "updated" };
}
