import { getAdminPool, projectLeadToCrm, routeLead, withOrgContext } from "@aura/db";
import { dueDate, entryStage, leadTitle, parseLeadStages, statusForStage } from "@aura/shared";
import type { DbClient } from "./crm-dispatch";
import { notifyMissedCallOwner } from "./missed-call-notify";

/**
 * Missed calls from UNKNOWN callers become leads (migration 0134 - the
 * "auto-create" half of 0133's follow-up list).
 *
 * ── WHY THIS DOES NOT REUSE upsertLead, ingestIntakeLead, OR call-triage's
 *    createLead ───────────────────────────────────────────────────────────
 *
 * All three exist and all three were considered:
 *
 *   - upsertLead (leads.ts) needs a qualifying EXTRACTION - facts, an agent, a
 *     transcript. A missed call has none of that to qualify.
 *   - ingestIntakeLead (lead-intake.ts) is built around a `lead_sources` row -
 *     a channel a tenant configures, with a webhook token and a dedup ledger.
 *     A missed call is not configured, it exists the moment call-log
 *     permission does, and it already has a perfectly good idempotency key of
 *     its own: the CALL. Once linked (`calls.lead_id`), it can never be
 *     re-selected by the query below - no ledger required.
 *   - call-triage.controller.ts's createLead is the closest relative and this
 *     file's INSERT is deliberately shaped like it (same thin columns, same
 *     ON CONFLICT), but it is a PERSON pressing a button - "safety rule 2,
 *     read literally" per its own header. This sweep exists because the
 *     person explicitly asked for that gate lifted for this one channel:
 *     an unknown missed caller should not have to wait for anybody to notice
 *     the triage queue before a telecaller is told to ring them back.
 *
 * ── WHAT THE LEAD LOOKS LIKE ─────────────────────────────────────────────
 *
 * `entryStage` - not a stage invented for this - and `temperature = 'hot'`,
 * same as 0083 already renders on every board regardless of which columns a
 * tenant kept. See migration 0134's header for why no stage is added: three
 * other call-sourced-lead paths in this codebase all made the same call, and
 * `lead_stages` is tenant data (0010), not this platform's to extend for
 * every business it runs.
 *
 * ── WHO IT IS ASSIGNED TO ────────────────────────────────────────────────
 *
 * Directly to `calls.telecaller_id` - whoever's handset the call rang on -
 * NEVER through the round-robin engine, for the reason 0105's header gives
 * for call leads generally: "a lead created by the handset pipeline already
 * has a human on it... routing it to somebody else would take a conversation
 * off the person who had it." A missed call on a SHARED line with no
 * telecaller attribution is the one case that reasoning does not cover, so
 * only then does this fall back to `routeLead`.
 */

const BATCH = Number(process.env.MISSED_CALL_LEAD_BATCH ?? 200);

interface OrgRow {
  id: string;
}

interface CallRow {
  workspace_id: string;
  device_id: string | null;
  telecaller_id: string | null;
  remote_name: string | null;
  remote_number_hash: string;
  remote_number_prefix: string | null;
  remote_number_last3: string | null;
  started_at: string;
  lead_id: string | null;
  lead_stages: unknown;
}

/**
 * One missed call, inside the org's RLS context and its own transaction (a
 * caller loops this per call rather than batching many into one, so a bad row
 * costs nothing beyond itself - see the module header on why no ledger claim
 * is needed to make that safe).
 *
 * FOR UPDATE, then re-checked: the ordinary hash-match sweep (call-lead-link
 * .ts) runs in the same tick and can win the race to link this exact call to
 * an existing lead between this sweep reading its candidate list and writing.
 * Losing that race is the GOOD outcome - it means the caller was not actually
 * unknown - so this simply returns without creating anything.
 */
