import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  status: z.enum(["open", "dismissed", "resolved"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ResolveBody = z.object({
  status: z.enum(["dismissed", "resolved"]),
});

/**
 * The review queue apps/worker/src/pipeline/call-crm-integrity.ts writes to
 * (0070) - calls whose own AI read disagrees with the deal it produced, or
 * failed to produce.
 *
 * Gated on `deal` permissions rather than a dedicated object type, the same
 * convention reports/targets already use (there is no `PermissionObjectType`
 * value for this - see packages/shared/src/permissions.ts). Rows are NOT
 * further filtered by CrmRecordScope: a `no_deal_from_positive_call` flag has
 * no deal to check ownership against by definition, and this queue is
 * inherently a manager-level "what did the floor miss" view - narrowing it to
 * "only what I personally own" would hide exactly the flags most worth a
 * manager seeing.
 */
@Controller("call-integrity-flags")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class CallIntegrityController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("deal", "view")
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { status, limit } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.id, f.call_id, f.deal_id, f.flag_type, f.details, f.status,
                f.created_at, f.resolved_at, f.resolved_by,
                c.started_at AS call_started_at, c.remote_name AS call_remote_name,
                d.name AS deal_name
           FROM call_crm_integrity_flags f
           LEFT JOIN calls c ON c.id = f.call_id
           LEFT JOIN deals d ON d.id = f.deal_id
          WHERE f.status = $1
          ORDER BY f.created_at DESC
          LIMIT $2`,
        [status, limit],
      );
      return { flags: rows };
    });
  }

  /** Dismiss ("not actually a problem") or resolve ("fixed it") one flag. */
  @Patch(":id")
  @RequireCrmPermission("deal", "edit")
  async resolve(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ResolveBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actorId = req.principal?.userId ?? null;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `UPDATE call_crm_integrity_flags
            SET status = $2, resolved_at = now(), resolved_by = $3
          WHERE id = $1 AND status = 'open'
          RETURNING id, status, resolved_at`,
        [id, parsed.data.status, actorId],
      );
      if (rows.length === 0) {
        throw new NotFoundException("flag not found, or already resolved/dismissed");
      }
      return rows[0];
    });
  }
}
