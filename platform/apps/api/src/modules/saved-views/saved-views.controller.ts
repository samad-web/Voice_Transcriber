import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
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
import { SavedViewInput, SavedViewList, SavedViewPatch } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { assertMembers } from "../../common/org-references";
import { actorUserId } from "../../common/soft-delete";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const VIEW_COLUMNS = `id, list_key AS list, name, query, position, created_at, updated_at`;

/** A person keeps at most this many views per list - a tab row, not a filing cabinet. */
const MAX_VIEWS_PER_LIST = 30;

/**
 * Saved views (migration 0108) - a person's named filters for one list.
 *
 * ── WHY NO PERMISSION GRANT ─────────────────────────────────────────────────
 *
 * A view is a query string with a name. It holds no rows, and opening one
 * re-runs the list endpoint as the viewer, where the permission grid and the
 * record scope apply as they would to the same filter typed by hand. Gating
 * the NAME on `contact:view` would add a second place for "can Priya see
 * contacts" to be answered, which is how the two answers drift.
 *
 * ── WHOSE VIEWS ─────────────────────────────────────────────────────────────
 *
 * RLS narrows `saved_views` to the org; every statement here adds
 * `user_id = <caller>`, because the connection knows the org and not the
 * person. Somebody else's view id therefore 404s exactly like a missing one.
 * A caller with no resolvable user (the bare admin key) has no "own": reads
 * are empty and writes are refused, rather than filing views under nobody.
 */
@Controller("saved-views")
@UseGuards(AdminKeyGuard, TenantGuard)
export class SavedViewsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string, @Query("list") list: unknown, @Req() req: PrincipalRequest) {
    const parsed = SavedViewList.safeParse(list);
    if (!parsed.success) throw new BadRequestException("list: expected one of " + SavedViewList.options.join(", "));
    const userId = actorUserId(req);
    if (!userId) return { views: [] };

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${VIEW_COLUMNS} FROM saved_views
          WHERE org_id = $1 AND user_id = $2 AND list_key = $3
          ORDER BY position, created_at`,
        [orgId, userId, parsed.data],
      );
      return { views: rows };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = SavedViewInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const userId = this.requireUser(req);
    const { list, name, query } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // `users` has no RLS and the FK ignores it anyway (org-references.ts):
      // without this a view could be filed under a user of another org.
      await assertMembers(client, orgId, { userId });

      const {
        rows: [count],
      } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM saved_views WHERE org_id = $1 AND user_id = $2 AND list_key = $3`,
        [orgId, userId, list],
      );
      if (count.n >= MAX_VIEWS_PER_LIST) {
        throw new BadRequestException(`you already have ${MAX_VIEWS_PER_LIST} views on this list - delete one first`);
      }

      try {
        const {
          rows: [view],
        } = await client.query(
          `INSERT INTO saved_views (org_id, user_id, list_key, name, query, position)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING ${VIEW_COLUMNS}`,
          // New views go to the end of the tab row.
          [orgId, userId, list, name, JSON.stringify(query), count.n],
        );
        return { view };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictException(`you already have a view named "${name}" here`);
        throw err;
      }
    });
  }

  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = SavedViewPatch.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const userId = this.requireUser(req);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [view],
        } = await client.query(
          `UPDATE saved_views SET
             name     = COALESCE($4, name),
             query    = COALESCE($5::jsonb, query),
             position = COALESCE($6, position),
             updated_at = now()
           WHERE id = $1 AND org_id = $2 AND user_id = $3
           RETURNING ${VIEW_COLUMNS}`,
          [
            id,
            orgId,
            userId,
            p.name ?? null,
            p.query === undefined ? null : JSON.stringify(p.query),
            p.position ?? null,
          ],
        );
        if (!view) throw new NotFoundException("view not found");
        return { view };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictException(`you already have a view named "${p.name}" here`);
        throw err;
      }
    });
  }

  /**
   * A hard delete, unlike records and tags (0097): a view is a bookmark, and
   * the recycle bin is for things whose loss costs data.
   */
  @Delete(":id")
  async remove(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: PrincipalRequest) {
    const userId = this.requireUser(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM saved_views WHERE id = $1 AND org_id = $2 AND user_id = $3`,
        [id, orgId, userId],
      );
      if (!rowCount) throw new NotFoundException("view not found");
      return { deleted: true };
    });
  }

  private requireUser(req: PrincipalRequest): string {
    const userId = actorUserId(req);
    if (!userId) throw new ForbiddenException("saved views belong to a signed-in person");
    return userId;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
