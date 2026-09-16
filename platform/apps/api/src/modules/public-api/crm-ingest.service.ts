import { createHash } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import {
  detectProjects,
  entryStage,
  parseLeadStages,
  statusForStage,
  type DetectableProject,
} from "@aura/shared";
import {
  findLiveContact,
  projectFactsToCustomFields,
  queueContactCreated,
  queueDealCreated,
  recordDealEntry,
  recordNoPipeline,
  resolveDealPipeline,
  routeLead,
} from "@aura/db";
import { DbService } from "../../db/db.service";

/**
 * The one implementation behind BOTH external front doors.
 *
 * `public-api.controller.ts` (REST) and `mcp-server.controller.ts` (MCP
 * JSON-RPC) are transports and nothing else - neither contains a SQL statement.
 * That is deliberate and is the main structural decision in this module: an MCP
 * tool and its REST twin that each built their own query would drift, and the
 * drift would be invisible until an integration and an agent disagreed about
 * what "create a lead" did to the same tenant.
 *
 * ── WHERE AN EXTERNALLY-CREATED LEAD LANDS ────────────────────────────────
 *
 * On `leads`, `contacts` AND `deals`, in one transaction - not on one of them.
 *
 * The Meta webhook (0063) writes contacts/deals only, and the consequence is
 * that an ad lead never appears on the Lead Board, which is what the console
 * still renders as primary (`crmShadowReadEnabled` defaults off). An external
 * integration that created records the tenant cannot see on the screen they
 * actually use would be a broken feature, however correct the rows were.
 *
 * The dedup key is `(workspace_id, contact_number_hash)` - deliberately the
 * SAME key `upsertLead` uses in the call pipeline. So if a telecaller later
 * phones a number an integration already pushed, the call converges onto that
 * lead instead of forking a duplicate. Matching the existing key is the whole
 * point; inventing a new one here would have quietly created the duplicate-lead
 * problem this codebase already has six phone normalisers' worth of.
 */

export interface CreateLeadInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Free text the project detector reads: enquiry, notes, campaign name. */
  notes?: string | null;
  /** Arbitrary structured facts, merged into leads.facts / deals.facts. */
  facts?: Record<string, unknown> | null;
  value?: number | null;
  /** Overrides detection when the caller already knows the project. */
  projectKey?: string | null;

  // ── Attribution (migration 0078) ────────────────────────────────────────
  //
  // Optional throughout, so the existing API-key callers behave exactly as
  // before. The intake engine supplies them for every channel it serves, which
  // is what finally lets the board say where a card came from.
  //
  // FIRST TOUCH WINS on every one of these. A lead that arrived from a Google
  // Ads form in March and re-submits through a LinkedIn form in June is still
  // a lead Google Ads produced; overwriting the channel on the second touch
  // would silently move the credit and make every acquisition report wrong in
  // the direction of whatever the prospect touched last. The ON CONFLICT
  // clauses below COALESCE rather than assign for exactly this reason.
  /** Which channel this arrived by. See @aura/shared LeadSourceChannel. */
  sourceChannel?: string | null;
  /** The specific configured `lead_sources` row, when there was one. */
  leadSourceId?: string | null;
  /** The campaign, inherited from the source's own configuration. */
  marketingSourceId?: string | null;
  /**
   * Who works it, when the CALLER already knows.
   *
   * Still never a rotation: a value here is a person's decision (a source
   * pinned to one owner, an integration naming a rep) and it outranks every
   * distribution rule. Rotation arrived in 0105 and runs AFTER this write,
   * only when this field is empty and only on a newly created lead - see
   * the routing block at the end of `writeLead`.
   */
  assignedTelecallerId?: string | null;
  /** Which desk. Defaults to the org's first workspace, as before. */
  workspaceId?: string | null;
  /** Recorded as a fact; accounts are not auto-created from an integration. */
  company?: string | null;

  // ── The source's own clock (migration 0100) ─────────────────────────────
  //
  // When the enquiry happened according to WHOEVER SENT IT, which for anything
  // that is not a live webhook is not when this row gets written. Response
  // time and lead ageing both measure from COALESCE(source_created_at,
  // created_at), so a lead imported today that the customer sent last Tuesday
  // is measured from Tuesday.
  //
  // Null is the correct and common answer - it means the source did not say -
  // and the reports fall back. Never defaulted to now(): that would ASSERT the
  // enquiry happened at import time, which is the claim that made the metric
  // wrong in the first place.
  sourceCreatedAt?: Date | string | null;
  /** The source's own id for it, for tracing back without the intake ledger. */
  sourceRef?: string | null;
}

