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

      const phoneHash = phone ? createHash("sha256").update(phone.replace(/\D+/gu, "")).digest("hex") : null;

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

      const {
        rows: [contact],
      } = await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, display_name, email, phone_hash, phone_prefix, phone_last3, marketing_source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          connection.org_id,
          displayName,
          email,
          phoneHash,
          phone ? phone.replace(/\D+/gu, "").slice(0, 5) || null : null,
          phone && phone.replace(/\D+/gu, "").length >= 3 ? phone.replace(/\D+/gu, "").slice(-3) : null,
          source.id,
        ],
      );

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
