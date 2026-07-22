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
});

const UpdateFieldMapBody = z.object({
  fieldMap: z.record(z.string(), z.unknown()),
});

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
    const { workspaceId, webhookUrl } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const ws = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
      if (ws.rowCount === 0) throw new NotFoundException("workspace not found in this org");
      const {
        rows: [integration],
      } = await client.query(
        `INSERT INTO crm_integrations (org_id, workspace_id, provider, auth, status)
         VALUES ($1, $2, 'generic_webhook', $3, 'connected')
         RETURNING id, provider, status, created_at`,
        // TODO (§2.5 pattern): envelope-encrypt auth blobs before GA.
        [orgId, workspaceId, JSON.stringify({ url: webhookUrl })],
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
        `SELECT id, workspace_id, provider, field_map, status, created_at FROM crm_integrations
          ORDER BY created_at DESC`,
      );
      return { integrations: rows };
    });
  }

  /**
   * Update the field mapping for an integration (which extracted call fact maps
   * to which CRM property). NOTE: HubSpot named-connector OAuth is still a stub —
   * a real connect flow needs live HubSpot client credentials, so only the
   * generic_webhook provider is wired end-to-end today.
   */
  @Patch(":id")
  async updateFieldMap(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = UpdateFieldMapBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [integration],
      } = await client.query(
        // $2 is a jsonb param, kept distinct from the uuid $1.
        `UPDATE crm_integrations SET field_map = $2::jsonb
          WHERE id = $1
          RETURNING id, workspace_id, provider, field_map, status, updated_at`,
        [id, JSON.stringify(parsed.data.fieldMap)],
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
