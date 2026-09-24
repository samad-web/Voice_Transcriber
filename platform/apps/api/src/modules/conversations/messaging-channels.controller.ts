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
import {
  ConversationChannel,
  MessagingProvider,
  normalizePeerAddress,
  providerSpec,
  type ChannelProbeOutcome,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgPhoneCountry, whatsappPhone } from "../../common/console-phone";
import { assertInOrg } from "../../common/org-references";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { listWasiTemplates, probeWasiChannel } from "./wasi-client";
import { evolutionAdminFromEnv, probeEvolutionChannel } from "./evolution-client";
import { listWabaTemplates } from "./meta-send";

/** The one method of the pg client this controller's helpers need. */
type PgQuery = <R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: R[] }>;

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
  /**
   * A closed set now, and no default.
   *
   * This was `z.string().min(1).max(60).default("evolution")`, which is two
   * problems. Any string at all could be stored, so a typo'd provider produced
   * a channel that every downstream branch quietly declined to handle - it
   * could not send, its window was never computed, and its health read as
   * whatever the Wasi-shaped default happened to be. And the DEFAULT was
   * `evolution`, so a caller who omitted the field got a personal-number
   * channel, which is precisely the misrouting this change exists to end:
   * a business number must never land on the personal transport by omission.
   *
   * Required, therefore. Every caller in the tree already sends it, and a
   * missing provider is a question, not something to guess an answer to.
   */
  provider: MessagingProvider,
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
     * Wasi's per-WABA hub-forward secret (0061) - entered here once, by hand,
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
 * `api_key` is absent by construction rather than deleted afterwards - a
 * SELECT * with a delete-the-secret step downstream is one refactor away from
 * leaking it. The webhook token IS returned: it is the setup value an admin
 * has to paste into the provider, and it is already scoped to their own org.
 *
 * The two secrets are projected as BOOLEANS instead. Whether a forward secret
 * exists is the difference between a channel that receives customer replies and
 * one that silently discards them (messaging-webhook.controller.ts answers
 * `signature verification failed` and drops the delivery), so the console has
 * to know it - and a boolean answers that question without the value leaving
 * the database. It is the same rule the row above states, applied rather than
 * relaxed: the console gets the fact, never the secret.
 *
 * They feed `readChannel()` in @aura/shared, which turns these columns plus the
 * 0099 probe columns into the state the page renders. `status` alone was being
 * rendered as health and is not - it is an operator switch with two values.
 */
