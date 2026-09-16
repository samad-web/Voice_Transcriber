import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { decryptSecret } from "@aura/db";
import { orgPlanIncludesWhatsapp } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { sendWasiMessage, WasiSendError } from "./wasi-client";
import { MetaSendError, sendMetaDirect, sendWhatsAppCloud } from "./meta-send";
import { replyWindow } from "./meta-messaging";

const SendBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("template"),
    template: z.string().min(1),
    /**
     * The language the template was APPROVED in. Part of its identity to Meta -
     * the same name in two languages is two templates - so it travels with the
     * send. Optional, defaulting to `en`, which is what message_templates
     * defaults to as well.
     */
    language: z.string().min(2).max(10).optional(),
    params: z.record(z.string(), z.string()).default({}),
  }),
  z.object({ type: z.literal("text"), body: z.string().min(1).max(4096) }),
]);

/**
 * Send one WhatsApp message into one conversation, through Wasi.
 *
 * Mirrors outbound-mail.controller.ts's gate chain exactly - see that file's
 * header for the full "why a human, why capped, why no automated caller"
 * reasoning, which applies here unchanged. The one structural difference:
 * email's "connection" is a person's own mailbox (`connected_accounts`,
 * scoped by user_id); WhatsApp's is the ORG's shared number
 * (`messaging_channels`), because a WABA belongs to the business, not to
 * whichever rep happens to be replying. Any signed-in rep with `conversation:edit`
 * may send from it - the daily cap is what keeps a mistake small, not a
 * per-person restriction.
 *
 * NOTHING AUTOMATED CALLS THIS. Same rule 3 as email.
 */
