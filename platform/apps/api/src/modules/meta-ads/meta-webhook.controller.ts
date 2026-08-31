import { createHash } from "node:crypto";
import { Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import { decryptSecret } from "@aura/db";
import { DbService } from "../../db/db.service";
import { entryStage, parsePipelineStages, statusForStage } from "@aura/shared";
import { fetchLead, mapLeadFields, verifyMetaSignature } from "./meta-client";

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{ field: string; value: { leadgen_id?: string; page_id?: string; form_id?: string } }>;
  }>;
}

/**
 * Inbound Facebook/Instagram Lead Ads webhook (Kailash gap Milestone 4).
 *
 * Unauthenticated by necessity — same class of exception as
 * messaging/webhook/:token and /webhooks/razorpay: Meta cannot present an
 * admin key, so the org is resolved from the (untrusted) page_id in the
 * payload, on the admin pool, before a signature is even checked — and then
 * verified with THAT org's own access-token-holding connection's app
 * secret... except Meta signs with the platform APP secret, not a per-page
 * one, so verification happens with META_APP_SECRET directly, same as the
 * WhatsApp Cloud API's own webhook would.
 *
 * Captures land on `contacts`/`deals` directly, NOT the legacy `leads` table
 * — see this migration's header (0063) for why.
 */
@Controller("meta/webhook")
export class MetaWebhookController {
  constructor(private readonly db: DbService) {}

  /** Meta's subscription handshake — confirms this endpoint is really us. */
  @Get()
  verify(
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") token: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
    @Res() res: Response,
  ) {
    const expected = process.env.META_VERIFY_TOKEN;
    if (mode === "subscribe" && expected && token === expected && challenge) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send("verification failed");
  }

