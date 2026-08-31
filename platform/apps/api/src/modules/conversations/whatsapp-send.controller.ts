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

const SendBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("template"), template: z.string().min(1), params: z.record(z.string(), z.string()).default({}) }),
  z.object({ type: z.literal("text"), body: z.string().min(1).max(4096) }),
]);

/**
 * Send one WhatsApp message into one conversation, through Wasi.
 *
 * Mirrors outbound-mail.controller.ts's gate chain exactly — see that file's
 * header for the full "why a human, why capped, why no automated caller"
 * reasoning, which applies here unchanged. The one structural difference:
 * email's "connection" is a person's own mailbox (`connected_accounts`,
 * scoped by user_id); WhatsApp's is the ORG's shared number
 * (`messaging_channels`), because a WABA belongs to the business, not to
 * whichever rep happens to be replying. Any signed-in rep with `conversation:edit`
 * may send from it — the daily cap is what keeps a mistake small, not a
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
        "sending WhatsApp needs a signed-in user — this caller has no seat of its own",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      // A rep scoped to `owned` conversations may only send into their own —
      // same predicate ConversationsController applies on view/update.
      const scoped = scopeClause("conversation", recordScope, 2);
      const {
        rows: [convo],
      } = await client.query<{
        id: string;
        peer_address: string;
        messaging_channel_id: string | null;
      }>(
        `SELECT id, peer_address, messaging_channel_id FROM conversations
          WHERE id = $1 AND channel = 'whatsapp' ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [conversationId, recordScope.userId] : [conversationId],
      );
      if (!convo) throw new NotFoundException("conversation not found");
      if (!convo.messaging_channel_id) {
        throw new BadRequestException("this conversation has no WhatsApp channel attached");
      }

      const {
        rows: [channel],
      } = await client.query<{
        id: string;
        provider: string;
        status: string;
        api_key: string | null;
        api_base_url: string | null;
        config: { wasiClientId?: string };
      }>(
        `SELECT id, provider, status, api_key, api_base_url, config
           FROM messaging_channels WHERE id = $1`,
        [convo.messaging_channel_id],
      );
      if (!channel || channel.provider !== "wasi" || channel.status !== "active") {
        throw new BadRequestException("this org's WhatsApp channel is not configured or not active");
      }
      if (!channel.api_key || !channel.api_base_url || !channel.config?.wasiClientId) {
        throw new BadRequestException("this org's WhatsApp channel is missing its Wasi credentials");
      }

      const {
        rows: [org],
      } = await client.query<{ plan_id: string | null }>(`SELECT plan_id FROM organizations WHERE id = $1`, [orgId]);
      if (!orgPlanIncludesWhatsapp(org?.plan_id ?? null)) {
        throw new ForbiddenException("WhatsApp is not included on this org's plan");
      }

      // Counted from what was actually sent, not a separate counter — same
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
          `this org has already sent ${limit} WhatsApp messages today — the daily cap is there to keep a mistake small`,
        );
      }

      let result;
      try {
        result = await sendWasiMessage(
          {
            apiBaseUrl: channel.api_base_url,
            apiKey: decryptSecret(channel.api_key) ?? "",
            wasiClientId: channel.config.wasiClientId,
          },
          message.type === "template"
            ? { type: "template", to: convo.peer_address, template: message.template, params: message.params }
            : { type: "text", to: convo.peer_address, body: message.body },
        );
      } catch (err) {
        if (err instanceof WasiSendError) {
          throw new BadRequestException(`Wasi refused the send: ${err.message}`);
        }
        throw err;
      }

      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO conversation_messages
           (org_id, conversation_id, direction, channel, status, from_address, to_address,
            body, provider, external_id, sent_by_user_id, occurred_at)
         VALUES ($1, $2, 'outgoing', 'whatsapp', $3, $4, $5, $6, 'wasi', $7, $8, now())
         RETURNING id, status, occurred_at`,
        [
          orgId,
          conversationId,
          mapWasiStatus(result.status),
          null,
          convo.peer_address,
          message.type === "template" ? `[template: ${message.template}]` : message.body,
          result.metaMessageId,
          userId.data,
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