const CHANNEL_COLUMNS = `id, workspace_id, channel, provider, inbound_address, display_name,
  api_base_url, config, status, webhook_token, last_inbound_at, created_at, updated_at,
  last_probe_at, last_probe_outcome, last_probe_detail,
  (api_key IS NOT NULL)       AS has_api_key,
  (forward_secret IS NOT NULL) AS has_forward_secret`;

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

    // A WhatsApp number is held to the console's phone rule - valid for its
    // country - before it becomes the "+digits" address threads match on.
    // Instagram / Facebook handles are not numbers and pass through as before.
    const address =
      input.channel === "whatsapp"
        ? whatsappPhone(
            input.inboundAddress,
            "inboundAddress",
            await this.db.withOrg(orgId, (client) => orgPhoneCountry(client, orgId)),
          )
        : input.inboundAddress;
    const inboundAddress = normalizePeerAddress(input.channel, address);
    if (!inboundAddress) throw new BadRequestException("inboundAddress is not usable");

    return this.db.withOrg(orgId, async (client) => {
      // Foreign-key checks ignore RLS (doc 23, A2).
      await assertInOrg(client, orgId, { workspaceId: input.workspaceId });

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
        // this fires when ANOTHER tenant already claimed the number - which is
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
   * Try this channel's credentials against the provider, and record what came
   * back (migration 0099).
   *
   * ── WHY THIS IS A SEPARATE CALL AND NOT PART OF create ──────────────────
   *
   * It is tempting to probe on create and refuse to save a channel whose key is
   * bad. That would be wrong in a way this deployment feels hard: the API runs
   * in Mumbai against a database in Seoul, the owner is pasting five values
   * they had to fetch from another product's admin panel, and a probe failure
   * at the moment of saving throws all five away for a reason that is often
   * temporary - Wasi restarting, a network blip, or a forward secret that has
   * not been generated on the other side YET, which is the normal order of
   * operations.
   *
   * So creating stores, and proving is a button. The channel is honest about
   * being unproven until somebody presses it - "Not checked yet" - which is
   * strictly better than either lying green or losing the form.
   *
   * ── IT ALWAYS ANSWERS 200 ───────────────────────────────────────────────
   *
   * A refused key is not an error in THIS request: the request asked a question
   * and got an answer. Returning 502 would make the console's error handler
   * render "couldn't check the channel" over the top of a perfectly good
   * finding, which is the answer the owner actually needs to read.
   */
  @Post(":id/verify")
  async verify(@OrgId() orgId: string, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [channel],
      } = await client.query<{
        provider: string;
        api_key: string | null;
        api_base_url: string | null;
      }>(
        `SELECT provider, api_key, api_base_url FROM messaging_channels
          WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      if (!channel) throw new NotFoundException("channel not found");

      /*
       * ── Which probe, if any ─────────────────────────────────────────────
       *
       * This used to read `provider !== "wasi"` and record `provider_error`
       * for everything else. That was wrong in two directions at once. A
       * healthy WABA channel - a provider with no probe to run - was recorded
       * as an error, which `readChannel` classifies as "unreachable" and the
       * watchdog then raised as a standing "the provider did not answer"
       * warning about a channel with nothing wrong with it. And a personal
       * channel, which DOES have a perfectly good status endpoint, was never
       * probed at all.
       *
       * The provider table says which probe each one takes.
       */
      const probeKind = providerSpec(channel.provider)?.probe ?? "none";

      if (probeKind === "none") {
        // Not an error and not a failure - a provider we cannot ask. Recording
        // `ok` would be a lie and `provider_error` was the bug; the honest move
        // is to change nothing and say so, leaving the channel `unverified`,
        // which readChannel() renders without an action button for this case.
        //
        // Re-read rather than projecting the row we already have: that query
        // selected `api_key` to decide what to do with it, and CHANNEL_COLUMNS
        // exists precisely so a secret is absent by construction rather than
        // deleted on the way out. One extra round trip on a rare path is the
        // cheaper side of that trade.
        const {
          rows: [full],
        } = await client.query(
          `SELECT ${CHANNEL_COLUMNS} FROM messaging_channels WHERE id = $1 AND org_id = $2`,
          [id, orgId],
        );
        if (!full) throw new NotFoundException("channel not found");
        return {
          probe: { outcome: null, detail: null },
          channel: withWebhookPath(full),
          checked: false,
          reason:
            "This provider offers no way to check stored credentials without sending a message, so nothing was changed.",
        };
      }

      if (!channel.api_key) {
        return this.recordProbe(client, orgId, id, {
          outcome: "provider_error",
          detail: "This channel has no API key stored, so there is nothing to check.",
        });
      }

      if (probeKind === "evolution_status") {
        // A personal number. `api_base_url` is the Evolution host; it is
        // stored per channel rather than read from the environment so a
        // tenant moved to a different instance does not need a redeploy.
        const baseUrl = channel.api_base_url ?? evolutionAdminFromEnv()?.baseUrl;
        if (!baseUrl) {
          return this.recordProbe(client, orgId, id, {
            outcome: "provider_error",
            detail: "This deployment has no Evolution host configured, so there is nothing to check.",
          });
        }
        const probe = await probeEvolutionChannel({
          baseUrl,
          token: decryptSecret(channel.api_key) ?? "",
        });
        return this.recordProbe(client, orgId, id, probe);
      }

      if (!channel.api_base_url) {
        return this.recordProbe(client, orgId, id, {
          outcome: "provider_error",
          detail: "This channel has no host URL stored, so there is nothing to check.",
        });
      }

      const probe = await probeWasiChannel({
        apiBaseUrl: channel.api_base_url,
        apiKey: decryptSecret(channel.api_key) ?? "",
      });
      return this.recordProbe(client, orgId, id, probe);
    });
  }

  /**
   * Stores the measurement and hands back the whole row, so the console
   * re-reads readiness from the same shape `list` returns rather than patching
   * one field of its local copy and drifting.
   */
  private async recordProbe(
    client: { query: PgQuery },
    orgId: string,
    id: string,
    probe: { outcome: ChannelProbeOutcome; detail: string | null },
  ) {
    const {
      rows: [updated],
    } = await client.query(
      `UPDATE messaging_channels
          SET last_probe_at = now(), last_probe_outcome = $3, last_probe_detail = $4
        WHERE id = $1 AND org_id = $2
      RETURNING ${CHANNEL_COLUMNS}`,
      [id, orgId, probe.outcome, probe.detail],
    );
    if (!updated) throw new NotFoundException("channel not found");
    return { probe, channel: withWebhookPath(updated) };
  }

  /**
   * Thin proxy to Wasi's `GET /api/v1/templates`, for the composer's template
   * picker - not gated on CrmPermissionsGuard because reading which templates
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

  /**
   * Pull a WABA's approved templates into `message_templates` (0098).
   *
   * ── WHY THEY ARE CACHED AND NOT FETCHED PER COMPOSE ─────────────────────
   *
   * The composer needs them to RENDER - a dropdown that waits on a Graph round
   * trip, and empties when Meta is slow, makes the reply box feel broken - and
   * approval state changes underneath us. A template approved yesterday can be
   * paused by Meta today, and a send against a paused one fails with an error
   * the rep cannot interpret. Cached, the console can grey it out and say why.
   *
   * ── A PULL, NEVER A PUSH ────────────────────────────────────────────────
   *
   * Aura does not submit templates for approval. Writing copy that Meta will
   * review and attach to the tenant's business account affects the standing of
   * their number, and that belongs in Meta's own tooling where the review state
   * is authoritative rather than mirrored.
   *
   * A template that has disappeared from Meta is marked `disabled` rather than
   * deleted: calls and messages already reference the ones that were sent, and
   * a settings sync must not rewrite what was sent last month.
   */
  @Post(":id/templates/sync")
  async syncTemplates(@OrgId() orgId: string, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [channel],
      } = await client.query<{
        provider: string;
        api_key: string | null;
        config: { businessAccountId?: string };
      }>(`SELECT provider, api_key, config FROM messaging_channels WHERE id = $1`, [id]);
      if (!channel) throw new NotFoundException("channel not found");
      if (channel.provider !== "waba" || !channel.api_key || !channel.config?.businessAccountId) {
        throw new BadRequestException(
          "templates come from a WhatsApp Business API channel with a business account id",
        );
      }

      const templates = await listWabaTemplates(
        decryptSecret(channel.api_key) ?? "",
        channel.config.businessAccountId,
      );

      for (const template of templates) {
        // The body component carries the text and the {{n}} placeholders; the
        // rest (header, footer, buttons) is kept as Meta returned it so the
        // composer can render exactly what the customer will see.
        const body =
          (template.components as Array<{ type?: string; text?: string }>).find(
            (c) => c.type?.toUpperCase() === "BODY",
          )?.text ?? "";
        const variables = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]);

        await client.query(
          `INSERT INTO message_templates
             (org_id, channel_id, channel, name, language, category, status, body,
              buttons, variables, meta_template_id, synced_at)
           VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, now())
           ON CONFLICT (org_id, channel_id, name, language)
           DO UPDATE SET status = EXCLUDED.status,
                         body = EXCLUDED.body,
                         category = EXCLUDED.category,
                         buttons = EXCLUDED.buttons,
                         variables = EXCLUDED.variables,
                         meta_template_id = EXCLUDED.meta_template_id,
                         synced_at = now(),
                         updated_at = now()`,
          [
            orgId,
            id,
            template.name,
            template.language,
            template.category,
            metaStatus(template.status),
            body,
            JSON.stringify(template.components),
            JSON.stringify(variables),
            template.id,
          ],
        );
      }

      // Anything we hold that Meta no longer lists. Disabled, not deleted -
      // see the header.
      await client.query(
        `UPDATE message_templates
            SET status = 'disabled', updated_at = now()
          WHERE channel_id = $1 AND synced_at < now() - interval '1 minute'
            AND status <> 'disabled'`,
        [id],
      );

      return { synced: templates.length };
    });
  }
}

/**
 * Meta's approval vocabulary, mapped onto ours.
 *
 * Anything unrecognised becomes `disabled` rather than `approved`: a state we
 * do not understand must not be the one that lets a rep send.
 */
function metaStatus(status: string): string {
  switch (status.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "PENDING":
    case "IN_APPEAL":
    case "PENDING_DELETION":
      return "pending";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    default:
      return "disabled";
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
