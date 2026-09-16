import {
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  RECYCLE_BIN,
  RECYCLE_BIN_RESOURCES,
  RECYCLE_BIN_RETENTION_DAYS,
  RecycleBinResource,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { isUniqueViolation } from "../../common/pg-errors";
import { restoreDeleted } from "../../common/soft-delete";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

interface BinRow {
  resource: RecycleBinResource;
  id: string;
  name: string | null;
  deleted_at: Date;
  deleted_by_name: string | null;
}

/**
 * The recycle bin (migration 0097).
 *
 * ── WHY OWNER AND MANAGER, NOT WHOEVER COULD DELETE IT ────────────────────
 *
 * The delete endpoints have looser gates than this: a scoped rep can remove
 * their own sales target, and tag and automation routes are org configuration
 * behind AdminKeyGuard + TenantGuard. The bin is deliberately narrower, because
 * it is a cross-object view. Listing everything an org has deleted in one place
 * shows the name of every dataset, rule and target that ever existed, including
 * ones the caller could not see while they were live. That aggregation is what
 * makes it an admin surface even though each individual delete was not.
 *
 * ── ONE UNION, BUILT FROM THE CATALOGUE ───────────────────────────────────
 *
 * Seven tables with nothing in common but the two columns 0097 added, so the
 * query is assembled from `RECYCLE_BIN` rather than written out. The table and
 * column names are literals from @aura/shared and the resource is parsed
 * against an enum before it is ever used as a key, so nothing derived from a
 * request reaches the SQL text - the ids and the limit travel as parameters.
 */
@Controller("owner/recycle-bin")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class RecycleBinController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    const limit = parsed.success ? parsed.data.limit : 100;

    // One branch per resource. `name` is cast to text because the catalogue
    // points at a different column on each table and UNION insists the types
    // line up - `sales_targets.metric` is an enum-ish text, the rest are names.
    const branches = RECYCLE_BIN_RESOURCES.map((resource) => {
      const spec = RECYCLE_BIN[resource];
      return `SELECT '${resource}'::text AS resource, t.id, t.${spec.nameColumn}::text AS name,
                     t.deleted_at, u.name AS deleted_by_name
                FROM ${spec.table} t
                LEFT JOIN users u ON u.id = t.deleted_by
               WHERE t.org_id = $1 AND t.deleted_at IS NOT NULL`;
    });

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<BinRow>(
        `${branches.join("\n UNION ALL \n")}
         ORDER BY deleted_at DESC
         LIMIT $2`,
        [orgId, limit],
      );

      return {
        retentionDays: RECYCLE_BIN_RETENTION_DAYS,
        items: rows.map((row) => ({
          resource: row.resource,
          id: row.id,
          name: row.name,
          deletedAt: row.deleted_at,
          deletedBy: row.deleted_by_name,
        })),
      };
    });
  }

  /**
   * Put one row back.
   *
   * Nothing is written to the children: they were never deleted, so the parent
   * returning is the whole restore. See the 0097 header for why that is the
   * design rather than an omission.
   *
   * A row already purged is a 404 rather than a silent success, because the one
   * thing a person must never take from this page is a false belief that their
   * data came back.
   */
  @Post(":resource/:id/restore")
  async restore(
    @OrgId() orgId: string,
    @Param("resource") resource: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = RecycleBinResource.safeParse(resource);
    if (!parsed.success) throw new NotFoundException("nothing of that kind is kept here");

    const spec = RECYCLE_BIN[parsed.data];

    return this.db.withOrg(orgId, async (client) => {
      let restored: boolean;
      try {
        restored = await restoreDeleted(client, parsed.data, id);
      } catch (err) {
        // The mirror of what makes the bin work at all. 0097 made the name
        // indexes partial on `deleted_at IS NULL` so a deleted tag stops
        // reserving its name - which means somebody can take that name while
        // the row sits in the bin, and then it cannot come back under it.
        //
        // A 409 saying exactly that, rather than a 500: the person can fix it
        // by renaming the live one, and nothing about the deleted row is lost
        // in the meantime. Auto-renaming the restored row instead would be
        // quicker and would hand them a "Q3 campaign (2)" they never asked for.
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `Something else is already using that ${spec.label.toLowerCase()}'s name. Rename it and try restoring again.`,
          );
        }
        throw err;
      }

      if (!restored) {
        throw new NotFoundException(
          `that ${spec.label.toLowerCase()} is not in the recycle bin - it may already have been restored, or removed for good`,
        );
      }

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'recycle_bin.restore', $3, $4)`,
        [orgId, req.principal?.userId ?? "dev-admin", parsed.data, id],
      );

      return { restored: true, resource: parsed.data, href: spec.href };
    });
  }
}
