import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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

// Platform_admin is reserved for internal staff — tenant self-service is limited
// to these four roles (design doc §3.4).
const Role = z.enum(["org_admin", "workspace_admin", "workspace_member", "viewer"]);

const CreateMemberBody = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).optional(),
  role: Role,
  workspaceId: z.string().uuid().optional(),
  recordingsListen: z.boolean().optional(),
  recordingsExport: z.boolean().optional(),
});

const UpdateMemberBody = z.object({
  role: Role.optional(),
  recordingsListen: z.boolean().optional(),
  recordingsExport: z.boolean().optional(),
});

/** Members (§3.4): users + their org/workspace membership, roles, and the two
 * orthogonal privacy-weight permissions (recordings_listen / recordings_export). */
@Controller("members")
@UseGuards(AdminKeyGuard)
export class MembersController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      // memberships is RLS-scoped to the org; users is a global platform table.
      const { rows } = await client.query(
        `SELECT u.id AS "userId", u.email, u.name, m.role,
                m.recordings_listen AS "recordingsListen",
                m.recordings_export AS "recordingsExport",
                m.scope_type AS "scopeType", m.scope_id AS "scopeId"
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          ORDER BY u.email`,
      );
      return { members: rows };
    });
  }

  @Post()
  async create(@Headers("x-org-id") orgHeader: string | undefined, @Body() body: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = CreateMemberBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { email, name, role, workspaceId, recordingsListen, recordingsExport } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      if (workspaceId) {
        const ws = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
        if (ws.rowCount === 0) throw new NotFoundException("workspace not found in this org");
      }

      // Users are global; upsert by their unique email.
      const {
        rows: [user],
      } = await client.query(
        `INSERT INTO users (email, name)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
         RETURNING id, email, name`,
        [email, name ?? null],
      );

      const scopeType = workspaceId ? "workspace" : "org";
      // scope_id is a uuid column; keep it a distinct param from org_id.
      const scopeId = workspaceId ?? orgId;

      const {
        rows: [membership],
      } = await client.query(
        `INSERT INTO memberships
           (org_id, user_id, scope_type, scope_id, role, recordings_listen, recordings_export)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET
           role = EXCLUDED.role,
           recordings_listen = EXCLUDED.recordings_listen,
           recordings_export = EXCLUDED.recordings_export
         RETURNING id, scope_type AS "scopeType", scope_id AS "scopeId", role,
                   recordings_listen AS "recordingsListen",
                   recordings_export AS "recordingsExport"`,
        [orgId, user.id, scopeType, scopeId, role, recordingsListen ?? false, recordingsExport ?? false],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'member.create', 'user', $2)`,
        [orgId, user.id],
      );

      return { userId: user.id, email: user.email, name: user.name, ...membership };
    });
  }

  @Patch(":userId")
  async update(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: unknown,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = UpdateMemberBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `UPDATE memberships SET
           role = COALESCE($2, role),
           recordings_listen = COALESCE($3, recordings_listen),
           recordings_export = COALESCE($4, recordings_export)
         WHERE user_id = $1
         RETURNING id, user_id AS "userId", scope_type AS "scopeType", scope_id AS "scopeId",
                   role, recordings_listen AS "recordingsListen",
                   recordings_export AS "recordingsExport"`,
        [userId, p.role ?? null, p.recordingsListen ?? null, p.recordingsExport ?? null],
      );
      if (rows.length === 0) throw new NotFoundException("member not found in this org");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', 'dev-admin', 'member.update', 'user', $2, $3::jsonb)`,
        [orgId, userId, JSON.stringify(p)],
      );
      return { memberships: rows };
    });
  }

  @Delete(":userId")
  async remove(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("userId", ParseUUIDPipe) userId: string,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      // RLS scopes this DELETE to the current org; the global user row is left intact.
      const res = await client.query("DELETE FROM memberships WHERE user_id = $1", [userId]);
      if ((res.rowCount ?? 0) === 0) throw new NotFoundException("member not found in this org");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'member.delete', 'user', $2)`,
        [orgId, userId],
      );
      return { deleted: res.rowCount ?? 0 };
    });
  }
}
