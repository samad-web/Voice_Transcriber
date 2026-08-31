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
import { deriveProjectKey, ProjectInput, ProjectPatch } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Projects - the tenant's own offerings, and which one a call was about
 * (migration 0073).
 *
 * Org CONFIGURATION, so AdminKeyGuard+TenantGuard and no CrmPermissionsGuard -
 * the same tier as marketing-sources, tags and pipelines. Deliberately NOT a
 * new PermissionObjectType: that would mean widening the shared enum and
 * seeding grants for all five system roles in the migration, to gate a
 * catalogue that is read on every board load and edited by whoever configures
 * the tenant. Attaching a project to a RECORD is where permission is enforced,
 * and that happens through the leads/deals PATCH endpoints, which already have
 * their own gates.
 *
 * ── THE COUNTS ARE READ, NEVER STORED ───────────────────────────────────
 *
 * Same call marketing-sources makes and for the same reason: a denormalised
 * lead counter here would be wrong the first time a lead was merged, erased or
 * relabelled, and a wrong number on a page somebody uses to decide where to
 * spend next quarter is worse than no number.
 */
@Controller("projects")
@UseGuards(AdminKeyGuard, TenantGuard)
export class ProjectsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT p.id, p.key, p.name, p.description, p.color, p.aliases, p.active,
                p.sort_order, p.created_at, p.updated_at,
                (SELECT count(*) FROM leads l WHERE l.project_id = p.id)::int
                  AS lead_count,
                (SELECT count(*) FROM leads l
                  WHERE l.project_id = p.id AND l.status = 'open')::int
                  AS open_count,
                -- Won value only, never pipeline value. Mixing a forecast into
                -- a return is how a project looks successful on deals that
                -- never closed.
                COALESCE((SELECT sum(l.value_num) FROM leads l
                           WHERE l.project_id = p.id AND l.status = 'won'), 0)::text
                  AS won_value,
                (SELECT count(*) FROM call_projects cp WHERE cp.project_id = p.id)::int
                  AS call_count
           FROM crm_projects p
          WHERE p.org_id = $1
          ORDER BY p.active DESC, p.sort_order, lower(p.name)`,
        [orgId],
      );
      return { projects: rows };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = ProjectInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    const key = p.key ?? deriveProjectKey(p.name);

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [project],
        } = await client.query(
          `INSERT INTO crm_projects
             (org_id, name, key, description, color, aliases, sort_order)
           VALUES ($1, btrim($2), $3, $4, $5, $6::text[], COALESCE($7, 0))
           RETURNING id, key, name, description, color, aliases, active, sort_order, created_at`,
          [
            orgId,
            p.name,
            key,
            p.description ?? null,
            p.color ?? null,
            normalizeAliases(p.aliases),
            p.sortOrder ?? null,
          ],
        );
        return { project };
      } catch (err) {
        throw conflictFor(err, p.name, key);
      }
    });
  }

  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ProjectPatch.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown, cast = ""): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };

    if (p.name !== undefined) set("name", p.name);
    if (p.key !== undefined) set("key", p.key);
    if (p.description !== undefined) set("description", p.description);
    if (p.color !== undefined) set("color", p.color);
    if (p.aliases !== undefined) set("aliases", normalizeAliases(p.aliases), "::text[]");
    if (p.sortOrder !== undefined) set("sort_order", p.sortOrder);
    if (p.active !== undefined) set("active", p.active);

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [project],
        } = await client.query(
          `UPDATE crm_projects SET ${sets.join(", ")} WHERE id = $1
           RETURNING id, key, name, description, color, aliases, active, sort_order, updated_at`,
          params,
        );
        if (!project) throw new NotFoundException("project not found");
        return { project };
      } catch (err) {
        if (err instanceof NotFoundException) throw err;
        throw conflictFor(err, p.name ?? "", p.key ?? "");
      }
    });
  }
}

/**
 * Blank and duplicate aliases are dropped rather than rejected. A tenant
 * clearing one row of an alias editor has expressed an intent the UI can
 * satisfy exactly; failing the whole save over an empty string would be
 * pedantry. `detectProjects` already ignores them, so this only keeps the
 * stored row tidy.
 */
function normalizeAliases(aliases: string[] | undefined): string[] {
  if (!aliases) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim();
    if (!alias) continue;
    const dedupeKey = alias.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(alias);
  }
  return out;
}

/**
 * Name and key have separate unique indexes, and telling the two apart matters:
 * "3D Website" and "3d Website" collide on the NAME, while a renamed project
 * whose derived key already exists collides on the KEY and needs a different
 * fix from the person seeing the message.
 */
function conflictFor(err: unknown, name: string, key: string): unknown {
  if (typeof err !== "object" || err === null) return err;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== "23505") return err;
  if (e.constraint === "crm_projects_org_key_unique") {
    return new ConflictException(`a project with the key "${key}" already exists`);
  }
  return new ConflictException(`a project named "${name}" already exists`);
}
