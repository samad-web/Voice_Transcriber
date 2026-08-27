import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@aura/db";
import { ConversationChannel, normalizePeerAddress } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { listWasiTemplates } from "./wasi-client";

/**
 * Per-org messaging identities (migration 0056).
 *
 * On AdminKeyGuard+TenantGuard rather than CrmPermissionsGuard, the same
 * treatment pipelines / custom-field-definitions / roles get and for the same
 * reason permissions.ts states: this is org CONFIGURATION, not a record, and
 * PermissionObjectType has no value for it.
 */
const ChannelInput = z.object({
  channel: ConversationChannel,
  provider: z.string().min(1).max(60).default("evolution"),
  inboundAddress: z.string().min(3).max(320),
  displayName: z.string().max(200).optional(),
  apiKey: z.string().max(500).optional(),
  apiBaseUrl: z.string().url().max(500).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  workspaceId: z.string().uuid().optional(),
});

const ChannelPatch = z
  .object({
    displayName: z.string().max(200).nullable().optional(),
    apiKey: z.string().max(500).optional(),
    apiBaseUrl: z.string().url().max(500).nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    /**
     * Wasi's per-WABA hub-forward secret (0061) — entered here once, by hand,
     * after an admin configures "CRM Inbound Forwarding" on that client's
     * Wasi page and it's shown to them. No self-serve retrieval on Wasi's
     * side, so there is no "fetch it for me" path here either.
     */
    forwardSecret: z.string().max(500).optional(),
    /** Burns the current webhook URL and issues a new one. */
    rotateToken: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });

/**
 * Columns safe to return.
 *
 * `api_key` is absent by construction rather than deleted afterwards — a
 * SELECT * with a delete-the-secret step downstream is one refactor away from
 * leaking it. The webhook token IS returned: it is the setup value an admin
 * has to paste into the provider, and it is already scoped to their own org.
 */
const CHANNEL_COLUMNS = `id, workspace_id, channel, provider, inbound_address, display_name,
  api_base_url, config, status, webhook_token, last_inbound_at, created_at, updated_at`;

@Controller("messaging/channels")
@UseGuards(AdminKeyGuard, TenantGuard)
export class MessagingChannelsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${CHANNEL_COLUMNS} FROM messaging_channels
          WHERE org_id = $1 ORDER BY created_at DESC`,
        [orgId],
      );
      return { channels: rows.map(withWebhookPath) };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = ChannelInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    const inboundAddress = normalizePeerAddress(input.channel, input.inboundAddress);
    if (!inboundAddress) throw new BadRequestException("inboundAddress is not usable");

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [created],
        } = await client.query(
          `INSERT INTO messaging_channels
             (org_id, workspace_id, channel, provider, inbound_address, display_name,
              api_key, api_base_url, config, webhook_token)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           RETURNING ${CHANNEL_COLUMNS}`,
          [
            orgId,
            input.workspaceId ?? null,
            input.channel,
            input.provider,
            inboundAddress,
            input.displayName ?? null,
            encryptSecret(input.apiKey ?? null),
            input.apiBaseUrl ?? null,
            JSON.stringify(input.config),
            newWebhookToken(),
          ],
        );
        return withWebhookPath(created);
      } catch (err) {
        // 23505 = unique_violation. The address is UNIQUE platform-wide, so
        // this fires when ANOTHER tenant already claimed the number — which is
        // why the message says nothing about who. Confirming that a number is
        // registered elsewhere is itself a disclosure.
        if (isUniqueViolation(err)) {
          throw new ConflictException("that address is already registered");
        }
        throw err;
      }
    });
  }

  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ChannelPatch.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace("$?", `$${params.length}`));
    };

    if (patch.displayName !== undefined) set("display_name = $?", patch.displayName);
    if (patch.apiKey !== undefined) set("api_key = $?", encryptSecret(patch.apiKey));
    if (patch.apiBaseUrl !== undefined) set("api_base_url = $?", patch.apiBaseUrl);
    if (patch.config !== undefined) set("config = $?::jsonb", JSON.stringify(patch.config));
    if (patch.status !== undefined) set("status = $?", patch.status);
    if (patch.forwardSecret !== undefined) set("forward_secret = $?", encryptSecret(patch.forwardSecret));
    if (patch.rotateToken) set("webhook_token = $?", newWebhookToken());

    if (sets.length === 0) throw new BadRequestException("nothing to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE messaging_channels SET ${sets.join(", ")}
          WHERE id = $1 RETURNING ${CHANNEL_COLUMNS}`,
        params,
      );
      if (!updated) throw new NotFoundException("channel not found");
      return withWebhookPath(updated);
    });
  }

  /**
   * Thin proxy to Wasi's `GET /api/v1/templates`, for the composer's template
   * picker — not gated on CrmPermissionsGuard because reading which templates
   * exist is org configuration, the same tier the rest of this controller is
   * on. Only meaningful for a `provider = 'wasi'` channel.
   */
  @Get(":id/templates")
  async templates(@OrgId() orgId: string, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [channel],
      } = await client.query<{ provider: string; api_key: string | null; api_base_url: string | null; config: { wasiClientId?: string } }>(
        `SELECT provider, api_key, api_base_url, config FROM messaging_channels WHERE id = $1`,
        [id],
      );
      if (!channel) throw new NotFoundException("channel not found");
      if (channel.provider !== "wasi" || !channel.api_key || !channel.api_base_url || !channel.config?.wasiClientId) {
        throw new BadRequestException("this channel is not a configured Wasi channel");
      }
      const templates = await listWasiTemplates({
        apiBaseUrl: channel.api_base_url,
        apiKey: decryptSecret(channel.api_key) ?? "",
        wasiClientId: channel.config.wasiClientId,
      });
      return { templates };
    });
  }
}

/**
 * 32 bytes of CSPRNG, base64url.
 *
 * Never derived from the org id, the number, or a timestamp: the token is the
 * only credential on an unguarded route, so anything that makes it predictable
 * makes that route open.
 */
function newWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The path an admin pastes into the provider. Returned as a PATH, not an
 * absolute URL, because the API's public origin differs per environment and a
 * hard-coded host here would send production webhooks at staging.
 */
function withWebhookPath<T extends { webhook_token?: unknown }>(row: T): T & { webhook_path: string } {
  return { ...row, webhook_path: `/v1/messaging/webhook/${String(row.webhook_token ?? "")}` };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