  @Post()
  async receive(@Req() req: RawBodyRequest<Request>) {
    const rawBody = req.rawBody;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const appSecret = process.env.META_APP_SECRET;
    // Always 2xx once the signature is good or absent-by-config — Meta retries
    // aggressively on anything else, same reasoning as every other webhook
    // here. A bad signature is silently dropped, never disclosed.
    if (!rawBody || !appSecret || !verifyMetaSignature(rawBody, signature, appSecret)) {
      return { ok: true };
    }

    let body: MetaWebhookBody;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: true };
    }
    if (body.object !== "page") return { ok: true };

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen") continue;
        const { leadgen_id: leadgenId, page_id: pageId, form_id: formId } = change.value;
        if (!leadgenId || !pageId) continue;
        await this.processLead(leadgenId, pageId, formId ?? null).catch((err) => {
          console.error("meta leadgen webhook:", err instanceof Error ? err.message : err);
        });
      }
    }
    return { ok: true };
  }

  private async processLead(leadgenId: string, pageId: string, formId: string | null): Promise<void> {
    const admin = this.db.adminPool();
    const {
      rows: [connection],
    } = await admin.query<{ org_id: string; access_token: string | null }>(
      `SELECT org_id, access_token FROM meta_connections WHERE page_id = $1 AND status = 'connected'`,
      [pageId],
    );
    if (!connection) return; // unknown/disconnected Page — nothing to attach this to

    const pageToken = decryptSecret(connection.access_token);
    if (!pageToken) return;

    await this.db.withOrg(connection.org_id, async (client) => {
      // Idempotent claim, same shape as every other webhook ledger: a second
      // delivery for a leadgen_id already here is a no-op.
      const claim = await client.query(
        `INSERT INTO meta_leadgen_events (org_id, leadgen_id, page_id, form_id, raw)
         VALUES ($1, $2, $3, $4, '{}'::jsonb)
         ON CONFLICT (leadgen_id) DO NOTHING
         RETURNING id`,
        [connection.org_id, leadgenId, pageId, formId],
      );
      if (claim.rows.length === 0) return;

      const lead = await fetchLead(leadgenId, pageToken);
      const { fullName, email, phone } = mapLeadFields(lead.field_data);
      const displayName = fullName || email || phone || "Facebook lead";

      const digits = phone ? phone.replace(/\D+/gu, "") : "";
      const phoneHash = digits ? createHash("sha256").update(digits).digest("hex") : null;
      const phonePrefix = digits ? digits.slice(0, 5) || null : null;
      const phoneLast3 = digits.length >= 3 ? digits.slice(-3) : null;

      // find-or-create the one marketing source every Meta capture attributes to.
      const {
        rows: [source],
      } = await client.query<{ id: string }>(
        `INSERT INTO marketing_sources (org_id, name, channel)
         VALUES ($1, 'Meta Lead Ads', 'meta_ads')
         ON CONFLICT (org_id, lower(btrim(name))) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [connection.org_id],
      );

      // FIND-OR-CREATE, not a bare INSERT.
      //
      // This used to be an unguarded `INSERT INTO contacts`, and `contacts`
      // carries TWO partial unique indexes — `contacts_org_phone` and
      // `contacts_org_email` (0035_accounts_and_contacts.sql). So a lead from
      // somebody the tenant already knows raised 23505; `withOrg` is a real
      // transaction, so the ROLLBACK also destroyed the `meta_leadgen_events`
      // claim taken above; the throw was swallowed by the caller's .catch and
      // the handler still answered `{ ok: true }`. Meta saw a 200, never
      // redelivered, and the lead was gone silently and permanently — and the
      // better a customer they already were, the more certain the loss.
      //
      // Two lookups rather than one ON CONFLICT because a single conflict
      // target cannot cover two indexes. Same order the CSV importer uses
      // (import.controller.ts): phone first, then email.
      let contact: { id: string } | undefined;
      if (phoneHash) {
        ({
          rows: [contact],
        } = await client.query<{ id: string }>(
          `SELECT id FROM contacts WHERE org_id = $1 AND phone_hash = $2 AND status <> 'merged'`,
          [connection.org_id, phoneHash],
        ));
      }
      if (!contact && email) {
        ({
          rows: [contact],
        } = await client.query<{ id: string }>(
          `SELECT id FROM contacts WHERE org_id = $1 AND lower(email) = $2 AND status <> 'merged'`,
          [connection.org_id, email.toLowerCase()],
        ));
      }

      if (contact) {
        // Attribute the returning person to this campaign without overwriting
        // anything a human curated. COALESCE only fills blanks — an existing
        // marketing source is the FIRST touch that won them, and a later ad
        // click must not rewrite that history.
        await client.query(
          `UPDATE contacts
              SET email               = COALESCE(email, $2),
                  phone_hash          = COALESCE(phone_hash, $3),
                  phone_prefix        = COALESCE(phone_prefix, $4),
                  phone_last3         = COALESCE(phone_last3, $5),
                  marketing_source_id = COALESCE(marketing_source_id, $6),
                  last_activity_at    = now()
            WHERE id = $1`,
          [contact.id, email, phoneHash, phonePrefix, phoneLast3, source.id],
        );
      } else {
        ({
          rows: [contact],
        } = await client.query<{ id: string }>(
          `INSERT INTO contacts (org_id, display_name, email, phone_hash, phone_prefix, phone_last3, marketing_source_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [connection.org_id, displayName, email, phoneHash, phonePrefix, phoneLast3, source.id],
        ));
      }

      const {
        rows: [pipeline],
      } = await client.query<{ id: string; stages: unknown }>(`SELECT id, stages FROM deal_pipelines WHERE is_default = true LIMIT 1`);
      let dealId: string | null = null;
      if (pipeline) {
        const stages = parsePipelineStages(pipeline.stages);
        const stage = entryStage(stages);
        const status = statusForStage(stages, stage);
        const {
          rows: [deal],
        } = await client.query<{ id: string }>(
          `INSERT INTO deals (org_id, pipeline_id, contact_id, name, stage, status, marketing_source_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [connection.org_id, pipeline.id, contact.id, `${displayName} — Facebook lead`, stage, status, source.id],
        );
        dealId = deal.id;
      }

      await client.query(
        `UPDATE meta_leadgen_events SET raw = $2::jsonb, contact_id = $3, deal_id = $4 WHERE id = $1`,
        [claim.rows[0].id, JSON.stringify(lead), contact.id, dealId],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'system', 'meta-webhook', 'contact.create_from_leadgen', 'contact', $2)`,
        [connection.org_id, contact.id],
      );
    });
  }
}
