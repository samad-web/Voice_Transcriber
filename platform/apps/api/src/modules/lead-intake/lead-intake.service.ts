import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { decryptSecret } from "@aura/db";
import {
  intakeProvider,
  intakeRejectionReason,
  isBlockedSender,
  isInboundCall,
  isOriginAllowed,
  LeadSourceConfig,
  normalizeIntake,
  type IntakeOutcome,
  type LeadSourceKind,
  type NormalizedIntake,
} from "@aura/shared";
import { DbService } from "../../db/db.service";
import { RealtimeService } from "../realtime/realtime.service";
import { CrmIngestService, type IngestClient } from "../public-api/crm-ingest.service";
import { verifyIntakeSignature } from "./signatures";

/**
 * The lead intake engine (migration 0078).
 *
 * ── ONE PIPELINE, FOUR FRONT DOORS ────────────────────────────────────────
 *
 * A web form, a telephony webhook, an inbound email and an ad platform all
 * arrive here as `(source, payload)` and go through the same seven steps:
 *
 *   resolve the token -> verify the signature -> screen the payload ->
 *   normalise it -> claim it in the ledger -> write the lead -> record what
 *   happened
 *
 * The channel changes only what the field map says and which screens apply.
 * That is the design: five parsers writing five variants of the same INSERT is
 * how a CRM ends up with the same person as four contacts, and this codebase
 * has already paid that bill once (see meta-mcp-sync.ts's header).
 *
 * ── THE LEDGER AND THE LEAD SHARE ONE TRANSACTION ─────────────────────────
 *
 * `writeLead` is called on THIS service's transaction, not its own. If the
 * lead write fails, the claim saying "this arrival was handled" must vanish
 * with it - otherwise the provider's retry is swallowed as a duplicate and the
 * lead is lost permanently, which is the worst failure this system can have.
 *
 * The mirror of that: an error event is recorded with `external_id = NULL`, on
 * a fresh transaction, so it is a diagnostic record and never an idempotency
 * claim. A failed arrival must stay retryable.
 *
 * ── IT ALWAYS ANSWERS 2xx ─────────────────────────────────────────────────
 *
 * Every provider here retries on a non-2xx, several of them aggressively. A
 * payload that cannot be parsed is recorded as `rejected` and answered 202 -
 * the failure is visible on the source's page in the console, which is where
 * the person who can fix the field mapping is, rather than in a retry storm.
 */

export interface ResolvedSource {
  id: string;
  orgId: string;
  workspaceId: string | null;
  kind: LeadSourceKind;
  provider: string;
  status: string;
  config: LeadSourceConfig;
  signingSecret: string | null;
  marketingSourceId: string | null;
  projectId: string | null;
  assignedTelecallerId: string | null;
}

export interface IntakeRequest {
  payload: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  /** Absolute URL as the provider called it. Twilio's signature covers it. */
  url: string;
  rawBody?: Buffer;
  origin?: string | null;
}

export interface IntakeResult {
  outcome: IntakeOutcome;
  reason: string | null;
  eventId: string | null;
  leadId: string | null;
  /**
   * Optional because only the two success paths have them. The Meta webhook
   * keeps its own `meta_leadgen_events` ledger pointed at the same records, so
   * the row it wrote before 0078 still resolves to a contact and a deal.
   */
  contactId?: string | null;
  dealId?: string | null;
}

/**
 * 32 bytes of CSPRNG, base64url. Same generator and the same length as
 * `messaging_channels.webhook_token`, for the same reason: it is a bearer
 * credential in a URL and its only defence is being unguessable.
 */
export function generateIntakeToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A stored payload is bounded before it ever reaches the database.
 *
 * An inbound email can carry megabytes of quoted history and a telephony
 * vendor can post a hundred fields. Neither helps diagnose a mapping problem,
 * and both would make the ledger the largest table in the schema within a
 * month.
 */
const MAX_PAYLOAD_KEYS = 80;
const MAX_PAYLOAD_VALUE = 2000;

function boundPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (count >= MAX_PAYLOAD_KEYS) {
      out["…"] = `${Object.keys(payload).length - count} more fields not stored`;
      break;
    }
    count += 1;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      const json = JSON.stringify(value);
      out[key.slice(0, 60)] = json.length > MAX_PAYLOAD_VALUE ? `${json.slice(0, MAX_PAYLOAD_VALUE)}…` : value;
      continue;
    }
    const text = String(value);
    out[key.slice(0, 60)] = text.length > MAX_PAYLOAD_VALUE ? `${text.slice(0, MAX_PAYLOAD_VALUE)}…` : value;
  }
  return out;
}

@Injectable()
export class LeadIntakeService {
  constructor(
    private readonly db: DbService,
    private readonly ingest: CrmIngestService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Token -> tenant, on the admin pool.
   *
   * The one place in this module that runs outside an org context, and for the
   * same reason messaging-webhook.controller.ts does it: there is no org to
   * enter until the token has been resolved. Nothing is written here; the
   * moment an org is known, every subsequent statement runs inside that org's
   * own RLS context like every other CRM write.
   */
  async resolveSource(token: string): Promise<ResolvedSource | null> {
    if (typeof token !== "string" || token.length < 16 || token.length > 200) return null;
    const {
      rows: [row],
    } = await this.db.adminPool().query<{
      id: string;
      org_id: string;
      workspace_id: string | null;
      kind: LeadSourceKind;
      provider: string;
      status: string;
      config: unknown;
      signing_secret: string | null;
      marketing_source_id: string | null;
      project_id: string | null;
      assigned_telecaller_id: string | null;
    }>(
      `SELECT id, org_id, workspace_id, kind, provider, status, config, signing_secret,
              marketing_source_id, project_id, assigned_telecaller_id
         FROM lead_sources WHERE intake_token = $1`,
      [token],
    );
    if (!row) return null;
    const config = LeadSourceConfig.safeParse(row.config ?? {});
    return {
      id: row.id,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      kind: row.kind,
      provider: row.provider,
      status: row.status,
      // A config that no longer parses (a hand-edited row, a rolled-back
      // deploy) must not take the source offline: an empty config is the
      // documented default behaviour for every field in it.
      config: config.success ? config.data : {},
      signingSecret: decryptSecret(row.signing_secret),
      marketingSourceId: row.marketing_source_id,
      projectId: row.project_id,
      assignedTelecallerId: row.assigned_telecaller_id,
    };
  }

  /**
   * The whole pipeline for one arrival, on its own transaction. Never throws.
   *
   * The webhook controllers use this. The Meta webhook uses `ingestOnClient`
   * instead, because it is already inside a transaction of its own.
   */
  async ingestPayload(source: ResolvedSource, req: IntakeRequest): Promise<IntakeResult> {
    try {
      const result = await this.db.withOrg(source.orgId, (client) =>
        this.ingestOnClient(client, source, req),
      );
      // Announced HERE and not inside `ingestOnClient`: this is the first line
      // that runs after the transaction commits. Publishing from inside it
      // would tell every open console a lead had arrived and then, on a
      // rollback, leave them re-reading for a row that never existed.
      //
      // The interceptor cannot do this for us - an unauthenticated webhook
      // resolves its tenant from a token rather than through a guard, so
      // `req.tenantOrgId` is unset and the interceptor correctly stays silent
      // rather than guessing which org to wake.
      if (result.leadId) {
        this.realtime.publish({
          orgId: source.orgId,
          topic: "lead",
          action: "created",
          id: result.leadId,
          at: new Date().toISOString(),
        });
      }
      return result;
    } catch (err) {
      // The lead write failed and took the claim down with it, which is what
      // must happen - see this module's header. Record the failure on a FRESH
      // transaction, with no external_id, so the arrival stays retryable.
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      return this.record(source, req, "error", message);
    }
  }

  /**
   * One arrival on a caller-supplied transaction.
   *
   * The ledger row and the lead land together or not at all: if the write
   * throws, the claim saying "this arrival was handled" rolls back with it, so
   * the provider's retry is processed rather than swallowed as a duplicate.
   * That is the whole reason `writeLead` was split out of `createLead`.
   *
   * Throws only if the lead write itself fails. Every business refusal - a
   * paused source, a bad signature, a honeypot, an unreadable payload, an
   * outbound call - returns a `rejected` result with its row already written.
   */
  async ingestOnClient(
    client: IngestClient,
    source: ResolvedSource,
    req: IntakeRequest,
  ): Promise<IntakeResult> {
    const screen = this.screen(source, req);
    if (screen) return this.recordOn(client, source, req, "rejected", screen.reason);

    const normalized = normalizeIntake(source.kind, source.provider, req.payload, source.config);
    const rejection = intakeRejectionReason(normalized);
    if (rejection) return this.recordOn(client, source, req, "rejected", rejection);

    const claim = await this.claim(client, source, normalized, req);
    // Already claimed by an earlier delivery of the same arrival. Meta retries,
    // Twilio retries, and a mail relay will happily deliver the same Message-Id
    // twice; each of those is one lead, not three.
    if (!claim) return { outcome: "duplicate", reason: null, eventId: null, leadId: null };

    const marketingSourceId = await this.resolveMarketingSource(client, source, normalized);
    const projectKey = await this.resolveProjectKey(client, source);

    const lead = await this.ingest.writeLead(client, source.orgId, {
      name: normalized.name,
      phone: normalized.phone,
      email: normalized.email,
      notes: normalized.notes,
      company: normalized.company,
      value: normalized.value,
      facts: this.leadFacts(source, normalized),
      projectKey: projectKey ?? normalized.projectKey,
      sourceChannel: source.kind,
      leadSourceId: source.id,
      marketingSourceId,
      assignedTelecallerId: source.assignedTelecallerId,
      workspaceId: source.workspaceId,
    });

    const outcome: IntakeOutcome = lead.created ? "created" : "updated";
    await client.query(
      `UPDATE lead_intake_events
          SET outcome = $2, reason = NULL, lead_id = $3, contact_id = $4, deal_id = $5,
              processed_at = now()
        WHERE id = $1`,
      [claim, outcome, lead.leadId, lead.contactId, lead.dealId],
    );
    await this.bumpSource(client, source.id, null);
    return {
      outcome,
      reason: null,
      eventId: claim,
      leadId: lead.leadId,
      contactId: lead.contactId,
      dealId: lead.dealId,
    };
  }

  /**
   * Find-or-create the `lead_sources` row a built-in connector attributes to.
   *
   * Meta and LinkedIn are connected through their own OAuth flows rather than
   * by somebody filling in the lead-sources form, but their leads still need a
   * source to hang the ledger, the campaign and the project default off - and a
   * tenant should see "Facebook Lead Ads" in the same list as their web form.
   * So the connector provisions one on first use, and the tenant can then
   * configure it like any other.
   *
   * A token is generated but never shown for these: neither channel posts to an
   * intake URL.
   */
  async ensureManagedSource(
    client: IngestClient,
    orgId: string,
    kind: LeadSourceKind,
    name: string,
    provider: string,
  ): Promise<ResolvedSource> {
    const {
      rows: [row],
    } = await client.query<{
      id: string;
      workspace_id: string | null;
      status: string;
      config: unknown;
      marketing_source_id: string | null;
      project_id: string | null;
      assigned_telecaller_id: string | null;
    }>(
      `INSERT INTO lead_sources (org_id, kind, name, provider, intake_token)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, kind, lower(btrim(name)))
       -- A no-op update so the row is RETURNED whether it was just created or
       -- already existed; DO NOTHING returns nothing and would cost a second
       -- round trip on every single lead.
       DO UPDATE SET updated_at = lead_sources.updated_at
       RETURNING id, workspace_id, status, config, marketing_source_id, project_id,
                 assigned_telecaller_id`,
      [orgId, kind, name, provider, generateIntakeToken()],
    );
    const config = LeadSourceConfig.safeParse(row.config ?? {});
    return {
      id: row.id,
      orgId,
      workspaceId: row.workspace_id,
      kind,
      provider,
      status: row.status,
      config: config.success ? config.data : {},
      signingSecret: null,
      marketingSourceId: row.marketing_source_id,
      projectId: row.project_id,
      assignedTelecallerId: row.assigned_telecaller_id,
    };
  }

  /**
   * Re-run a stored payload.
   *
   * The point of keeping the payload at all: a tenant fixes a field mapping and
   * gets back the twelve submissions that arrived while it was wrong, instead
   * of being told their leads are gone. It writes onto the SAME event row
   * rather than claiming a new one, so replaying is not a way to duplicate.
   */
  async replayEvent(orgId: string, eventId: string): Promise<IntakeResult> {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [event],
      } = await client.query<{ source_id: string; payload: Record<string, unknown>; outcome: string }>(
        `SELECT source_id, payload, outcome FROM lead_intake_events
          WHERE id = $1 AND org_id = $2`,
        [eventId, orgId],
      );
      if (!event) return { outcome: "error" as const, reason: "no such event", eventId: null, leadId: null };
      if (event.outcome === "created" || event.outcome === "updated") {
        return {
          outcome: "duplicate" as const,
          reason: "this arrival already produced a lead",
          eventId,
          leadId: null,
        };
      }

      const {
        rows: [row],
      } = await client.query<{
        id: string;
        workspace_id: string | null;
        kind: LeadSourceKind;
        provider: string;
        status: string;
        config: unknown;
        marketing_source_id: string | null;
        project_id: string | null;
        assigned_telecaller_id: string | null;
      }>(
        `SELECT id, workspace_id, kind, provider, status, config, marketing_source_id,
                project_id, assigned_telecaller_id
           FROM lead_sources WHERE id = $1`,
        [event.source_id],
      );
      if (!row) return { outcome: "error" as const, reason: "source is gone", eventId, leadId: null };

      const parsedConfig = LeadSourceConfig.safeParse(row.config ?? {});
      const source: ResolvedSource = {
        id: row.id,
        orgId,
        workspaceId: row.workspace_id,
        kind: row.kind,
        provider: row.provider,
        status: row.status,
        config: parsedConfig.success ? parsedConfig.data : {},
        // A replay is an operator action inside the console, not traffic from
        // the internet - there is no signature to re-verify and no request to
        // verify it against.
        signingSecret: null,
        marketingSourceId: row.marketing_source_id,
        projectId: row.project_id,
        assignedTelecallerId: row.assigned_telecaller_id,
      };

      const normalized = normalizeIntake(source.kind, source.provider, event.payload, source.config);
      const rejection = intakeRejectionReason(normalized);
      if (rejection) {
        await client.query(
          `UPDATE lead_intake_events SET outcome = 'rejected', reason = $2, processed_at = now()
            WHERE id = $1`,
          [eventId, rejection],
        );
        return { outcome: "rejected" as const, reason: rejection, eventId, leadId: null };
      }

      const marketingSourceId = await this.resolveMarketingSource(client, source, normalized);
      const projectKey = await this.resolveProjectKey(client, source);
      const lead = await this.ingest.writeLead(client, orgId, {
        name: normalized.name,
        phone: normalized.phone,
        email: normalized.email,
        notes: normalized.notes,
        company: normalized.company,
        value: normalized.value,
        facts: this.leadFacts(source, normalized),
        projectKey: projectKey ?? normalized.projectKey,
        sourceChannel: source.kind,
        leadSourceId: source.id,
        marketingSourceId,
        assignedTelecallerId: source.assignedTelecallerId,
        workspaceId: source.workspaceId,
      });
      const outcome: IntakeOutcome = lead.created ? "created" : "updated";
      await client.query(
        `UPDATE lead_intake_events
            SET outcome = $2, reason = NULL, lead_id = $3, contact_id = $4, deal_id = $5,
                processed_at = now()
          WHERE id = $1`,
        [eventId, outcome, lead.leadId, lead.contactId, lead.dealId],
      );
      return {
        outcome,
        reason: null,
        eventId,
        leadId: lead.leadId,
        contactId: lead.contactId,
        dealId: lead.dealId,
      };
    });
  }

  // ── screening ───────────────────────────────────────────────────────────

  /**
   * Everything that decides an arrival is not a lead, before any write.
   *
   * Order matters: the cheap, definitely-hostile checks (paused source, bad
   * signature, honeypot) come before parsing, so a flood of junk costs a
   * regex and not a normalisation pass.
   */
  private screen(source: ResolvedSource, req: IntakeRequest): { reason: string; normalized: null } | null {
    const reject = (reason: string) => ({ reason, normalized: null });

    if (source.status !== "active") {
      return reject(`this source is ${source.status} - nothing was created`);
    }

    const spec = intakeProvider(source.kind, source.provider);
    const signatureFailure = verifyIntakeSignature({
      scheme: spec?.signature ?? "none",
      secret: source.signingSecret,
      url: req.url,
      headers: req.headers,
      body: req.payload,
      rawBody: req.rawBody,
    });
    if (signatureFailure) return reject(signatureFailure);

    const honeypot = source.config.honeypotField;
    if (honeypot) {
      const value = req.payload[honeypot];
      if (typeof value === "string" && value.trim() !== "") {
        return reject("honeypot field was filled - this submission looks automated");
      }
    }

    if (!isOriginAllowed(req.origin, source.config.allowedOrigins)) {
      return reject(`origin ${req.origin} is not on this source's allowed list`);
    }

    // The channel-specific screens need the parsed payload, so they run on a
    // normalisation the caller then repeats. That second pass is pure and
    // costs microseconds; sharing it would mean returning two different shapes
    // from this function, which is the sort of thing that gets misread later.
    const normalized = normalizeIntake(source.kind, source.provider, req.payload, source.config);

    if (source.kind === "email" && isBlockedSender(normalized.email, source.config.blockedSenders)) {
      return reject(`${normalized.email} is on this source's blocked-sender list`);
    }

    if (
      source.kind === "telephony" &&
      source.config.inboundOnly !== false &&
      !isInboundCall(normalized.direction, source.provider)
    ) {
      return reject(`${normalized.direction} is an outbound call, not an enquiry`);
    }

    return null;
  }

  // ── ledger ──────────────────────────────────────────────────────────────

  /**
   * Claim this arrival, or discover somebody already did.
   *
   * Written with the placeholder outcome `rejected`/"processing" and updated to
   * the real one before the transaction commits, so a row that says `rejected`
   * with that reason can only exist if the process died mid-write - which is
   * itself the honest description of what happened.
   */
  private async claim(
    client: IngestClient,
    source: ResolvedSource,
    normalized: NormalizedIntake,
    req: IntakeRequest,
  ): Promise<string | null> {
    const {
      rows: [row],
    } = await client.query<{ id: string }>(
      `INSERT INTO lead_intake_events
         (org_id, source_id, channel, external_id, payload, outcome, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'rejected', 'processing')
       ON CONFLICT (source_id, external_id) WHERE external_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        source.orgId,
        source.id,
        source.kind,
        normalized.externalId,
        JSON.stringify(boundPayload(req.payload)),
      ],
    );
    return row?.id ?? null;
  }

  /** Record a terminal outcome that needs no lead write, on a given transaction. */
  private async recordOn(
    client: IngestClient,
    source: ResolvedSource,
    req: IntakeRequest,
    outcome: IntakeOutcome,
    reason: string,
  ): Promise<IntakeResult> {
    const {
      rows: [row],
    } = await client.query<{ id: string }>(
      // NO external_id on a rejection or an error. A rejected payload re-sent
      // after the tenant fixes their mapping must be processed, not swallowed
      // as a duplicate of its own failure - which is exactly what claiming the
      // id here would cause.
      `INSERT INTO lead_intake_events
         (org_id, source_id, channel, external_id, payload, outcome, reason, processed_at)
       VALUES ($1, $2, $3, NULL, $4::jsonb, $5, $6, now())
       RETURNING id`,
      [
        source.orgId,
        source.id,
        source.kind,
        JSON.stringify(boundPayload(req.payload)),
        outcome,
        reason.slice(0, 1000),
      ],
    );
    await this.bumpSource(client, source.id, outcome === "error" ? reason : null);
    return { outcome, reason, eventId: row?.id ?? null, leadId: null };
  }

  /** The same, on a fresh transaction, for when the caller's has rolled back. */
  private async record(
    source: ResolvedSource,
    req: IntakeRequest,
    outcome: IntakeOutcome,
    reason: string,
  ): Promise<IntakeResult> {
    try {
      return await this.db.withOrg(source.orgId, (client) =>
        this.recordOn(client, source, req, outcome, reason),
      );
    } catch (err) {
      // The ledger itself failed. Nothing left to write it to, so log and give
      // the provider a 2xx anyway - a retry storm on top of a database problem
      // helps nobody.
      console.error("lead intake: could not record event:", err);
      return { outcome, reason, eventId: null, leadId: null };
    }
  }

  private async bumpSource(client: IngestClient, sourceId: string, error: string | null): Promise<void> {
    await client.query(
      `UPDATE lead_sources
          SET event_count   = event_count + 1,
              last_event_at = now(),
              error_count   = error_count + CASE WHEN $2::text IS NULL THEN 0 ELSE 1 END,
              last_error    = COALESCE($2, last_error),
              last_error_at = CASE WHEN $2::text IS NULL THEN last_error_at ELSE now() END
        WHERE id = $1`,
      [sourceId, error?.slice(0, 500) ?? null],
    );
  }

  // ── attribution ─────────────────────────────────────────────────────────

  /**
   * The campaign this lead belongs to.
   *
   * A source configured with one wins outright - the tenant said so. Failing
   * that, UTM parameters are turned into a real `marketing_sources` row, which
   * is what makes "which of the four ads" answerable without anybody creating
   * campaigns by hand before the traffic arrives.
   *
   * Nothing is invented from thin air: with neither a configured source nor a
   * UTM, the lead simply has no campaign.
   */
  private async resolveMarketingSource(
    client: IngestClient,
    source: ResolvedSource,
    normalized: NormalizedIntake,
  ): Promise<string | null> {
    if (source.marketingSourceId) return source.marketingSourceId;
    const name = normalized.utm.campaign ?? normalized.utm.source;
    if (!name) return null;

    const {
      rows: [row],
    } = await client.query<{ id: string }>(
      `INSERT INTO marketing_sources (org_id, name, channel, utm_source, utm_medium, utm_campaign)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, lower(btrim(name)))
       DO UPDATE SET
         -- Fill in what we learn later without ever overwriting what a person
         -- typed: the console's own campaign editor is the authority here.
         channel      = COALESCE(marketing_sources.channel, EXCLUDED.channel),
         utm_source   = COALESCE(marketing_sources.utm_source, EXCLUDED.utm_source),
         utm_medium   = COALESCE(marketing_sources.utm_medium, EXCLUDED.utm_medium),
         utm_campaign = COALESCE(marketing_sources.utm_campaign, EXCLUDED.utm_campaign)
       RETURNING id`,
      [
        source.orgId,
        name.slice(0, 200),
        normalized.utm.source ?? source.kind,
        normalized.utm.source,
        normalized.utm.medium,
        normalized.utm.campaign,
      ],
    );
    return row?.id ?? null;
  }

  /**
   * A source pinned to a project names it explicitly, which `labelProject`
   * treats as a human decision the detector may never overwrite. That is the
   * intent: "every lead from this landing page is for LexDraft" is knowledge a
   * person has, not a guess.
   */
  private async resolveProjectKey(client: IngestClient, source: ResolvedSource): Promise<string | null> {
    if (!source.projectId) return null;
    const {
      rows: [row],
    } = await client.query<{ key: string }>(`SELECT key FROM crm_projects WHERE id = $1`, [
      source.projectId,
    ]);
    return row?.key ?? null;
  }

  /**
   * The channel's own details, kept where the drawer already renders facts.
   *
   * A recording URL is STORED, never fetched: pulling audio from a vendor into
   * this platform's own storage is a retention and consent decision the tenant
   * has not made, and the link works for anyone who has access to the vendor.
   */
  private leadFacts(source: ResolvedSource, normalized: NormalizedIntake): Record<string, unknown> {
    const facts: Record<string, unknown> = { ...normalized.facts, intake_channel: source.kind };
    if (normalized.recipient) facts.intake_recipient = normalized.recipient;
    if (normalized.direction) facts.call_direction = normalized.direction;
    if (normalized.recordingUrl) facts.recording_url = normalized.recordingUrl;
    if (normalized.occurredAt) facts.occurred_at = normalized.occurredAt;
    for (const [key, value] of Object.entries(normalized.utm)) {
      if (value) facts[`utm_${key}`] = value;
    }
    return facts;
  }
}
