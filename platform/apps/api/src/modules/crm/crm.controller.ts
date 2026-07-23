import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

const WebhookIntegrationBody = z.object({
  workspaceId: z.string().uuid(),
  webhookUrl: z.string().url(),
  provider: z.string().min(1).max(60).default("generic_webhook"),
  // 'header' sends `<authHeader>: <authSecret>`; 'bearer' sends Authorization.
  authType: z.enum(["none", "bearer", "header"]).default("none"),
  authHeader: z.string().min(1).max(120).default("X-API-Key"),
  authSecret: z.string().min(1).max(500).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  // destination key -> dotted source path, e.g. {"customerName":"facts.customer_name"}
  fieldMap: z.record(z.string(), z.string()).default({}),
  maxAttempts: z.number().int().min(1).max(20).default(6),
  rateLimitPerMin: z.number().int().min(1).max(6000).default(60),
});

// Every field optional — this is a partial update of an existing integration.
const UpdateIntegrationBody = z.object({
  webhookUrl: z.string().url().optional(),
  authType: z.enum(["none", "bearer", "header"]).optional(),
  authHeader: z.string().min(1).max(120).optional(),
  authSecret: z.string().min(1).max(500).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  fieldMap: z.record(z.string(), z.string()).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  rateLimitPerMin: z.number().int().min(1).max(6000).optional(),
  status: z.enum(["connected", "disconnected", "error"]).optional(),
});

/** Never return auth_secret — only whether one is set. */
const SAFE_COLUMNS = `id, workspace_id, provider, endpoint, auth_type, auth_header,
  (auth_secret IS NOT NULL) AS has_auth_secret, headers, field_map,
  max_attempts, rate_limit_per_min, status, created_at, updated_at`;

/**
 * CRM config (§2.3): generic webhook connector first — every completed call
 * POSTs its summary + extracted facts to the tenant's URL. HubSpot OAuth is
 * the Phase-1 named connector, still TODO.
 */
@Controller("crm/integrations")
@UseGuards(AdminKeyGuard)
export class CrmController {
  constructor(private readonly db: DbService) {}

  @Post()
  async create(@Headers("x-org-id") orgHeader: string | undefined, @Body() body: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = WebhookIntegrationBody.safeParse(body);
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
           (org_id, workspace_id, provider, auth, endpoint, auth_type, auth_header,
            auth_secret, headers, field_map, max_attempts, rate_limit_per_min, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, 'connected')
         RETURNING ${SAFE_COLUMNS}`,
        // TODO (§2.5 pattern): envelope-encrypt auth blobs before GA.
        [
          orgId,
          cfg.workspaceId,
          cfg.provider,
          // Kept in step with `endpoint` so an older reader still resolves a URL.
          JSON.stringify({ url: cfg.webhookUrl }),
          cfg.webhookUrl,
          cfg.authType,
          cfg.authHeader,
          cfg.authSecret ?? null,
          JSON.stringify(cfg.headers),
          JSON.stringify(cfg.fieldMap),
          cfg.maxAttempts,
          cfg.rateLimitPerMin,
        ],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'crm.connect', 'crm_integration', $2)`,
        [orgId, integration.id],
      );
      return integration;
    });
  }

  @Get()
  async list(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${SAFE_COLUMNS},
                (SELECT count(*)::int FROM crm_sync_log l
                  WHERE l.integration_id = crm_integrations.id AND l.status = 'pending') AS queued,
                (SELECT count(*)::int FROM crm_sync_log l
                  WHERE l.integration_id = crm_integrations.id AND l.status = 'dead') AS dead
           FROM crm_integrations
          ORDER BY created_at DESC`,
      );
      return { integrations: rows };
    });
  }

  /**
   * Partial update of an integration: endpoint, auth, headers, mapping, retry
   * budget or status. Only the supplied keys change — COALESCE leaves the rest
   * alone, so rotating a secret can't accidentally clear the field map.
   */
  @Patch(":id")
  async updateIntegration(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = UpdateIntegrationBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [integration],
      } = await client.query(
        `UPDATE crm_integrations SET
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
            updated_at         = now()
          WHERE id = $1
          RETURNING ${SAFE_COLUMNS}`,
        [
          id,
          p.webhookUrl ?? null,
          p.authType ?? null,
          p.authHeader ?? null,
          p.authSecret ?? null,
          p.headers ? JSON.stringify(p.headers) : null,
          p.fieldMap ? JSON.stringify(p.fieldMap) : null,
          p.maxAttempts ?? null,
          p.rateLimitPerMin ?? null,
          p.status ?? null,
        ],
      );
      if (!integration) throw new NotFoundException("crm integration not found in this org");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'crm.update', 'crm_integration', $2)`,
        [orgId, integration.id],
      );
      return integration;
    });
  }
}
