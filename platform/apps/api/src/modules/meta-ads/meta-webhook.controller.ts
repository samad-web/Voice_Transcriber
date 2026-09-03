import { Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import { decryptSecret } from "@aura/db";
import { DbService } from "../../db/db.service";
import { LeadIntakeService } from "../lead-intake/lead-intake.service";
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
 * Unauthenticated by necessity - same class of exception as
 * messaging/webhook/:token and /webhooks/razorpay: Meta cannot present an
 * admin key, so the org is resolved from the (untrusted) page_id in the
 * payload, on the admin pool, before a signature is even checked - and then
 * verified with THAT org's own access-token-holding connection's app
 * secret... except Meta signs with the platform APP secret, not a per-page
 * one, so verification happens with META_APP_SECRET directly, same as the
 * WhatsApp Cloud API's own webhook would.
 *
 * ── WHERE CAPTURES LAND, AND THE BUG THAT CHANGED IT ───────────────────
 *
 * They used to land on `contacts`/`deals` only - 0063's header argued `leads`
 * was too call-centric to hold an ad lead. The consequence went unnoticed for
 * as long as the feature existed: `/owner/board` and `/owner/leads` READ
 * `leads`, so every Meta lead ever captured was invisible on the two pages an
 * owner actually works in, while handset-call leads showed up fine. 0074's MCP
 * pull was built to work around exactly this and only covered the pull path.
 *
 * Since migration 0078 this writes through `LeadIntakeService` - the same
 * service the web form, the telephony webhook and the email relay use - which
 * creates the lead, the contact AND the deal, records the arrival in the intake
 * ledger, and stamps `source_channel = 'meta_ads'` so the board can say where
 * the card came from. The special-case SQL that used to live here is gone.
 */
@Controller("meta/webhook")
export class MetaWebhookController {
  constructor(
    private readonly db: DbService,
    private readonly intake: LeadIntakeService,
  ) {}

  /** Meta's subscription handshake - confirms this endpoint is really us. */
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
    // Always 2xx once the signature is good or absent-by-config - Meta retries
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
    if (!connection) return; // unknown/disconnected Page - nothing to attach this to

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

      // Flattened for the intake normaliser, which reads a field map rather
      // than Meta's `[{name, values[]}]` wire shape. The form, campaign and ad
      // names ride along so project detection has something to recognise -
      // a lead from the "3D Website - Showroom" form should land on the 3D
      // Website project without anybody wiring that up by hand.
      const payload: Record<string, unknown> = {
        leadgen_id: leadgenId,
        page_id: pageId,
        form_id: formId,
        full_name: fullName,
        email,
        phone_number: phone,
        campaign_name: lead.campaign_name ?? null,
        adset_name: lead.adset_name ?? null,
        ad_name: lead.ad_name ?? null,
        created_time: lead.created_time ?? null,
      };
      const answers: string[] = [];
      for (const field of lead.field_data ?? []) {
        // Answers to the form's own custom questions, which are often where
        // the actual enquiry is. Prefixed keys cannot collide with the
        // normalised ones above.
        const value = field.values?.[0];
        if (value === undefined || value === null) continue;
        payload[`answer_${field.name}`] = String(value);
        // The three Meta already gives us as normalised fields would otherwise
        // be repeated back as the enquiry text.
        if (!["full_name", "email", "phone_number", "name", "phone"].includes(field.name)) {
          answers.push(`${field.name.replace(/_/gu, " ")}: ${String(value)}`);
        }
      }
      // What the person actually said, for the card and for project detection.
      // Assembled here rather than mapped, because an answer is keyed by the
      // form author's own question wording and no static field map can reach it.
      payload.notes = [lead.campaign_name, lead.ad_name, ...answers]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join("\n");

      // The source row every Meta capture for this org attributes to. Created
      // on first use so it appears in the console's lead-source list beside the
      // tenant's web form, where they can pin a project or an owner to it.
      const source = await this.intake.ensureManagedSource(
        client,
        connection.org_id,
        "meta_ads",
        "Facebook Lead Ads",
        "meta",
      );

      const result = await this.intake.ingestOnClient(client, source, {
        payload,
        headers: {},
        // No signature to re-verify here: Meta's own X-Hub-Signature-256 was
        // already checked over the raw webhook body in `receive`, and this
        // payload is one we assembled, not one that arrived.
        url: "",
        origin: null,
      });

      await client.query(
        `UPDATE meta_leadgen_events SET raw = $2::jsonb, contact_id = $3, deal_id = $4 WHERE id = $1`,
        [claim.rows[0].id, JSON.stringify(lead), result.contactId ?? null, result.dealId ?? null],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'system', 'meta-webhook', 'lead.create_from_leadgen', 'lead', $2)`,
        [connection.org_id, result.leadId],
      );
    });
  }
}