/** Any open transaction. Both the pool client and a test double satisfy it. */
export interface IngestClient {
  query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
}

export interface LeadRecord {
  leadId: string;
  contactId: string;
  dealId: string | null;
  created: boolean;
  title: string;
  stage: string;
  status: string;
  projectKey: string | null;
  projectDetectedFrom: string | null;
  /**
   * Who the distribution engine (0094) gave it to, when it ran and picked
   * somebody. Null covers three different things - not a new lead, already
   * assigned, no rule matched - and callers should treat all three the same
   * way: the lead is fine, it just has no automatic owner. The reason is in
   * `lead_routing_assignments` when a rule was involved at all.
   */
  routedTelecallerId: string | null;
}

/**
 * ONE phone normaliser for this module, with a minimum-length floor.
 *
 * The codebase has several divergent ones and only some carry a floor. Without
 * it, a caller sending `"n/a"` or `"-"` produces a short digit string that
 * becomes a real dedupe key - and every future junk submission then merges onto
 * the same contact. A false MERGE is the worst CRM outcome there is, strictly
 * worse than a duplicate, because no one can tell it happened. Six digits is
 * below any real subscriber number and above every junk fragment seen so far.
 */
const MIN_PHONE_DIGITS = 6;

function phoneParts(raw: string | null | undefined) {
  const digits = (raw ?? "").replace(/\D+/gu, "");
  if (digits.length < MIN_PHONE_DIGITS) {
    return { digits: "", hash: null, prefix: null, last3: null };
  }
  return {
    digits,
    hash: createHash("sha256").update(digits).digest("hex"),
    prefix: digits.slice(0, 5) || null,
    last3: digits.slice(-3),
  };
}

@Injectable()
export class CrmIngestService {
  constructor(private readonly db: DbService) {}

  async createLead(orgId: string, input: CreateLeadInput): Promise<LeadRecord> {
    return this.db.withOrg(orgId, (client) => this.writeLead(client, orgId, input));
  }

