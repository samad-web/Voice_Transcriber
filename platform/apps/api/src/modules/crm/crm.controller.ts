import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { encryptSecret } from "@aura/db";
import {
  CRM_AUTH_SCHEMES,
  CRM_PROVIDERS,
  CRM_SOURCE_PATHS,
  crmProvider,
  crmTarget,
  renderTemplate,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CallAccessGuard, CallContent } from "../../common/call-access.guard";
import { softDelete } from "../../common/soft-delete";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { CrmTestService } from "./crm-test.service";
import { auditActor } from "../../common/audit-actor";

/**
 * Connect a catalogue provider. The spec supplies the endpoint template, body
 * shape, method, id path and auth scheme, so the client sends only what is
 * genuinely tenant-specific: which target, the config values that complete the
 * URL, the credential, and any field-map overrides.
 */
const ConnectProviderBody = z.object({
  workspaceId: z.string().uuid(),
  provider: z.string().min(1).max(60),
  target: z.string().min(1).max(60).optional(),
  label: z.string().min(1).max(120).optional(),
  /** Non-secret per-tenant values: data centre, instance host, location id. */
  config: z.record(z.string(), z.string()).default({}),
  secret: z.string().min(1).max(4000).optional(),
  /** Overrides merged over the target's preset. Omit to take the preset as-is. */
  fieldMap: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  maxAttempts: z.number().int().min(1).max(20).default(6),
  rateLimitPerMin: z.number().int().min(1).max(6000).optional(),
  /** Send only calls the agent qualified as a lead, rather than every call. */
  onlyQualified: z.boolean().default(false),
});

/**
 * The escape hatch: a fully hand-specified connector for a CRM not in the
 * catalogue. Everything the dispatcher reads is settable here, which is what
 * keeps "my CRM isn't listed" from being a blocker.
 */
const CustomIntegrationBody = z.object({
  workspaceId: z.string().uuid(),
  provider: z.string().min(1).max(60).default("generic_webhook"),
  label: z.string().min(1).max(120).optional(),
  target: z.string().min(1).max(60).default("post"),
  webhookUrl: z.string().url(),
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  authType: z.enum(CRM_AUTH_SCHEMES as [string, ...string[]]).default("none"),
  authHeader: z.string().min(1).max(120).default("X-API-Key"),
  authPrefix: z.string().max(60).default(""),
  authSecret: z.string().min(1).max(4000).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  config: z.record(z.string(), z.string()).default({}),
  bodyTemplate: z.unknown().optional(),
  idPath: z.string().max(200).optional(),
  pairKeys: z.tuple([z.string(), z.string()]).optional(),
  fieldMap: z.record(z.string(), z.string()).default({}),
  maxAttempts: z.number().int().min(1).max(20).default(6),
  rateLimitPerMin: z.number().int().min(1).max(6000).default(60),
  /** Send only calls the agent qualified as a lead, rather than every call. */
  onlyQualified: z.boolean().default(false),
});

// Every field optional - this is a partial update of an existing integration.
const UpdateIntegrationBody = z.object({
  label: z.string().min(1).max(120).optional(),
  webhookUrl: z.string().url().optional(),
  method: z.enum(["POST", "PUT", "PATCH"]).optional(),
  authType: z.enum(CRM_AUTH_SCHEMES as [string, ...string[]]).optional(),
  authHeader: z.string().min(1).max(120).optional(),
  authPrefix: z.string().max(60).optional(),
  authSecret: z.string().min(1).max(4000).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.string()).optional(),
  bodyTemplate: z.unknown().optional(),
  idPath: z.string().max(200).optional(),
  fieldMap: z.record(z.string(), z.string()).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  rateLimitPerMin: z.number().int().min(1).max(6000).optional(),
  status: z.enum(["connected", "disconnected", "error"]).optional(),
  onlyQualified: z.boolean().optional(),
});

/**
 * Never return auth_secret - only whether one is set. `config` IS returned:
 * it holds hosts and ids the operator needs to see, which is exactly why
 * credentials must not be put there.
 */
const SAFE_COLUMNS = `id, workspace_id, provider, label, target, endpoint, method,
  auth_type, auth_header, auth_prefix,
  (auth_secret IS NOT NULL) AS has_auth_secret, headers, config, body_template,
  id_path, pair_keys, field_map, max_attempts, rate_limit_per_min, status,
  only_qualified, last_success_at, last_error, created_at, updated_at`;

/**
 * CRM configuration (§2.3).
 *
 * A connector is a row, not a code path: the catalogue in @aura/shared supplies
 * the endpoint template, body shape and auth scheme, and this controller binds
 * it to a tenant's config and credential. Adding a CRM is a catalogue entry;
 * adding an unlisted one is a POST to /custom.
 */
