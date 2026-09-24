import type { AuditActor } from "../../common/audit-actor";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { RoleInput, RolePermissionGrant } from "@aura/shared";
import { DbService } from "../../db/db.service";

export const ROLE_COLUMNS = `id, key, name, description, is_system, status, created_at, updated_at`;

export interface RoleUpdate {
  name?: string;
  description?: string | null;
  status?: "active" | "archived";
}

/**
 * The role -> object -> action grid (migration 0039), shared by the two
 * consoles that edit it.
 *
 * ── WHY A SERVICE AND NOT TWO CONTROLLERS ───────────────────────────────────
 *
 * `/v1/roles` is the operator's surface and `/v1/owner/roles` is the client's,
 * and they must do the same thing: the same refusals, the same audit entries,
 * the same delete-then-insert for a grid. `OwnerAccountsService` was extracted
 * for exactly this reason on the login path, with the note "never fork a second
 * copy" - the failure it prevents is a rule tightened in one console and not
 * the other, which reads as a permissions bug months later and is really two
 * implementations that were never the same.
 *
 * What is NOT shared is the guard tier, and that is the whole point of two
 * controllers. `/roles` is gated by `OrgRoleGuard`, which reads
 * `memberships.role` - and every owner-console request arrives on the platform
 * admin key, which `admin-key.guard.ts` mints as `platform_admin`. So
 * `OrgRoleGuard` passes for a telecaller exactly as it does for an owner, and
 * exposing `/roles` to the client console would let anybody with a login edit
 * the permission grid. The owner-facing controller mounts `OwnerRoleGuard`
 * instead, which resolves the persona from `memberships` itself.
 */
@Injectable()
export class RolesService {
  constructor(private readonly db: DbService) {}