export async function createLeadFromMissedCall(client: DbClient, orgId: string, callId: string): Promise<boolean> {
  const {
    rows: [call],
  } = await client.query<CallRow>(
    `SELECT c.workspace_id, c.device_id, c.telecaller_id, c.remote_name,
            c.remote_number_hash, c.remote_number_prefix, c.remote_number_last3,
            c.started_at, c.lead_id, o.lead_stages
       FROM calls c
       JOIN organizations o ON o.id = c.org_id
      WHERE c.id = $1
      FOR UPDATE OF c`,
    [callId],
  );
  if (!call || call.lead_id || !call.remote_number_hash) return false;

  const stages = parseLeadStages(call.lead_stages);
  const stage = entryStage(stages);
  const title = leadTitle(null, call.remote_name, call.remote_number_prefix, call.remote_number_last3);

  const {
    rows: [lead],
  } = await client.query<{ id: string; created: boolean }>(
    `INSERT INTO leads
       (org_id, workspace_id, contact_name, contact_number_hash, contact_number_prefix,
        contact_number_last3, title, stage, status, telecaller_device_id, telecaller_id,
        assigned_telecaller_id, first_call_id, last_call_id, last_activity_at, call_count,
        source_channel, temperature, temperature_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $12, $13, 1, 'missed_call', 'hot', 'auto')
     ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
     DO UPDATE SET last_activity_at = GREATEST(leads.last_activity_at, EXCLUDED.last_activity_at)
     RETURNING id, (xmax = 0) AS created`,
    [
      orgId,
      call.workspace_id,
      call.remote_name,
      call.remote_number_hash,
      call.remote_number_prefix,
      call.remote_number_last3,
      title,
      stage,
      statusForStage(stages, stage),
      call.device_id,
      call.telecaller_id,
      callId,
      call.started_at,
    ],
  );
  if (!lead) return false;

  await client.query(
    `UPDATE calls
        SET lead_id = $2, lead_link_source = 'auto', lead_linked_at = now()
      WHERE id = $1`,
    [callId, lead.id],
  );

  // A lead the conflict path just discovered was NOT actually unknown - some
  // other write beat this sweep to it. Notify like any other missed call
  // landing on an owned lead, and stop: it already has whatever stage,
  // temperature and assignment that other write gave it, and this sweep must
  // not second-guess them.
  if (!lead.created) {
    await notifyMissedCallOwner(client, orgId, { callId, leadId: lead.id, callerTitle: title });
    return false;
  }

  let contactId: string | null = null;
  let dealId: string | null = null;
  try {
    const projection = await projectLeadToCrm(client, orgId, lead.id, { emitEvents: true });
    contactId = projection.contactId;
    dealId = projection.dealId;
  } catch (err) {
    console.error(`missed-call lead: crm projection failed for lead ${lead.id} (non-blocking):`, err);
  }

  // Whoever's handset it rang on, or - a shared line with no attribution -
  // the org's own routing rules. Never both: routeLead only ever fills a NULL
  // assigned_telecaller_id (0105), which this INSERT already set when
  // call.telecaller_id existed.
  let telecallerId = call.telecaller_id;
  let routedNotification = false;
  if (!telecallerId) {
    try {
      const routed = await routeLead(client, orgId, { leadId: lead.id, dealId, trigger: "intake" });
      telecallerId = routed.telecallerId;
      routedNotification = routed.assigned;
    } catch (err) {
      console.error(`missed-call lead: routing failed for lead ${lead.id} (non-blocking):`, err);
    }
  }
  if (!telecallerId) return true;

  const {
    rows: [tc],
  } = await client.query<{ user_id: string | null }>(
    `SELECT user_id FROM telecallers WHERE id = $1 AND org_id = $2`,
    [telecallerId, orgId],
  );

  // The "time duration" a telecaller works to: due today, high priority - the
  // customer already tried once and nobody answered. `contact_id` is the
  // projected CRM contact (tasks.contact_id references `contacts`, not
  // `leads`), so a failed projection above leaves this task unattached to a
  // contact but still on the telecaller's list - a task nobody can find is a
  // worse failure than one missing a cross-reference.
  await client.query(
    `INSERT INTO tasks (org_id, title, notes, contact_id, deal_id, assignee_user_id, due_on, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'high')`,
    [
      orgId,
      `Call back ${title}`,
      "Missed call - nobody has spoken to them yet.",
      contactId,
      dealId,
      tc?.user_id ?? null,
      dueDate(0, new Date()),
    ],
  );

  // routeLead already rang its own bell when it did the assigning; a second
  // one for the same event is noise, not information (see NotificationKind's
  // doc comment on 'missed_call').
  if (tc?.user_id && !routedNotification) {
    await notifyMissedCallOwner(client, orgId, { callId, leadId: lead.id, callerTitle: title });
  }

  return true;
}

async function createLeadsForOrg(orgId: string): Promise<number> {
  // A short read-only transaction claims the candidate ids; the heavier work
  // below (CRM projection, routing, a task) then runs one call at a time in
  // its OWN transaction, so a single bad row rolls back to exactly nothing -
  // no savepoint gymnastics needed - and simply gets picked up again next
  // tick, the same convergence every sweep in this file's neighbourhood
  // relies on.
  const callIds = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM calls
        WHERE org_id = $1
          AND direction = 'incoming' AND duration_s = 0 AND status = 'NO_AUDIO'
          AND lead_id IS NULL AND lead_link_dismissed_at IS NULL
          AND remote_number_hash IS NOT NULL
        ORDER BY started_at ASC
        LIMIT $2`,
      [orgId, BATCH],
    );
    return rows.map((r) => r.id);
  });

  let created = 0;
  for (const callId of callIds) {
    try {
      const did = await withOrgContext(orgId, (client) => createLeadFromMissedCall(client, orgId, callId));
      if (did) created++;
    } catch (err) {
      console.error(`missed-call lead: org ${orgId} call ${callId}:`, err);
    }
  }
  return created;
}

/** Create leads for every active org's unclaimed missed callers. */
export async function runMissedCallLeadCreate(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    `SELECT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND EXISTS (
          SELECT 1 FROM calls c
           WHERE c.org_id = o.id
             AND c.direction = 'incoming' AND c.duration_s = 0 AND c.status = 'NO_AUDIO'
             AND c.lead_id IS NULL AND c.lead_link_dismissed_at IS NULL
             AND c.remote_number_hash IS NOT NULL
        )`,
  );
  if (orgs.length === 0) return 0;

  let created = 0;
  for (const org of orgs) {
    try {
      created += await createLeadsForOrg(org.id);
    } catch (err) {
      console.error(`missed-call leads: org ${org.id}:`, err);
    }
  }
  if (created > 0) console.log(`missed-call leads: created ${created} lead(s) from unmatched missed callers`);
  return created;
}

export function startMissedCallLeadSweep(): NodeJS.Timeout {
  const interval = Number(process.env.MISSED_CALL_LEAD_INTERVAL_MS ?? 5 * 60 * 1000);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runMissedCallLeadCreate()
      .catch((err) => console.error("missed-call lead sweep:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
