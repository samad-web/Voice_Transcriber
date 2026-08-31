import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const CommissionMetric = z.enum(["won_value", "won_count", "calls"]);
const CommissionRateType = z.enum(["percent", "flat_per_unit"]);

const CreateCommissionPlanBody = z.object({
  name: z.string().min(1).max(120),
  workspaceId: z.string().uuid().optional(),
  metric: CommissionMetric.default("won_value"),
  rateType: CommissionRateType,
  rate: z.number().positive(),
  active: z.boolean().default(true),
});

const UpdateCommissionPlanBody = z.object({
  name: z.string().min(1).max(120).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  metric: CommissionMetric.optional(),
  rateType: CommissionRateType.optional(),
  rate: z.number().positive().optional(),
  active: z.boolean().optional(),
});

const COMMISSION_PLAN_COLUMNS = `id, workspace_id, name, metric, rate_type, rate, active,
  created_at, updated_at`;

/**
 * Commission plans (Phase 4, migration 0071) - org configuration, the same
 * tier as `PipelinesController`: `AdminKeyGuard` + `TenantGuard` only, no
 * `CrmPermissionsGuard`. A plan is a standing rate an org sets for itself,
 * not a CRM record a rep owns or a role can be scoped away from - nothing
 * here reads `RecordScope`, on purpose, the same reason pipelines,
 * automation rules and outreach cadences don't either.
 *
 * The rate itself is only ever READ by `ReportsService.commission()`, which
 * multiplies it against a window's attainment on every call - this
 * controller only maintains the rate, never computes a payout. See 0071's
 * header, and `sales_targets` (0050) before it, for the boundary that keeps
 * this a calculator input rather than payroll: no accrual, no claw-back, no
 * approval trail.
 */
@Controller("commission-plans")
@UseGuards(AdminKeyGuard, TenantGuard)
export class CommissionPlansController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${COMMISSION_PLAN_COLUMNS} FROM commission_plans
          ORDER BY active DESC, name ASC`,
      );
      return { plans: rows };
    });
  }

  @Get(":id")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [plan],
      } = await client.query(`SELECT ${COMMISSION_PLAN_COLUMNS} FROM commission_plans WHERE id = $1`, [
        id,
      ]);
      if (!plan) throw new NotFoundException("commission plan not found");
      return { plan };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateCommissionPlanBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [plan],
      } = await client.query(
        `INSERT INTO commission_plans (org_id, workspace_id, name, metric, rate_type, rate, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COMMISSION_PLAN_COLUMNS}`,
        [orgId, p.workspaceId ?? null, p.name, p.metric, p.rateType, p.rate, p.active],
      );
      await this.audit(client, orgId, "commission_plan.create", plan.id, req);
      return { plan };
    });
  }

  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateCommissionPlanBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [plan],
      } = await client.query(
        `UPDATE commission_plans SET
           name         = COALESCE($2, name),
           workspace_id = CASE WHEN $3::boolean THEN $4::uuid ELSE workspace_id END,
           metric       = COALESCE($5, metric),
           rate_type    = COALESCE($6, rate_type),
           rate         = COALESCE($7, rate),
           active       = COALESCE($8, active)
         WHERE id = $1
         RETURNING ${COMMISSION_PLAN_COLUMNS}`,
        [
          id,
          p.name ?? null,
          p.workspaceId !== undefined,
          p.workspaceId ?? null,
          p.metric ?? null,
          p.rateType ?? null,
          p.rate ?? null,
          p.active ?? null,
        ],
      );
      if (!plan) throw new NotFoundException("commission plan not found");
      await this.audit(client, orgId, "commission_plan.update", id, req);
      return { plan };
    });
  }

  /**
   * Deleted, not archived - `active` is already the soft toggle for "stop
   * applying this rate", so a hard delete is for cleaning up a plan that was
   * never right, the same distinction `sales_targets` draws for the same
   * reason: nothing else refers to a plan's id, `ReportsService.commission()`
   * reads active plans fresh on every call, so removing one removes a rate
   * and nothing else.
   */
  @Delete(":id")
  async remove(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: PrincipalRequest) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(`DELETE FROM commission_plans WHERE id = $1`, [id]);
      if (!rowCount) throw new NotFoundException("commission plan not found");
      await this.audit(client, orgId, "commission_plan.delete", id, req);
      return { deleted: true };
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
       VALUES ($1, 'user', $2, $3, 'commission_plan', $4)`,
      [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
    );
  }
}