  /**
   * The write itself, on a caller-supplied transaction.
   *
   * Split out for the intake engine (0078), which must land its ledger row and
   * its lead in ONE transaction: if the lead write fails, the claim that says
   * "this arrival was handled" has to disappear with it, or a retry from the
   * provider would be swallowed as a duplicate and the lead lost for good.
   * Nesting `withOrg` here would put them on two connections and two
   * transactions, which is precisely the failure that would produce.
   */
  async writeLead(client: IngestClient, orgId: string, input: CreateLeadInput): Promise<LeadRecord> {
    {
      const {
        rows: [org],
      } = await client.query<{ lead_stages: unknown; workspace_id: string | null }>(
        // A caller-supplied workspace is honoured only if it really belongs to
        // this org. RLS would already refuse a foreign one on INSERT, but that
        // surfaces as a constraint violation mid-transaction; resolving it here
        // means an unknown workspace quietly falls back to the default instead
        // of failing a webhook the tenant cannot debug.
        `SELECT o.lead_stages,
                COALESCE(
                  (SELECT w.id FROM workspaces w WHERE w.org_id = o.id AND w.id = $2::uuid),
                  (SELECT w.id FROM workspaces w
                    WHERE w.org_id = o.id ORDER BY w.created_at ASC LIMIT 1)
                ) AS workspace_id
           FROM organizations o WHERE o.id = $1`,
        [orgId, input.workspaceId ?? null],
      );
      // workspace_id is NOT NULL on leads. An org with no workspace cannot hold
      // one, and silently inventing a workspace from an integration request
      // would create tenant structure nobody asked for.
      if (!org?.workspace_id) {
        throw new NotFoundException("this organization has no workspace to attach a lead to");
      }

      const phone = phoneParts(input.phone);
      const email = input.email?.trim().toLowerCase() || null;
      const title =
        input.name?.trim() ||
        email ||
        (phone.prefix ? `${phone.prefix}…` : null) ||
        "API lead";
      // Company rides in facts rather than creating an `accounts` row. An
      // account is a real CRM object with an owner and a hierarchy, and a
      // string typed into a web form is not evidence enough to make one - the
      // import path (0062) makes the same call.
      const facts = { ...(input.facts ?? {}), ...(input.company ? { company: input.company } : {}) };

      const stages = parseLeadStages(org.lead_stages);
      const stage = entryStage(stages);
      const status = statusForStage(stages, stage);

      // ── Contact: find-or-create over BOTH partial unique indexes ─────────
      // Two lookups rather than one ON CONFLICT because a single conflict
      // target cannot cover `contacts_org_phone` and `contacts_org_email`.
      // Same order, and the same reason, as import.controller.ts and the Meta
      // webhook: an unguarded INSERT here raises 23505 for anyone the tenant
      // already knows, and inside a transaction that loses the whole request.
      //
      // Through findLiveContact, which also follows a MERGE: a number or email
      // left on a merged-away contact resolves to the survivor, instead of
      // quietly recreating the duplicate an operator just merged (doc 23, D2).
      let contact: { id: string; account_id: string | null } | undefined;
      let contactCreated = false;
      const known = await findLiveContact(client, orgId, { phoneHash: phone.hash, email });
      if (known) contact = { id: known.id, account_id: known.accountId };
      if (!contact) {
        contactCreated = true;
        ({
          rows: [contact],
        } = await client.query<{ id: string; account_id: string | null }>(
          `INSERT INTO contacts (org_id, workspace_id, display_name, email,
                                 phone_hash, phone_prefix, phone_last3, facts,
                                 source_channel, marketing_source_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
           RETURNING id, account_id`,
          [
            orgId,
            org.workspace_id,
            title,
            email,
            phone.hash,
            phone.prefix,
            phone.last3,
            JSON.stringify(facts),
            input.sourceChannel ?? null,
            input.marketingSourceId ?? null,
          ],
        ));
      } else {
        // COALESCE only. An integration re-pushing a known person must not
        // blank a field a human filled in, and first-touch attribution stands.
        await client.query(
          `UPDATE contacts
              SET email        = COALESCE(email, $2),
                  phone_hash   = COALESCE(phone_hash, $3),
                  phone_prefix = COALESCE(phone_prefix, $4),
                  phone_last3  = COALESCE(phone_last3, $5),
                  facts        = facts || $6::jsonb,
                  -- First touch, never last: see CreateLeadInput's header.
                  source_channel      = COALESCE(source_channel, $7),
                  marketing_source_id = COALESCE(marketing_source_id, $8),
                  last_activity_at = now()
            WHERE id = $1`,
          [
            contact.id,
            email,
            phone.hash,
            phone.prefix,
            phone.last3,
            JSON.stringify(facts),
            input.sourceChannel ?? null,
            input.marketingSourceId ?? null,
          ],
        );
      }

      // ── Lead: upsertLead's own dedup key, so a later CALL converges ──────
      let lead: { id: string; created: boolean } | undefined;
      if (phone.hash) {
        ({
          rows: [lead],
        } = await client.query<{ id: string; created: boolean }>(
          `INSERT INTO leads (org_id, workspace_id, contact_name, contact_number_hash,
                              contact_number_prefix, contact_number_last3, title, stage, status,
                              summary, facts, value_num, call_count, last_activity_at,
                              source_channel, lead_source_id, marketing_source_id,
                              assigned_telecaller_id, source_created_at, source_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 0, now(),
                   $13, $14, $15, $16, $17, $18)
           ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
           DO UPDATE SET
             -- Stage and status are the owner's, never an integration's: a
             -- re-push must not drag a lead someone is negotiating back to New.
             contact_name = COALESCE(leads.contact_name, EXCLUDED.contact_name),
             summary      = COALESCE(EXCLUDED.summary, leads.summary),
             facts        = leads.facts || EXCLUDED.facts,
             value_num    = COALESCE(EXCLUDED.value_num, leads.value_num),
             -- Attribution is first-touch, and assignment is a person's
             -- decision: a second submission through a different form must not
             -- re-credit the channel or take the lead off whoever is working
             -- it. All four COALESCE onto the EXISTING row for that reason.
             source_channel      = COALESCE(leads.source_channel, EXCLUDED.source_channel),
             lead_source_id      = COALESCE(leads.lead_source_id, EXCLUDED.lead_source_id),
             marketing_source_id = COALESCE(leads.marketing_source_id, EXCLUDED.marketing_source_id),
             assigned_telecaller_id =
               COALESCE(leads.assigned_telecaller_id, EXCLUDED.assigned_telecaller_id),
             -- First touch here too, and for a sharper reason than the others:
             -- a lead that re-submits in June must keep the March enquiry time,
             -- or its response time silently resets and a lead nobody answered
             -- for three months reads as fresh.
             source_created_at = COALESCE(leads.source_created_at, EXCLUDED.source_created_at),
             source_ref        = COALESCE(leads.source_ref, EXCLUDED.source_ref),
             last_activity_at = now()
           RETURNING id, (xmax = 0) AS created`,
          [
            orgId,
            org.workspace_id,
            input.name?.trim() ?? null,
            phone.hash,
            phone.prefix,
            phone.last3,
            title,
            stage,
            status,
            input.notes?.trim() ?? null,
            JSON.stringify(facts),
            input.value ?? null,
            input.sourceChannel ?? null,
            input.leadSourceId ?? null,
            input.marketingSourceId ?? null,
            input.assignedTelecallerId ?? null,
            input.sourceCreatedAt ?? null,
            input.sourceRef ?? null,
          ],
        ));
      } else {
        // No dedupe key at all (no usable phone). A fresh row is the only
        // honest option - matching on name would merge two different people
        // who happen to share one.
        ({
          rows: [lead],
        } = await client.query<{ id: string; created: boolean }>(
          `INSERT INTO leads (org_id, workspace_id, contact_name, title, stage, status,
                              summary, facts, value_num, call_count, last_activity_at,
                              source_channel, lead_source_id, marketing_source_id,
                              assigned_telecaller_id, source_created_at, source_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 0, now(), $10, $11, $12, $13,
                   $14, $15)
           RETURNING id, true AS created`,
          [
            orgId,
            org.workspace_id,
            input.name?.trim() ?? null,
            title,
            stage,
            status,
            input.notes?.trim() ?? null,
            JSON.stringify(facts),
            input.value ?? null,
            input.sourceChannel ?? null,
            input.leadSourceId ?? null,
            input.marketingSourceId ?? null,
            input.assignedTelecallerId ?? null,
            input.sourceCreatedAt ?? null,
            input.sourceRef ?? null,
          ],
        ));
      }

      // Link the contact back to the lead it came from.
      //
      // The contact is created BEFORE the lead (its id is needed for the deal),
      // so this cannot be a column on that INSERT. It matters because the
      // worker's `projectLeadToCrm` matches a PHONE-LESS contact on
      // `source_lead_id` - a contact created here without one is invisible to
      // it, and `scripts/backfill-crm-objects.js` runs that function over every
      // lead. Without this line, an email-only lead from a web form or an
      // enquiry inbox becomes a SECOND contact the next time the backfill runs.
      await client.query(
        `UPDATE contacts SET source_lead_id = COALESCE(source_lead_id, $2) WHERE id = $1`,
        [contact.id, lead.id],
      );

      // ── Deal, on the org's default pipeline ──────────────────────────────
      // resolveDealPipeline is the one rule every door uses (doc 23, B2).
      const pipeline = await resolveDealPipeline(client, orgId, { forWrite: true });
      let dealId: string | null = null;
      if (pipeline) {
        const dealStage = entryStage(pipeline.stages);
        // Same call the Meta webhook makes: pipeline stages carry the same
        // {key,label,terminal?} shape lead stages do, and `terminal` is the
        // only field statusForStage reads.
        const dealStatus = statusForStage(pipeline.stages, dealStage);
        const {
          rows: [deal],
        } = await client.query<{ id: string; account_id: string | null; created: boolean }>(
          `INSERT INTO deals (org_id, workspace_id, pipeline_id, contact_id, account_id, name, stage,
                              status, amount, summary, source_lead_id, facts, call_count,
                              last_activity_at, source_channel, marketing_source_id,
                              assigned_telecaller_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, 0, now(), $13, $14, $15)
           ON CONFLICT (source_lead_id) WHERE source_lead_id IS NOT NULL
           DO UPDATE SET
             summary = COALESCE(EXCLUDED.summary, deals.summary),
             amount  = COALESCE(EXCLUDED.amount, deals.amount),
             facts   = deals.facts || EXCLUDED.facts,
             -- The contact's account fills an empty slot only (doc 23, F2).
             account_id = COALESCE(deals.account_id, EXCLUDED.account_id),
             source_channel      = COALESCE(deals.source_channel, EXCLUDED.source_channel),
             marketing_source_id = COALESCE(deals.marketing_source_id, EXCLUDED.marketing_source_id),
             assigned_telecaller_id =
               COALESCE(deals.assigned_telecaller_id, EXCLUDED.assigned_telecaller_id),
             last_activity_at = now()
           RETURNING id, account_id, (xmax = 0) AS created`,
          [
            orgId,
            org.workspace_id,
            pipeline.id,
            contact.id,
            contact.account_id,
            title,
            dealStage,
            dealStatus,
            input.value ?? null,
            input.notes?.trim() ?? null,
            lead.id,
            JSON.stringify(facts),
            input.sourceChannel ?? null,
            input.marketingSourceId ?? null,
            input.assignedTelecallerId ?? null,
          ],
        );
        dealId = deal.id;

        // What this door used to skip, and the call pipeline never did
        // (doc 23, B3): the deal's entry row in the stage ledger, and its
        // typed custom fields.
        if (deal.created) {
          await recordDealEntry(
            client,
            orgId,
            { id: deal.id, stage: dealStage, status: dealStatus },
            "pipeline",
            input.sourceChannel ? `intake:${input.sourceChannel}` : "public-api",
          );
        }
        await projectFactsToCustomFields(client, orgId, "deal", deal.id, facts);

        // A live arrival is what a "deal created" rule is for (doc 23, C1).
        // Keyed per deal, so a provider retrying the same webhook cannot fire
        // it twice.
        if (deal.created) {
          await queueDealCreated(client, orgId, {
            id: deal.id,
            contactId: contact.id,
            accountId: deal.account_id,
            stage: dealStage,
            status: dealStatus,
            amount: input.value ?? null,
            ownerUserId: null,
          });
        }
      } else {
        await recordNoPipeline(client, orgId, "intake");
      }

      await projectFactsToCustomFields(client, orgId, "contact", contact.id, facts);
      if (contactCreated) {
        await queueContactCreated(client, orgId, {
          id: contact.id,
          accountId: contact.account_id,
          ownerUserId: null,
        });
      }

      // ── Project ──────────────────────────────────────────────────────────
      const project = await this.labelProject(client, orgId, lead.id, dealId, input);

      // ── Distribution (migration 0094) ────────────────────────────────────
      //
      // AFTER the project label, because a rule may match on `project_id` and
      // a rule that reads a column written two statements later is a rule that
      // works in testing and not in production.
      //
      // Three guards, and each one is load-bearing:
      //
      //  - `lead.created` only. A re-submission through a second form is not a
      //    new lead and must not be taken off whoever is already working it.
      //    The ON CONFLICT above already refuses to overwrite the column; this
      //    stops the engine from even spending a rule's turn on it, which
      //    would otherwise skew the rotation with leads nobody received.
      //
      //  - not when the caller named an owner. A source pinned to one person
      //    (0078) is a decision a human made, and it outranks every rule.
      //
      //  - never blocking. `routeLead` runs inside its own SAVEPOINT and
      //    returns rather than throwing, so a routing fault costs the
      //    assignment and never the lead.
      let routedTelecallerId: string | null = null;
      if (lead.created && !input.assignedTelecallerId) {
        const routed = await routeLead(client, orgId, {
          leadId: lead.id,
          dealId,
          trigger: "intake",
        });
        routedTelecallerId = routed.telecallerId;
      }

      await client.query(
        // The actor names the channel, so the audit trail distinguishes a lead
        // an integration pushed from one a web form or a phone system did.
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'system', $3, 'lead.create_via_api', 'lead', $2)`,
        [orgId, lead.id, input.sourceChannel ? `intake:${input.sourceChannel}` : "public-api"],
      );

      return {
        leadId: lead.id,
        contactId: contact.id,
        dealId,
        created: lead.created,
        title,
        stage,
        status,
        projectKey: project.key,
        projectDetectedFrom: project.matchedOn,
        routedTelecallerId,
      };
    }
  }

  /**
   * Attach a project, either because the caller named one or because the
   * deterministic detector recognised it in the supplied text.
   *
   * Reuses `detectProjects` from @aura/shared - the SAME matcher the call
   * pipeline runs on transcripts. A lead from an integration and a lead from a
   * call therefore land on the same project for the same words, which is the
   * only way the board's project filter means one thing.
   *
   * An explicitly named project is recorded as `source='human'`: the caller
   * asserted it, so the detector must never later overwrite it.
   */
  private async labelProject(
    client: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
    orgId: string,
    leadId: string,
    dealId: string | null,
    input: CreateLeadInput,
  ): Promise<{ key: string | null; matchedOn: string | null }> {
    const { rows: catalogue } = await client.query<DetectableProject & { key: string }>(
      `SELECT id, name, aliases, sort_order, key FROM crm_projects
        WHERE org_id = $1 AND active ORDER BY sort_order, lower(name)`,
      [orgId],
    );
    if (catalogue.length === 0) return { key: null, matchedOn: null };

    let projectId: string | null = null;
    let projectKey: string | null = null;
    let matchedOn: string | null = null;
    let source = "extraction";
    let confidence = 0;

    if (input.projectKey) {
      const named = catalogue.find((p) => p.key === input.projectKey);
      if (named) {
        projectId = named.id;
        projectKey = named.key;
        source = "human";
        confidence = 1;
      }
    }

    if (!projectId) {
      const haystack = [input.name, input.notes, JSON.stringify(input.facts ?? {})]
        .filter(Boolean)
        .join(" ");
      const [hit] = detectProjects(haystack, catalogue);
      if (hit) {
        projectId = hit.projectId;
        projectKey = catalogue.find((p) => p.id === hit.projectId)?.key ?? null;
        matchedOn = hit.matchedOn;
        confidence = hit.confidence;
      }
    }

    if (!projectId) return { key: null, matchedOn: null };

    // HUMAN-OWNS-IT, exactly as the worker applies it: an integration's guess
    // never overwrites a project a person set in the console.
    await client.query(
      `UPDATE leads SET project_id = $2, project_source = $3
        WHERE id = $1 AND COALESCE(project_source, 'extraction') <> 'human'`,
      [leadId, projectId, source],
    );
    if (dealId) {
      await client.query(
        `UPDATE deals SET project_id = $2, project_source = $3
          WHERE id = $1 AND COALESCE(project_source, 'extraction') <> 'human'`,
        [dealId, projectId, source],
      );
    }
    // The many-to-many record (0075), so a second project pushed for the same
    // person is added rather than silently replacing the first.
    await client.query(
      `INSERT INTO lead_projects (org_id, lead_id, project_id, source, is_primary, confidence)
       VALUES ($1, $2, $3, $4, false, $5)
       ON CONFLICT (lead_id, project_id) DO NOTHING`,
      [orgId, leadId, projectId, source, confidence],
    );

    return { key: projectKey, matchedOn };
  }

  async getLead(orgId: string, leadId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [lead],
      } = await client.query(
        `SELECT l.id, l.title, l.contact_name, l.contact_number_prefix, l.contact_number_last3,
                l.stage, l.status, l.score, l.value_num, l.summary, l.facts,
                l.call_count, l.last_activity_at, l.created_at,
                p.key AS project_key, p.name AS project_name
           FROM leads l
           LEFT JOIN crm_projects p ON p.id = l.project_id
          WHERE l.id = $1`,
        [leadId],
      );
      if (!lead) throw new NotFoundException("no lead with that id");
      return lead;
    });
  }

  async listLeads(
    orgId: string,
    opts: { limit: number; stage?: string | null; projectKey?: string | null },
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT l.id, l.title, l.contact_name, l.contact_number_prefix, l.contact_number_last3,
                l.stage, l.status, l.value_num, l.last_activity_at,
                p.key AS project_key
           FROM leads l
           LEFT JOIN crm_projects p ON p.id = l.project_id
          WHERE ($2::text IS NULL OR l.stage = $2)
            AND ($3::text IS NULL OR p.key = $3)
          ORDER BY l.last_activity_at DESC
          LIMIT $1`,
        [opts.limit, opts.stage ?? null, opts.projectKey ?? null],
      );
      return rows;
    });
  }

  async listContacts(orgId: string, opts: { limit: number; search?: string | null }) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, display_name, email, phone_prefix, phone_last3, status,
                call_count, last_activity_at, created_at
           FROM contacts
          WHERE status <> 'merged'
            AND ($2::text IS NULL OR display_name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
          ORDER BY last_activity_at DESC NULLS LAST
          LIMIT $1`,
        [opts.limit, opts.search ?? null],
      );
      return rows;
    });
  }

  async listDeals(orgId: string, opts: { limit: number; stage?: string | null }) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.name, d.stage, d.status, d.amount, d.last_activity_at,
                c.display_name AS contact_name, p.key AS project_key
           FROM deals d
           LEFT JOIN contacts c     ON c.id = d.contact_id
           LEFT JOIN crm_projects p ON p.id = d.project_id
          WHERE ($2::text IS NULL OR d.stage = $2)
          ORDER BY d.last_activity_at DESC
          LIMIT $1`,
        [opts.limit, opts.stage ?? null],
      );
      return rows;
    });
  }

  async listProjects(orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT key, name, description, aliases, active
           FROM crm_projects WHERE active ORDER BY sort_order, lower(name)`,
      );
      return rows;
    });
  }

  /** Append-only record of what a key did, for the credential-level trail. */
  async recordEvent(
    orgId: string,
    apiKeyId: string,
    channel: "rest" | "mcp",
    operation: string,
    status: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.db
        .adminPool()
        .query(
          `INSERT INTO api_key_events (org_id, api_key_id, channel, operation, status, detail)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [orgId, apiKeyId, channel, operation, status, JSON.stringify(detail)],
        );
    } catch {
      /* observability, never correctness */
    }
  }
}