  async list(orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      // The grants ride along as an aggregate rather than as a second query
      // per role. The page renders a matrix - every role's every checkbox at
      // once - so fetching them one role at a time would be one Mumbai->Seoul
      // round trip per role to draw a single screen.
      const { rows } = await client.query(
        `SELECT r.id, r.key, r.name, r.description, r.is_system, r.status,
                r.created_at, r.updated_at,
                COALESCE(
                  (SELECT jsonb_agg(jsonb_build_object(
                            'objectType', rp.object_type,
                            'action', rp.action,
                            'scope', rp.scope,
                            'fieldRestrictions', rp.field_restrictions)
                          ORDER BY rp.object_type, rp.action)
                     FROM role_permissions rp WHERE rp.role_id = r.id),
                  '[]'::jsonb) AS grants,
                (SELECT count(DISTINCT m.user_id)::int FROM memberships m
                  WHERE m.org_id = r.org_id
                    AND (m.role_id = r.id OR (m.role_id IS NULL AND m.role = r.key))
                ) AS member_count
           FROM roles r
          ORDER BY r.is_system DESC, r.key ASC`,
      );
      return { roles: rows };
    });
  }

  async create(orgId: string, input: RoleInput, actor: AuditActor) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query(`SELECT 1 FROM roles WHERE org_id = $1 AND key = $2`, [
        orgId,
        input.key,
      ]);
      if (existing) throw new BadRequestException(`role "${input.key}" already exists`);

      const {
        rows: [role],
      } = await client.query(
        `INSERT INTO roles (org_id, key, name, description, is_system)
         VALUES ($1, $2, $3, $4, false)
         RETURNING ${ROLE_COLUMNS}`,
        [orgId, input.key, input.name, input.description ?? null],
      );
      await this.audit(client, orgId, "role.create", role.id, actor);
      return { role };
    });
  }

  /** Name/description/status only. A system role's key/is_system are fixed -
   *  other code (the createTenant seed, memberships.role_id's backfill) assumes
   *  the 5 seeded rows exist per org with those exact keys. */
  async update(orgId: string, id: string, patch: RoleUpdate, actor: AuditActor) {
    if (Object.keys(patch).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query(`SELECT is_system FROM roles WHERE id = $1`, [id]);
      if (!existing) throw new NotFoundException("role not found");
      if (existing.is_system) {
        throw new BadRequestException("system roles cannot be renamed, described or archived");
      }

      const {
        rows: [role],
      } = await client.query(
        `UPDATE roles SET
           name        = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           status      = COALESCE($5, status)
         WHERE id = $1
         RETURNING ${ROLE_COLUMNS}`,
        [
          id,
          patch.name ?? null,
          patch.description !== undefined,
          patch.description ?? null,
          patch.status ?? null,
        ],
      );
      await this.audit(client, orgId, "role.update", id, actor);
      return { role };
    });
  }

  async permissions(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [role],
      } = await client.query(`SELECT id FROM roles WHERE id = $1`, [id]);
      if (!role) throw new NotFoundException("role not found");

      const { rows } = await client.query(
        `SELECT object_type, action, scope, field_restrictions
           FROM role_permissions WHERE role_id = $1
          ORDER BY object_type, action`,
        [id],
      );
      return { grants: rows };
    });
  }

  /**
   * Replace the full grant set for a role in one call - a permission grid is
   * edited as a whole (every checkbox state submitted together), not one cell
   * at a time, so delete-then-insert is simpler and no less correct than
   * diffing.
   */
  async replacePermissions(
    orgId: string,
    id: string,
    grants: RolePermissionGrant[],
    actor: AuditActor,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [role],
      } = await client.query(`SELECT id FROM roles WHERE id = $1`, [id]);
      if (!role) throw new NotFoundException("role not found");

      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
      for (const grant of grants) {
        await client.query(
          `INSERT INTO role_permissions (org_id, role_id, object_type, action, scope, field_restrictions)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            orgId,
            id,
            grant.objectType,
            grant.action,
            grant.scope,
            JSON.stringify(grant.fieldRestrictions),
          ],
        );
      }
      await this.audit(client, orgId, "role.permissions_update", id, actor);

      const { rows } = await client.query(
        `SELECT object_type, action, scope, field_restrictions
           FROM role_permissions WHERE role_id = $1
          ORDER BY object_type, action`,
        [id],
      );
      return { grants: rows };
    });
  }

  /**
   * Delete a custom role.
   *
   * Three refusals, and only the first is obvious. A SYSTEM role is refused
   * because the seeded five are assumed to exist per org by the tenant seed and
   * by 0039's own `role_id` backfill. A role somebody HOLDS is refused because
   * `memberships.role_id` is `ON DELETE SET NULL` - the delete would succeed,
   * silently drop those people back to the legacy `role`-string fallback, and
   * hand them whatever the seeded grants for `workspace_member` happen to be.
   * That is a permission change disguised as a tidy-up, and it should be an
   * explicit reassignment instead.
   */
  async remove(orgId: string, id: string, actor: AuditActor) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [role],
      } = await client.query<{ is_system: boolean; key: string }>(
        `SELECT is_system, key FROM roles WHERE id = $1`,
        [id],
      );
      if (!role) throw new NotFoundException("role not found");
      if (role.is_system) throw new BadRequestException("system roles cannot be deleted");

      const {
        rows: [held],
      } = await client.query<{ members: number }>(
        `SELECT count(DISTINCT user_id)::int AS members
           FROM memberships WHERE org_id = $1 AND role_id = $2`,
        [orgId, id],
      );
      if ((held?.members ?? 0) > 0) {
        throw new BadRequestException(
          `${held.members} member(s) still hold this role - move them to another one first`,
        );
      }

      await client.query(`DELETE FROM roles WHERE id = $1`, [id]);
      await this.audit(client, orgId, "role.delete", id, actor);
      return { deleted: true };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    actor: AuditActor,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'role', $4)`,
      [orgId, actor.id, action, targetId, actor.type],
    );
  }
}
