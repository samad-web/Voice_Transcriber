import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";

const CreateWorkspaceBody = z.object({
  name: z.string().min(1).max(120),
});

/** Workspaces (§2 tenancy): the org-scoped container calls + devices belong to. */
@Controller("workspaces")
@UseGuards(AdminKeyGuard, TenantGuard)
export class WorkspacesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, created_at FROM workspaces ORDER BY created_at DESC`,
      );
      return { workspaces: rows };
    });
  }

  @Post()
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateWorkspaceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [workspace],
      } = await client.query(
        `INSERT INTO workspaces (org_id, name)
         VALUES ($1, $2)
         RETURNING id, name, created_at`,
        [orgId, name],
      );
      // orgId flows to a text target_id column as a SEPARATE param ($3) - never
      // reuse the uuid $1 for a text column (Postgres 42P08 inconsistent types).
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, $4, $2, 'workspace.create', 'workspace', $3)`,
        [orgId, auditActor(req).id, workspace.id, auditActor(req).type],
      );
      return workspace;
    });
  }
}
