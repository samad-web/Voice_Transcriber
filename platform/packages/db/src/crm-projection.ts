import {
  type AutomationSubject,
  type AutomationTrigger,
  type CustomFieldObjectType,
  type CustomFieldType,
  entryStage,
  leadTitle,
  parsePipelineStages,
  statusForStage,
  valueColumnForType,
  valueTableForObjectType,
  valueTableIdColumn,
} from "@aura/shared";

/**
 * The Lead -> Contact/Deal projection, and the pieces every door that creates a
 * contact or a deal has to agree on.
 *
 * ── WHY THIS LIVES IN @aura/db ──────────────────────────────────────────────
 *
 * It used to be worker-only (apps/worker/src/pipeline/crm-objects.ts), which
 * the API cannot import - so the public API's intake re-implemented the deal
 * write and drifted from it (doc 23, B2/B3): a different rule for which
 * pipeline a deal lands on, no entry row in the stage ledger, no custom-field
 * projection, no automation events. Four doors (calls, web forms, email, Meta
 * ads, plus CSV import) now resolve the pipeline, open the ledger and fire the
 * events through the functions below, so they cannot disagree again.
 *
 * The worker's crm-objects.ts and custom-fields.ts re-export from here, so
 * their tests and scripts/backfill-crm-objects.js keep working unchanged.
 */

/**
 * The structural subset of pg's PoolClient these functions use - the same
 * shape crm-dispatch.ts declares, so a worker client and an API client both fit.
 */
export interface DbClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

// ── Pipeline resolution (doc 23, B2) ────────────────────────────────────────

export interface ResolvedPipeline {
  id: string;
  stages: ReturnType<typeof parsePipelineStages>;
}

/**
 * The pipeline a deal belongs on.
 *
 * With an explicit id: that pipeline, if this org can see it - and, for a
 * write, only if it is still active (a deal must not be created on a board
 * nobody can open). With no id: the org's active default, falling back to its
 * oldest active pipeline, so an org whose default was archived still gets its
 * deals somewhere visible rather than nowhere at all.
 *
 * This is the ONE rule. Before it, the worker took "any default, any status",
 * the deals controller the same, the public API "active, default first, then
 * oldest", and CSV import a fourth variant - so a tenant's deals were split
 * across pipelines by which door the lead came through.
 */
export async function resolveDealPipeline(
  client: DbClient,
  orgId: string,
  opts: { pipelineId?: string | null; forWrite?: boolean } = {},
): Promise<ResolvedPipeline | null> {
  const params: unknown[] = [orgId];
  let where = "org_id = $1";
  if (opts.pipelineId) {
    params.push(opts.pipelineId);
    where += " AND id = $2";
    if (opts.forWrite) where += " AND status = 'active'";
  } else {
    where += " AND status = 'active'";
  }
  const {
    rows: [pipeline],
  } = await client.query<{ id: string; stages: unknown }>(
    `SELECT id, stages FROM deal_pipelines
      WHERE ${where}
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1`,
    params,
  );
  if (!pipeline) return null;
  return { id: pipeline.id, stages: parsePipelineStages(pipeline.stages) };
}

/**
 * Leave one operator-visible trace when an org has nowhere to put a deal.
 *
 * Should be unreachable once a default cannot be cleared (doc 23, B1), which
 * is exactly why it stays: a tripwire that fires is information. One row per
 * org per day, because every lead for that org would otherwise hit it.
 */