@Controller("crm")
@UseGuards(AdminKeyGuard, TenantGuard)
export class CrmController {
  constructor(
    private readonly db: DbService,
    private readonly tester: CrmTestService,
  ) {}

  /**
   * The catalogue the console renders its picker from. Served rather than
   * bundled separately so the form an operator fills in and the validation
   * applied to it can never describe different providers.
   */
  @Get("providers")
  providers() {
    return { providers: CRM_PROVIDERS, sourcePaths: CRM_SOURCE_PATHS };
  }

  /** Connect a catalogue provider - the normal path. */
  @Post("integrations")
  async connect(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = ConnectProviderBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const cfg = parsed.data;

    const provider = crmProvider(cfg.provider);
    if (!provider) {
      throw new BadRequestException(
        `unknown provider "${cfg.provider}" - GET /v1/crm/providers lists the catalogue, ` +
          "or POST /v1/crm/integrations/custom to specify one by hand",
      );
    }

    const target = cfg.target
      ? crmTarget(provider.id, cfg.target)
      : provider.targets[0];
    if (!target) {
      throw new BadRequestException(
        `provider "${provider.id}" has no target "${cfg.target}" - ` +
          `available: ${provider.targets.map((t) => t.id).join(", ")}`,
      );
    }

    if (provider.auth.scheme !== "none" && !cfg.secret) {
      throw new BadRequestException(`${provider.auth.secretLabel} is required for ${provider.label}`);
    }

    // Apply the spec's defaults first - a required field with a default (Zoho's
    // data centre, Salesforce's API version) is satisfied by that default, and
    // reporting it as missing would force clients to echo back a value the
    // catalogue already supplies.
    const config: Record<string, string> = {};
    for (const field of provider.config) {
      const supplied = cfg.config[field.key]?.trim();
      if (supplied) config[field.key] = supplied;
      else if (field.defaultValue) config[field.key] = field.defaultValue;
    }

    // Checked here rather than discovered as a 404 from the CRM three hours later.
    const missingConfig = provider.config
      .filter((f) => f.required && !config[f.key])
      .map((f) => f.label);
    if (missingConfig.length > 0) {
      throw new BadRequestException(
        `missing required configuration for ${provider.label}: ${missingConfig.join(", ")}`,
      );
    }

    const endpoint = renderTemplate(target.endpoint, config);
    if (endpoint.missing.length > 0) {
      throw new BadRequestException(
        `endpoint template still has unresolved values: ${endpoint.missing.join(", ")}`,
      );
    }

    const fieldMap = { ...target.fieldMap, ...(cfg.fieldMap ?? {}) };
    const headers = { ...(target.headers ?? {}), ...(cfg.headers ?? {}) };

    return this.db.withOrg(orgId, async (client) => {
      const ws = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [cfg.workspaceId]);
      if (ws.rowCount === 0) throw new NotFoundException("workspace not found in this org");

      const {
        rows: [integration],
      } = await client.query(
        `INSERT INTO crm_integrations
           (org_id, workspace_id, provider, label, target, auth, endpoint, method,
            auth_type, auth_header, auth_prefix, auth_secret, headers, config,
            body_template, id_path, pair_keys, field_map, max_attempts,
            rate_limit_per_min, status, only_qualified)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12,
                 $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18::jsonb, $19, $20, 'connected',
                 $21)
         RETURNING ${SAFE_COLUMNS}`,
        [
          orgId,
          cfg.workspaceId,
          provider.id,
          cfg.label ?? `${provider.label} - ${target.label}`,
          target.id,
          // Kept in step with `endpoint` so an older reader still resolves a URL.
          JSON.stringify({ url: target.endpoint }),
          target.endpoint,
          target.method,
          provider.auth.scheme,
          provider.auth.header ?? "X-API-Key",
          provider.auth.prefix ?? "",
          // Sealed with AES-256-GCM when CRM_SECRET_KEY is configured (§2.5).
          encryptSecret(cfg.secret ?? null),
          JSON.stringify(headers),
          JSON.stringify(config),
          target.body === undefined ? null : JSON.stringify(target.body),
          target.idPath ?? null,
          target.pairKeys ?? null,
          JSON.stringify(fieldMap),
          cfg.maxAttempts,
          cfg.rateLimitPerMin ?? provider.rateLimitPerMin,
          cfg.onlyQualified,
        ],
      );
      await this.audit(client, orgId, "crm.connect", integration.id, req);
      return integration;
    });
  }

  /** Hand-specified connector for a CRM the catalogue doesn't cover. */
  @Post("integrations/custom")
  async connectCustom(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CustomIntegrationBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const cfg = parsed.data;

    if (cfg.authType !== "none" && !cfg.authSecret) {
      throw new BadRequestException(`authSecret is required when authType is "${cfg.authType}"`);
    }

    return this.db.withOrg(orgId, async (client) => {
      const ws = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [cfg.workspaceId]);
      if (ws.rowCount === 0) throw new NotFoundException("workspace not found in this org");

      const {
        rows: [integration],
      } = await client.query(
        `INSERT INTO crm_integrations
           (org_id, workspace_id, provider, label, target, auth, endpoint, method,
            auth_type, auth_header, auth_prefix, auth_secret, headers, config,
            body_template, id_path, pair_keys, field_map, max_attempts,
            rate_limit_per_min, status, only_qualified)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12,
                 $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18::jsonb, $19, $20, 'connected',
                 $21)
         RETURNING ${SAFE_COLUMNS}`,
        [
          orgId,
          cfg.workspaceId,
          cfg.provider,
          cfg.label ?? "Custom webhook",
          cfg.target,
          JSON.stringify({ url: cfg.webhookUrl }),
          cfg.webhookUrl,
          cfg.method,
          cfg.authType,
          cfg.authHeader,
          cfg.authPrefix,
          encryptSecret(cfg.authSecret ?? null),
          JSON.stringify(cfg.headers),
          JSON.stringify(cfg.config),
          cfg.bodyTemplate === undefined ? null : JSON.stringify(cfg.bodyTemplate),
          cfg.idPath ?? null,
          cfg.pairKeys ?? null,
          JSON.stringify(cfg.fieldMap),
          cfg.maxAttempts,
          cfg.rateLimitPerMin,
          cfg.onlyQualified,
        ],
      );
      await this.audit(client, orgId, "crm.connect", integration.id, req);
      return integration;
    });
  }

  @Get("integrations")
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${SAFE_COLUMNS},
                (SELECT count(*)::int FROM crm_sync_log l
                  WHERE l.integration_id = crm_integrations.id AND l.status = 'pending') AS queued,
                (SELECT count(*)::int FROM crm_sync_log l
                  WHERE l.integration_id = crm_integrations.id AND l.status = 'dead') AS dead,
                (SELECT count(*)::int FROM crm_sync_log l
                  WHERE l.integration_id = crm_integrations.id AND l.status = 'synced') AS synced
           FROM crm_integrations
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC`,
      );
      return { integrations: rows };
    });
  }

  /**
   * Partial update: endpoint, auth, headers, config, mapping, retry budget or
   * status. Only the supplied keys change - COALESCE leaves the rest alone, so
   * rotating a secret can't accidentally clear the field map.
   */
  @Patch("integrations/:id")
  async updateIntegration(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateIntegrationBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [integration],
      } = await client.query(
        `UPDATE crm_integrations SET
            label              = COALESCE($11, label),
            endpoint           = COALESCE($2, endpoint),
            auth               = CASE WHEN $2::text IS NULL THEN auth
                                      ELSE jsonb_set(auth, '{url}', to_jsonb($2::text)) END,
            auth_type          = COALESCE($3, auth_type),
            auth_header        = COALESCE($4, auth_header),
            auth_secret        = COALESCE($5, auth_secret),
            headers            = COALESCE($6::jsonb, headers),
            field_map          = COALESCE($7::jsonb, field_map),
            max_attempts       = COALESCE($8, max_attempts),
            rate_limit_per_min = COALESCE($9, rate_limit_per_min),
            status             = COALESCE($10, status),
            method             = COALESCE($12, method),
            auth_prefix        = COALESCE($13, auth_prefix),
            config             = COALESCE($14::jsonb, config),
            body_template      = CASE WHEN $15::text IS NULL THEN body_template
                                      ELSE $15::jsonb END,
            id_path            = COALESCE($16, id_path),
            only_qualified     = COALESCE($17, only_qualified),
            -- Clear the stale failure when an operator fixes the config, so the
            -- console doesn't keep showing an error the change already resolved.
            last_error         = CASE WHEN $10 = 'connected' THEN NULL ELSE last_error END,
            updated_at         = now()
          WHERE id = $1
          RETURNING ${SAFE_COLUMNS}`,
        [
          id,
          p.webhookUrl ?? null,
          p.authType ?? null,
          p.authHeader ?? null,
          encryptSecret(p.authSecret ?? null),
          p.headers ? JSON.stringify(p.headers) : null,
          p.fieldMap ? JSON.stringify(p.fieldMap) : null,
          p.maxAttempts ?? null,
          p.rateLimitPerMin ?? null,
          p.status ?? null,
          p.label ?? null,
          p.method ?? null,
          p.authPrefix ?? null,
          p.config ? JSON.stringify(p.config) : null,
          p.bodyTemplate === undefined ? null : JSON.stringify(p.bodyTemplate),
          p.idPath ?? null,
          p.onlyQualified ?? null,
        ],
      );
      if (!integration) throw new NotFoundException("crm integration not found in this org");
      await this.audit(client, orgId, "crm.update", integration.id, req);
      return integration;
    });
  }

  @Delete("integrations/:id")
  async remove(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // Audit first, as before. The row now survives the disconnect (0097), so
      // the audit id no longer dangles - and neither does the outbox: anything
      // still queued for this connection stays in crm_sync_log instead of
      // cascading away mid-flight, and resumes if the connection is restored.
      // The outbox worker joins on `deleted_at IS NULL`, so nothing reaches a
      // disconnected endpoint in the meantime.
      await this.audit(client, orgId, "crm.disconnect", id, req);
      const removed = await softDelete(client, "crm_integration", id, req);
      if (!removed) throw new NotFoundException("crm integration not found in this org");
      return { deleted: true };
    });
  }

  /**
   * Send a probe to the configured endpoint using a real recent call when the
   * workspace has one, and a synthetic call otherwise.
   *
   * Worth its own endpoint because the alternative is finding out from a dead
   * outbox row after a customer's call has already been lost - a credential
   * typo should surface while the operator is still looking at the form.
   */
  @Post("integrations/:id/test")
  async test(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dryRun = z.object({ dryRun: z.boolean().default(false) }).safeParse(body ?? {});
    return this.tester.test(orgId, id, dryRun.success ? dryRun.data.dryRun : false);
  }

  /** Recent deliveries for one integration - the operator's debugging view. */
  @Get("integrations/:id/deliveries")
  // `crm_sync_log.request_body` is the payload the worker POSTed to the
  // tenant's own CRM, and that payload carries the transcript text, the call
  // intelligence, every extracted fact, the full remote number and a presigned
  // recording URL (crm-dispatch.ts). A debugging view over it is a transcript
  // reader wearing a different name, so it takes the same gate (0122).
  @UseGuards(AdminKeyGuard, TenantGuard, CallAccessGuard)
  @CallContent()
  async deliveries(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("status") status: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    const take = Math.min(Math.max(Number(limit) || 25, 1), 200);
    const filter = ["pending", "synced", "failed", "dead"].includes(status ?? "") ? status : null;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT l.id, l.call_id, l.status, l.attempts, l.error, l.external_id,
                l.target, l.request_url, l.request_body, l.response_status,
                l.response_body, l.next_attempt_at, l.last_attempt_at, l.updated_at,
                c.started_at, c.remote_name
           FROM crm_sync_log l
           LEFT JOIN calls c ON c.id = l.call_id
          WHERE l.integration_id = $1
            AND ($2::text IS NULL OR l.status = $2)
          ORDER BY l.updated_at DESC
          LIMIT $3`,
        [id, filter, take],
      );
      return { deliveries: rows };
    });
  }

  /**
   * Requeue a delivery. Resetting attempts is the point: a row is usually dead
   * because the config was wrong, and after fixing it the operator wants the
   * full retry budget again, not the one attempt left over from last time.
   */
  @Post("deliveries/:id/retry")
  async retry(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `UPDATE crm_sync_log
            SET status = 'pending', attempts = 0, next_attempt_at = now(),
                error = NULL, updated_at = now()
          WHERE id = $1
          RETURNING id, call_id, integration_id, status`,
        [id],
      );
      if (!row) throw new NotFoundException("delivery not found in this org");
      await this.audit(client, orgId, "crm.retry", row.integration_id, req);
      // The worker's drain picks it up on the next tick - retrying inline here
      // would put a 20s CRM timeout in the middle of an HTTP request.
      return { requeued: true, delivery: row };
    });
  }

  /** Requeue every dead delivery for an integration - the "I fixed it" button. */
  @Post("integrations/:id/retry-dead")
  async retryDead(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE crm_sync_log
            SET status = 'pending', attempts = 0, next_attempt_at = now(),
                error = NULL, updated_at = now()
          WHERE integration_id = $1 AND status = 'dead'`,
        [id],
      );
      await this.audit(client, orgId, "crm.retry_dead", id, req);
      return { requeued: rowCount ?? 0 };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    req: PrincipalRequest,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'crm_integration', $4)`,
      [orgId, auditActor(req).id, action, targetId, auditActor(req).type],
    );
  }
}