@Controller("conversations")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class WhatsAppSendController {
  constructor(private readonly db: DbService) {}

  @Post(":id/messages")
  @RequireCrmPermission("conversation", "edit")
  async send(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) conversationId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    if (process.env.WHATSAPP_SENDING_ENABLED !== "true") {
      throw new ServiceUnavailableException(
        "outbound WhatsApp is switched off on this deployment (WHATSAPP_SENDING_ENABLED)",
      );
    }

    const parsed = SendBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const message = parsed.data;

    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success) {
      throw new ForbiddenException(
        "sending WhatsApp needs a signed-in user - this caller has no seat of its own",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      // A rep scoped to `owned` conversations may only send into their own -
      // same predicate ConversationsController applies on view/update.
      const scoped = scopeClause("conversation", recordScope, 2);
      const {
        rows: [convo],
      } = await client.query<{
        id: string;
        peer_address: string;
        messaging_channel_id: string | null;
        channel: "whatsapp" | "instagram" | "facebook";
        last_inbound_at: Date | null;
      }>(
        // Four channels now, not one (0098). Instagram and Messenger reach the
        // same inbox and the same reply box, and the gate chain above - human
        // caller, permission, record scope, daily cap - is identical for all of
        // them. What differs is only which API carries the message.
        `SELECT id, peer_address, messaging_channel_id, channel, last_inbound_at
           FROM conversations
          WHERE id = $1 AND channel IN ('whatsapp', 'instagram', 'facebook')
            ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [conversationId, recordScope.userId] : [conversationId],
      );
      if (!convo) throw new NotFoundException("conversation not found");
      if (!convo.messaging_channel_id) {
        throw new BadRequestException("this conversation has no messaging channel attached");
      }

      /*
       * ── did this person ask us to stop? (migration 0100) ───────────────
       *
       * FIRST, before the plan check, the cap and the credentials. Every gate
       * below this one is about whether WE are allowed to send; this one is
       * about whether THEY agreed to receive, and that answer does not become
       * less true because the org is within its daily cap.
       *
       * Only `certain` blocks. A `probable` is recorded and notified and
       * deliberately does not stop a human from replying - very often the
       * right response to "leave me alone" is a person saying something,
       * and a machine that decided otherwise would be making the call that
       * belongs to them.
       */
      const {
        rows: [optOut],
      } = await client.query<{ created_at: Date }>(
        `SELECT created_at FROM messaging_opt_outs
          WHERE org_id = $1 AND channel = 'whatsapp' AND peer_address = $2
            AND level = 'certain' AND released_at IS NULL`,
        [orgId, convo.peer_address],
      );
      if (optOut) {
        // 403, not 400: the request is well-formed and the caller is
        // authenticated - they are simply not permitted to message this
        // person. The message says who can undo it, because a flat refusal
        // with no exit is how somebody ends up editing the database.
        throw new ForbiddenException(
          "this person asked to stop being messaged, so nothing can be sent to them. " +
            "If they have since said otherwise, an owner or manager can release the opt-out on the thread.",
        );
      }

      const {
        rows: [channel],
      } = await client.query<{
        id: string;
        provider: string;
        status: string;
        api_key: string | null;
        api_base_url: string | null;
        config: {
          wasiClientId?: string;
          phoneNumberId?: string;
          pageId?: string;
          igUserId?: string;
        };
      }>(
        `SELECT id, provider, status, api_key, api_base_url, config
           FROM messaging_channels WHERE id = $1`,
        [convo.messaging_channel_id],
      );
      if (!channel || channel.status !== "active") {
        throw new BadRequestException("this org's messaging channel is not configured or not active");
      }
      const isMeta = channel.provider === "waba" || channel.provider === "meta";
      if (!isMeta && channel.provider !== "wasi") {
        throw new BadRequestException(`sending through ${channel.provider} is not supported`);
      }
      if (!isMeta && (!channel.api_key || !channel.api_base_url || !channel.config?.wasiClientId)) {
        throw new BadRequestException("this org's WhatsApp channel is missing its Wasi credentials");
      }

      // ── The 24-hour window ────────────────────────────────────────────────
      //
      // Meta refuses a free-form message more than 24 hours after the
      // customer's last one; WhatsApp then needs an approved template and
      // Instagram/Messenger need a permitted tag, which Aura does not send
      // (see meta-send.ts). Checked HERE rather than left to Meta because its
      // own refusal arrives after the message is composed and reads as a
      // failure rather than as a rule - and because a rep who is told first
      // can pick a template instead of retyping.
      if (isMeta) {
        const window = replyWindow(convo.last_inbound_at);
        if (!window.open && message.type !== "template") {
          throw new BadRequestException(
            convo.channel === "whatsapp"
              ? "more than 24 hours have passed since they last replied - send an approved template instead"
              : "more than 24 hours have passed since they last replied, so Meta will not deliver this",
          );
        }
        if (convo.channel !== "whatsapp" && message.type === "template") {
          throw new BadRequestException("templates are a WhatsApp feature - send a plain reply");
        }
      }

      const {
        rows: [org],
      } = await client.query<{ plan_id: string | null }>(`SELECT plan_id FROM organizations WHERE id = $1`, [orgId]);
      if (!orgPlanIncludesWhatsapp(org?.plan_id ?? null)) {
        throw new ForbiddenException("WhatsApp is not included on this org's plan");
      }

      // Counted from what was actually sent, not a separate counter - same
      // "cannot drift" reasoning as email's cap.
      const {
        rows: [sent],
      } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM conversation_messages
          WHERE org_id = $1 AND channel = 'whatsapp' AND direction = 'outgoing'
            AND created_at > now() - interval '1 day'`,
        [orgId],
      );
      const limit = dailyWhatsappLimit();
      if (Number(sent?.n ?? 0) >= limit) {
        throw new BadRequestException(
          `this org has already sent ${limit} WhatsApp messages today - the daily cap is there to keep a mistake small`,
        );
      }

      // ── One send, three transports ────────────────────────────────────────
      //
      // The result is normalised to `{ externalId, status }` here rather than
      // downstream, so the INSERT below is written once. `status` is what the
      // provider said at the moment of acceptance; the webhook corrects it to
      // delivered/read later, which is why it is stored rather than assumed.
      let outcome: { externalId: string | null; status: string };
      try {
        if (isMeta && convo.channel === "whatsapp") {
          const senderId = channel.config.phoneNumberId;
          if (!senderId || !channel.api_key) {
            throw new BadRequestException(
              "this WhatsApp channel is missing its Cloud API phone number or token",
            );
          }
          const out = await sendWhatsAppCloud(
            { accessToken: decryptSecret(channel.api_key) ?? "", senderId },
            message.type === "template"
              ? {
                  type: "template",
                  to: convo.peer_address,
                  template: message.template,
                  // The language a template was approved IN is part of its
                  // identity to Meta - the same name in two languages is two
                  // templates - so it travels with the send rather than being
                  // assumed. `en` matches message_templates' own default.
                  language: message.language ?? "en",
                  // Positional, in {{1}}, {{2}} order. The body arrives as a
                  // map because that is what a form produces; Meta wants a
                  // sequence, and sorting numerically here is what stops
                  // "{{10}}" landing between "{{1}}" and "{{2}}".
                  params: Object.entries(message.params)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([, value]) => value),
                }
              : { type: "text", to: convo.peer_address, body: message.body },
          );
          outcome = { externalId: out.externalId, status: "sent" };
        } else if (isMeta) {
          const senderId = channel.config.pageId ?? channel.config.igUserId;
          if (!senderId || !channel.api_key) {
            throw new BadRequestException("this channel is missing its Meta page id or token");
          }
          if (message.type === "template") {
            throw new BadRequestException("templates are a WhatsApp feature");
          }
          const out = await sendMetaDirect(
            { accessToken: decryptSecret(channel.api_key) ?? "", senderId },
            convo.peer_address,
            message.body,
          );
          outcome = { externalId: out.externalId, status: "sent" };
        } else {
          const result = await sendWasiMessage(
            {
              apiBaseUrl: channel.api_base_url ?? "",
              apiKey: decryptSecret(channel.api_key) ?? "",
              wasiClientId: channel.config.wasiClientId ?? "",
            },
            message.type === "template"
              ? { type: "template", to: convo.peer_address, template: message.template, params: message.params }
              : { type: "text", to: convo.peer_address, body: message.body },
          );
          outcome = { externalId: result.metaMessageId, status: mapWasiStatus(result.status) };
        }
      } catch (err) {
        if (err instanceof WasiSendError) {
          throw new BadRequestException(`Wasi refused the send: ${err.message}`);
        }
        // Meta's own words - "more than 24 hours have passed since the customer
        // last replied", "Template name does not exist in the translation" -
        // are what a person can act on. See meta-send.ts.
        if (err instanceof MetaSendError) {
          throw new BadRequestException(`Meta refused the send: ${err.message}`);
        }
        throw err;
      }

      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO conversation_messages
           (org_id, conversation_id, direction, channel, status, from_address, to_address,
            body, provider, external_id, sent_by_user_id, occurred_at)
         VALUES ($1, $2, 'outgoing', $9, $3, $4, $5, $6, $10, $7, $8, now())
         RETURNING id, status, occurred_at`,
        [
          orgId,
          conversationId,
          outcome.status,
          null,
          convo.peer_address,
          message.type === "template" ? `[template: ${message.template}]` : message.body,
          outcome.externalId,
          userId.data,
          convo.channel,
          channel.provider,
        ],
      );
      await client.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'conversation.whatsapp_send', 'conversation', $3)`,
        [orgId, req.principal?.userId ?? "dev-admin", conversationId],
      );

      return { sent: true, message: row };
    });
  }
}

function dailyWhatsappLimit(): number {
  const raw = Number(process.env.WHATSAPP_SEND_DAILY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

function mapWasiStatus(status: string): "queued" | "sent" | "delivered" | "read" | "failed" {
  return (["queued", "sent", "delivered", "read", "failed"] as const).includes(status as any)
    ? (status as any)
    : "sent";
}
