import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

const CreateWorkspaceBody = z.object({
  name: z.string().min(1).max(120),
});

/** Workspaces (§2 tenancy): the org-scoped container calls + devices belong to. */
@Controller("workspaces")
@UseGuards(AdminKeyGuard)
export class WorkspacesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, created_at FROM workspaces ORDER BY created_at DESC`,
      );
      return { workspaces: rows };
    });
  }

  @Post()
  async create(@Headers("x-org-id") orgHeader: string | undefined, @Body() body: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
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
      // orgId flows to a text target_id column as a SEPARATE param ($3) — never
      // reuse the uuid $1 for a text column (Postgres 42P08 inconsistent types).
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'workspace.create', 'workspace', $2)`,
        [orgId, workspace.id],
      );
      return workspace;
    });
  }
}
