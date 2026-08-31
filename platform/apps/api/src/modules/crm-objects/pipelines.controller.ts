import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { DEFAULT_PIPELINE_STAGES, PipelineStages } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const CreatePipelineBody = z.object({
  name: z.string().min(1).max(120),
  stages: PipelineStages.optional(),
  isDefault: z.boolean().default(false),
});

const UpdatePipelineBody = z.object({
  name: z.string().min(1).max(120).optional(),
  stages: PipelineStages.optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const PIPELINE_COLUMNS = `id, name, object_type, stages, is_default, status, created_at, updated_at`;

/**
 * Deal pipelines (CRM Phase 1, E0.1) — multiple stage lists per org, the
 * multi-pipeline generalisation of organizations.lead_stages (0010). `stages`
 * is validated against PipelineStages (packages/shared), never a DB CHECK,
 * for the same reason lead_stages isn't one: renaming a board column must
 * not be a migration.
 *
 * Strangler-fig (see the Phase 1 plan): organizations.lead_stages and
 * owner/leads.controller.ts are untouched by this module.
 */
@Controller("pipelines")
@UseGuards(AdminKeyGuard, TenantGuard)
export class PipelinesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${PIPELINE_COLUMNS} FROM deal_pipelines ORDER BY is_default DESC, created_at ASC`,
      );
      return { pipelines: rows };
    });
  }

  @Get(":id")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [pipeline],
      } = await client.query(`SELECT ${PIPELINE_COLUMNS} FROM deal_pipelines WHERE id = $1`, [id]);
      if (!pipeline) throw new NotFoundException("pipeline not found");
      return { pipeline };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreatePipelineBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // Exactly one default per org is an app-enforced invariant (0034's
      // header) — clear any existing default before this one claims it.
      if (p.isDefault) {
        await client.query(`UPDATE deal_pipelines SET is_default = false WHERE is_default = true`);
      }
      const {
        rows: [pipeline],
      } = await client.query(
        `INSERT INTO deal_pipelines (org_id, name, stages, is_default)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING ${PIPELINE_COLUMNS}`,
        [orgId, p.name, JSON.stringify(p.stages ?? DEFAULT_PIPELINE_STAGES), p.isDefault],
      );
      await this.audit(client, orgId, "pipeline.create", pipeline.id, req);
      return { pipeline };
    });
  }

  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdatePipelineBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      if (p.isDefault) {
        await client.query(
          `UPDATE deal_pipelines SET is_default = false WHERE is_default = true AND id <> $1`,
          [id],
        );
      }
      const {
        rows: [pipeline],
      } = await client.query(
        `UPDATE deal_pipelines SET
           name       = COALESCE($2, name),
           stages     = COALESCE($3::jsonb, stages),
           is_default = COALESCE($4, is_default),
           status     = COALESCE($5, status)
         WHERE id = $1
         RETURNING ${PIPELINE_COLUMNS}`,
        [
          id,
          p.name ?? null,
          p.stages ? JSON.stringify(p.stages) : null,
          p.isDefault ?? null,
          p.status ?? null,
        ],
      );
      if (!pipeline) throw new NotFoundException("pipeline not found");
      await this.audit(client, orgId, "pipeline.update", id, req);
      return { pipeline };
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
       VALUES ($1, 'user', $2, $3, 'deal_pipeline', $4)`,
      [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
    );
  }
}