export async function recordNoPipeline(client: DbClient, orgId: string, actorId: string): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, meta)
     SELECT $1, 'system', $2, 'crm.no_default_pipeline', 'organization', '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_log
         WHERE org_id = $1 AND action = 'crm.no_default_pipeline'
           AND created_at > now() - interval '24 hours'
      )`,
    [orgId, actorId],
  );
}

// ── Stage ledger entry ──────────────────────────────────────────────────────

/**
 * The first row of a new deal's stage history (migration 0046): it entering the
 * pipeline. Without it a deal's ledger starts mid-story and every funnel report
 * built on the ledger drops it.
 */
export async function recordDealEntry(
  client: DbClient,
  orgId: string,
  deal: { id: string; stage: string; status: string },
  source: string,
  actorLabel: string,
): Promise<void> {
  await client.query(
    `INSERT INTO deal_stage_transitions
       (org_id, deal_id, from_stage, to_stage, from_status, to_status, source, actor_label)
     VALUES ($1, $2, NULL, $3, NULL, $4, $5, $6)`,
    [orgId, deal.id, deal.stage, deal.status, source, actorLabel],
  );
}

// ── Automation events (doc 23, C1) ──────────────────────────────────────────

/**
 * Put one thing-that-happened on the automation queue (migration 0049).
 *
 * `dedupeKey` makes it idempotent: a reprocessed call, or a retried webhook,
 * cannot queue `deal.created` twice for the same deal.
 */
export async function queueAutomationEvent(
  client: DbClient,
  orgId: string,
  trigger: AutomationTrigger,
  subjectType: "deal" | "contact" | "task" | "interaction",
  subjectId: string,
  subject: AutomationSubject,
  dedupeKey: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO automation_events (org_id, trigger, subject_type, subject_id, payload, dedupe_key)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [orgId, trigger, subjectType, subjectId, JSON.stringify(subject), dedupeKey],
  );
}

/** `deal.created`, keyed so it can fire once per deal whichever door made it. */
export async function queueDealCreated(
  client: DbClient,
  orgId: string,
  deal: {
    id: string;
    contactId: string | null;
    accountId: string | null;
    stage: string;
    status: string;
    amount: number | string | null;
    ownerUserId: string | null;
  },
): Promise<void> {
  await queueAutomationEvent(
    client,
    orgId,
    "deal.created",
    "deal",
    deal.id,
    {
      dealId: deal.id,
      contactId: deal.contactId,
      accountId: deal.accountId,
      stage: deal.stage,
      status: deal.status,
      amount: deal.amount === null || deal.amount === undefined ? null : Number(deal.amount),
      dealOwnerUserId: deal.ownerUserId,
    },
    `deal.created:${deal.id}`,
  );
}

/** `contact.created`, keyed the same way. */
export async function queueContactCreated(
  client: DbClient,
  orgId: string,
  contact: { id: string; accountId: string | null; ownerUserId: string | null },
): Promise<void> {
  await queueAutomationEvent(
    client,
    orgId,
    "contact.created",
    "contact",
    contact.id,
    { contactId: contact.id, accountId: contact.accountId, contactOwnerUserId: contact.ownerUserId },
    `contact.created:${contact.id}`,
  );
}

// ── Contacts that were merged away (doc 23, D2) ─────────────────────────────

/** Deep enough for any real merge history; a cycle would otherwise spin forever. */
const MAX_MERGE_HOPS = 10;

/**
 * The LIVE contact that owns a phone number or email, following merges.
 *
 * A merge tombstones the victim (`status = 'merged'`, `merged_into_id` set) but
 * leaves its phone and email on the tombstone, and the unique indexes skip
 * merged rows. So a lookup that only asks for active rows finds nothing for a
 * merged-away number, and the caller creates a NEW contact - the duplicate an
 * operator just merged comes straight back on the next call or form fill.
 *
 * Returns the active match if one exists, otherwise the survivor at the end of
 * the tombstone's merge chain, otherwise null.
 */
export async function findLiveContact(
  client: DbClient,
  orgId: string,
  key: { phoneHash?: string | null; email?: string | null },
): Promise<{ id: string; accountId: string | null; viaMerge: boolean } | null> {
  const lookups: [string, string][] = [];
  if (key.phoneHash) lookups.push(["phone_hash = $2", key.phoneHash]);
  if (key.email) lookups.push(["lower(email) = $2", key.email.trim().toLowerCase()]);

  for (const [predicate, value] of lookups) {
    const { rows } = await client.query<{
      id: string;
      account_id: string | null;
      status: string;
      merged_into_id: string | null;
    }>(
      `SELECT id, account_id, status, merged_into_id FROM contacts
        WHERE org_id = $1 AND ${predicate}
        ORDER BY (status <> 'merged') DESC, updated_at DESC
        LIMIT 1`,
      [orgId, value],
    );
    const hit = rows[0];
    if (!hit) continue;
    if (hit.status !== "merged") return { id: hit.id, accountId: hit.account_id, viaMerge: false };

    const survivor = await followMerges(client, hit.merged_into_id);
    if (survivor) return { ...survivor, viaMerge: true };
  }
  return null;
}

async function followMerges(
  client: DbClient,
  startId: string | null,
): Promise<{ id: string; accountId: string | null } | null> {
  let nextId = startId;
  for (let hop = 0; nextId && hop < MAX_MERGE_HOPS; hop++) {
    const {
      rows: [row],
    } = await client.query<{ id: string; account_id: string | null; status: string; merged_into_id: string | null }>(
      `SELECT id, account_id, status, merged_into_id FROM contacts WHERE id = $1`,
      [nextId],
    );
    if (!row) return null;
    if (row.status !== "merged") return { id: row.id, accountId: row.account_id };
    nextId = row.merged_into_id;
  }
  return null;
}

// ── Typed custom fields (Track A4) ──────────────────────────────────────────

interface FieldDefinition {
  id: string;
  key: string;
  type: string;
  options: Array<{ value: string; label: string }> | null;
}

export interface CustomFieldProjection {
  written: number;
  skipped: number;
}

/**
 * Project a record's raw `facts` blob into typed custom-field values
 * (migration 0037).
 *
 * ADDITIVE: a value is written only when the extraction produced one - a call
 * that fails to mention the budget must not blank the budget an earlier call
 * established. HUMAN-OWNS-IT: a value whose `source` is 'human' is never
 * overwritten by extraction (migration 0045).
 */
export async function projectFactsToCustomFields(
  client: DbClient,
  orgId: string,
  objectType: CustomFieldObjectType,
  recordId: string,
  facts: Record<string, unknown>,
): Promise<CustomFieldProjection> {
  const keys = Object.keys(facts ?? {});
  if (keys.length === 0) return { written: 0, skipped: 0 };

  // Only fields this org actually defined, and only those the extraction
  // produced a key for - so an org with no custom fields costs exactly one
  // indexed lookup that returns nothing.
  const { rows: definitions } = await client.query<FieldDefinition>(
    `SELECT id, key, type, options
       FROM custom_field_definitions
      WHERE org_id = $1 AND object_type = $2 AND status = 'active' AND key = ANY($3::text[])`,
    [orgId, objectType, keys],
  );
  if (definitions.length === 0) return { written: 0, skipped: 0 };

  const table = valueTableForObjectType(objectType);
  const idColumn = valueTableIdColumn(objectType);

  let written = 0;
  let skipped = 0;

  for (const definition of definitions) {
    const coerced = coerce(facts[definition.key], definition);
    if (coerced === undefined) {
      skipped++;
      continue;
    }

    const column = valueColumnForType(definition.type as CustomFieldType);
    // The column name comes from valueColumnForType's closed switch and the
    // table from the object type, never from caller input. The WHERE on the
    // conflict clause is the human-owns-it rule (migration 0045).
    const { rowCount } = await client.query(
      `INSERT INTO ${table} (org_id, ${idColumn}, field_id, ${column}, source)
       VALUES ($1, $2, $3, $4, 'extraction')
       ON CONFLICT (${idColumn}, field_id)
       DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()
        WHERE ${table}.source <> 'human'`,
      [orgId, recordId, definition.id, coerced],
    );
    // A row the human owns reports as skipped, not written.
    if (rowCount && rowCount > 0) written++;
    else skipped++;
  }

  return { written, skipped };
}

/**
 * Turn one raw extracted fact into something the field's typed column will
 * accept, or `undefined` to skip it. Skipping is the right failure mode: a
 * value that does not fit the admin's declared type is better absent than
 * stored wrong.
 */
function coerce(raw: unknown, definition: FieldDefinition): unknown {
  if (raw === null || raw === undefined || raw === "") return undefined;

  switch (definition.type as CustomFieldType) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[, ]/g, ""));
      return Number.isFinite(n) ? n : undefined;
    }

    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return true;
      if (["false", "no", "n", "0"].includes(s)) return false;
      return undefined;
    }

    case "date": {
      // Only ISO-ish dates. Deliberately NOT `new Date(str)`, which reads
      // "5000" as the year 5000.
      const s = String(raw).trim();
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (!match) return undefined;
      const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
    }

    case "picklist": {
      const s = String(raw).trim();
      const options = definition.options ?? [];
      // An empty option list means the admin has not constrained it yet.
      if (options.length === 0) return s;
      const hit = options.find(
        (o) => o.value.toLowerCase() === s.toLowerCase() || o.label.toLowerCase() === s.toLowerCase(),
      );
      return hit ? hit.value : undefined;
    }

    case "multiselect": {
      const values = Array.isArray(raw)
        ? raw.map((v) => String(v).trim())
        : String(raw)
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
      if (values.length === 0) return undefined;
      const options = definition.options ?? [];
      const allowed =
        options.length === 0
          ? values
          : values
              .map((v) => options.find((o) => o.value.toLowerCase() === v.toLowerCase())?.value)
              .filter((v): v is string => Boolean(v));
      return allowed.length > 0 ? JSON.stringify(allowed) : undefined;
    }

    case "lookup":
      // A lookup points at another record by id; resolving prose to a uuid is
      // a matching problem, not a coercion one.
      return undefined;

    default:
      return String(raw);
  }
}

// ── The call timeline ───────────────────────────────────────────────────────

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
 * Idempotent on `interactions(call_id) WHERE type = 'call'`, so the live
 * dual-write, a reprocess, and the backfill can all run over the same call.
 * `account_id` is deliberately left NULL: a call's account is whatever account
 * its contact belongs to, read through the contact at query time.
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

// ── Lead -> Contact/Deal ────────────────────────────────────────────────────

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

export interface ProjectLeadOptions {
  /**
   * Queue `contact.created` / `deal.created` for records this run creates.
   *
   * FALSE BY DEFAULT, and the backfill must never pass true (doc 23, X6): it
   * replays history, and firing every tenant's "deal created -> make a task"
   * rule over months of old deals would bury the floor in work nobody asked
   * for. The live doors - calls, web forms, email, Meta ads - pass true.
   */
  emitEvents?: boolean;
}

/**
 * Project a lead the pipeline already qualified onto the Contact/Deal object
 * model (migrations 0035-0036), alongside - not instead of - the `leads` row.
 *
 * Read-after-write from `leads`, keyed on the id upsertLead() returned. Never
 * touches a deal's stage, status or telecaller on an update, so a follow-up
 * call can never silently move a deal a human is already working.
 */
export async function projectLeadToCrm(
  client: DbClient,
  orgId: string,
  leadId: string,
  options: ProjectLeadOptions = {},
): Promise<CrmObjectProjection> {
  // Two projections of the same lead at once (a reprocess racing a live call,
  // two intake retries) would otherwise both miss a phone-less contact and
  // both create one. Transaction-scoped: released at COMMIT/ROLLBACK (doc 23, B4).
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('crm-projection:' || $1))`, [leadId]);

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

  const pipeline = await resolveDealPipeline(client, orgId, { forWrite: true });
  if (!pipeline) {
    await recordNoPipeline(client, orgId, "pipeline");
    return { contactId: null, dealId: null, reason: "no default pipeline for org" };
  }

  const facts = lead.facts ?? {};
  const hash = lead.contact_number_hash;
  const displayName = leadTitle(
    lead.contact_name,
    null,
    lead.contact_number_prefix,
    lead.contact_number_last3,
  );

  // ── Contact ────────────────────────────────────────────────────────────
  let contact: { id: string; account_id: string | null; created: boolean };
  const merged = hash ? await findLiveContact(client, orgId, { phoneHash: hash }) : null;

  if (merged?.viaMerge) {
    // The number belongs to a contact that was merged away. Update the
    // survivor instead of inserting a new row, or the merge undoes itself on
    // the next call (doc 23, D2).
    await client.query(
      `UPDATE contacts SET
          facts = facts || $2::jsonb,
          last_call_id = COALESCE($3, last_call_id),
          last_activity_at = GREATEST(last_activity_at, $4::timestamptz)
        WHERE id = $1`,
      [merged.id, JSON.stringify(facts), lead.last_call_id, lead.last_activity_at],
    );
    contact = { id: merged.id, account_id: merged.accountId, created: false };
  } else if (hash) {
    const {
      rows: [row],
    } = await client.query<{ id: string; account_id: string | null; created: boolean }>(
      `INSERT INTO contacts
         (org_id, workspace_id, display_name, phone_hash, phone_prefix, phone_last3,
          source_lead_id, facts, first_call_id, last_call_id, call_count, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       ON CONFLICT (org_id, phone_hash) WHERE phone_hash IS NOT NULL AND status <> 'merged'
       DO UPDATE SET
         -- Only upgrade the name once a call has actually named the contact -
         -- otherwise a later unnamed call would overwrite a real name with the
         -- "Unknown caller" fallback.
         -- And never over a name a person set (migration 0107): a rep's
         -- correction must survive the next call's extraction.
         display_name   = CASE WHEN EXCLUDED.display_name <> 'Unknown caller'
                                 AND contacts.display_name_set_by_human_at IS NULL
                                THEN EXCLUDED.display_name ELSE contacts.display_name END,
         source_lead_id = COALESCE(contacts.source_lead_id, EXCLUDED.source_lead_id),
         facts          = contacts.facts || EXCLUDED.facts,
         last_call_id   = EXCLUDED.last_call_id,
         call_count     = EXCLUDED.call_count,
         last_activity_at = GREATEST(contacts.last_activity_at, EXCLUDED.last_activity_at)
       RETURNING id, account_id, (xmax = 0) AS created`,
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
    contact = row;
  } else {
    // No dedup key - match by the call/lead this contact was already anchored
    // to, or create a fresh row. Safe from double-creation because of the
    // advisory lock above.
    const {
      rows: [existing],
    } = await client.query<{ id: string; account_id: string | null }>(
      `SELECT id, account_id FROM contacts
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
      contact = { id: existing.id, account_id: existing.account_id, created: false };
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
      contact = { id: created.id, account_id: null, created: true };
    }
  }
  const contactId = contact.id;

  // ── Deal ───────────────────────────────────────────────────────────────
  const stage = entryStage(pipeline.stages);
  const status = statusForStage(pipeline.stages, stage);
  const {
    rows: [deal],
  } = await client.query<{ id: string; created: boolean; account_id: string | null }>(
    `INSERT INTO deals
       (org_id, workspace_id, pipeline_id, contact_id, account_id, name, stage, amount, summary,
        telecaller_id, source_lead_id, facts, first_call_id, last_call_id, call_count, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)
     ON CONFLICT (source_lead_id) WHERE source_lead_id IS NOT NULL
     DO UPDATE SET
       -- Stage/status/telecaller are the owner's, never the pipeline's -
       -- deliberately absent here, mirroring upsertLead's own DO UPDATE SET.
       contact_id   = EXCLUDED.contact_id,
       -- The contact's account fills an EMPTY slot only; an account a person
       -- set on the deal is never replaced by this projection (doc 23, F2).
       account_id   = COALESCE(deals.account_id, EXCLUDED.account_id),
       summary      = COALESCE(EXCLUDED.summary, deals.summary),
       amount       = COALESCE(EXCLUDED.amount, deals.amount),
       facts        = deals.facts || EXCLUDED.facts,
       last_call_id = EXCLUDED.last_call_id,
       call_count   = EXCLUDED.call_count,
       last_activity_at = GREATEST(deals.last_activity_at, EXCLUDED.last_activity_at)
     RETURNING id, account_id, (xmax = 0) AS created`,
    [
      orgId,
      lead.workspace_id,
      pipeline.id,
      contactId,
      contact.account_id,
      displayName,
      stage,
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
  // Only on creation. This projection never MOVES a deal, so the only
  // transition it can honestly record is the deal entering the pipeline.
  if (deal.created) {
    await recordDealEntry(client, orgId, { id: deal.id, stage, status }, "pipeline", "call pipeline");
  }

  // ── Typed custom fields (Track A4) ─────────────────────────────────────
  await projectFactsToCustomFields(client, orgId, "contact", contactId, facts);
  await projectFactsToCustomFields(client, orgId, "deal", deal.id, facts);

  // ── Timeline ───────────────────────────────────────────────────────────
  // Inside the same transaction as the Contact/Deal writes above, so a
  // timeline row can never reference a deal that got rolled back.
  const callIds = [...new Set([lead.first_call_id, lead.last_call_id].filter(Boolean))] as string[];
  for (const callId of callIds) {
    await projectCallToInteraction(client, orgId, callId, contactId, deal.id);
  }

  // ── Automation events (doc 23, C1) ─────────────────────────────────────
  // Last, so an event is only ever queued for records this transaction has
  // fully written. Keyed per record, so a reprocess cannot fire twice.
  if (options.emitEvents) {
    if (contact.created) {
      await queueContactCreated(client, orgId, {
        id: contactId,
        accountId: contact.account_id,
        ownerUserId: null,
      });
    }
    if (deal.created) {
      await queueDealCreated(client, orgId, {
        id: deal.id,
        contactId,
        accountId: deal.account_id,
        stage,
        status,
        amount: lead.value_num,
        ownerUserId: null,
      });
    }
  }

  return { contactId, dealId: deal.id, reason: deal.created ? "created" : "updated" };
}
