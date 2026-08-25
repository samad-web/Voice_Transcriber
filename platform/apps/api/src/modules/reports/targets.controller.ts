import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  attainmentStatus,
  periodElapsed,
  SalesTargetInput,
  type Attainment,
  type TargetMetric,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * `period_start`/`period_end` go through to_char rather than being returned
 * raw — the same trap that shipped `tasks.due_on` and
 * `deals.expected_close_date` a day early on this platform's +05:30 host
 * before it was caught live. A quarter that starts "2026-06-30" is a
 * different quarter.
 *
 * Two spellings because one query joins `users` and needs the alias, and a
 * bare `id` beside `u.name` is ambiguous.
 */
const TARGET_FIELDS = (p: string) => `${p}id, ${p}owner_user_id, ${p}workspace_id,
  to_char(${p}period_start, 'YYYY-MM-DD') AS period_start,
  to_char(${p}period_end, 'YYYY-MM-DD')   AS period_end,
  ${p}metric, ${p}target_value, ${p}notes, ${p}created_at, ${p}updated_at`;

const TARGET_COLUMNS = TARGET_FIELDS("");
const TARGET_COLUMNS_T = TARGET_FIELDS("t.");

const ListQuery = z.object({
  /** Targets whose period covers this date. Defaults to today. */
  on: z.string().date().optional(),
  /** Every target, not just the current period's. */
  all: z.coerce.boolean().optional(),
});

/**
 * Sales targets and attainment (PRD Layer 5, migration 0050).
 *
 * ── `date` COLUMNS GO THROUGH to_char ─────────────────────────────────────
 *
 * Same trap as `tasks.due_on` and `deals.expected_close_date`, both of which
 * shipped a day early on this platform's +05:30 host before it was caught
 * live: node-postgres parses a `date` at the SERVER's local midnight and JSON
 * emits it as UTC. A quarter that starts "2026-06-30" is a different quarter.
 *
 * ── GATED ON `deal` ───────────────────────────────────────────────────────
 *
 * A target is a statement about deals, and attainment is computed from them,
 * so `deal:view` is the honest requirement rather than inventing a
 * `target` object type for four routes. Setting one needs `deal:edit`: it
 * changes what every report says about a person's performance, which is not
 * something a read-only role should be able to do.
 *
 * The `owned` scope applies. A rep restricted to their own records sees their
 * own target and their own attainment, and not the team's — which is the
 * whole point of having configured that scope.
 */
@Controller("targets")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class TargetsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("deal", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { on, all } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (!all) {
        params.push(on ?? null);
        where.push(
          `COALESCE($${params.length}::date, current_date) BETWEEN t.period_start AND t.period_end`,
        );
      }
      // A scoped rep sees their own target. Deliberately NOT the team target
      // (owner_user_id IS NULL) as well: a team number is a management figure,
      // and showing it to somebody who cannot see the deals behind it invites
      // exactly the wrong conclusion.
      if (recordScope.scope === "owned") {
        params.push(recordScope.userId);
        where.push(`t.owner_user_id = $${params.length}`);
      }

      const { rows } = await client.query(
        `SELECT ${TARGET_COLUMNS_T}, u.name AS owner_name
           FROM sales_targets t
           LEFT JOIN users u ON u.id = t.owner_user_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY t.period_start DESC, u.name NULLS FIRST`,
        params,
      );
      return { targets: rows };
    });
  }

  /**
   * Attainment: each target beside what has actually been closed against it.
   *
   * Actuals come from `deals` on `owner_user_id` and `stage_changed_at` —
   * when the deal became won, not when it was created. A deal opened in March
   * and won in July belongs to July's number, which is the one anybody
   * measuring a quarter means.
   */
  @Get("attainment")
  @RequireCrmPermission("deal", "view")
  async attainment(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const on = parsed.data.on ?? null;

    return this.db.withOrg(orgId, async (client) => {
      const params: unknown[] = [on];
      let ownerFilter = "";
      if (recordScope.scope === "owned") {
        params.push(recordScope.userId);
        ownerFilter = `AND t.owner_user_id = $${params.length}`;
      }

      const { rows } = await client.query<{
        id: string;
        owner_user_id: string | null;
        owner_name: string | null;
        metric: string;
        period_start: string;
        period_end: string;
        target_value: string;
        actual: string;
      }>(
        `SELECT t.id,
                t.owner_user_id,
                u.name AS owner_name,
                t.metric,
                to_char(t.period_start, 'YYYY-MM-DD') AS period_start,
                to_char(t.period_end, 'YYYY-MM-DD')   AS period_end,
                t.target_value,
                COALESCE((
                  SELECT CASE WHEN t.metric = 'won_count'
                              THEN count(*)::numeric
                              ELSE COALESCE(sum(d.amount), 0)
                         END
                    FROM deals d
                   WHERE d.status = 'won'
                     -- A NULL owner on the target means the whole org, so it
                     -- counts every won deal rather than the ones with no
                     -- owner set.
                     AND (t.owner_user_id IS NULL OR d.owner_user_id = t.owner_user_id)
                     AND d.stage_changed_at::date BETWEEN t.period_start AND t.period_end
                ), 0) AS actual
           FROM sales_targets t
           LEFT JOIN users u ON u.id = t.owner_user_id
          WHERE COALESCE($1::date, current_date) BETWEEN t.period_start AND t.period_end
                ${ownerFilter}
          ORDER BY u.name NULLS FIRST`,
        params,
      );

      // `on` lets a test (and a report of a past quarter) ask "as of then"
      // rather than always measuring against today.
      const now = on ? new Date(`${on}T12:00:00Z`) : new Date();

      const attainment: Array<Attainment & { status: string }> = rows.map((row) => {
        const target = Number(row.target_value);
        const actual = Number(row.actual);
        const elapsed = periodElapsed(row.period_start, row.period_end, now);
        // Guarded even though the column has a CHECK (> 0): this is a
        // division, and a zero reaching it would render Infinity on a page
        // somebody is about to make a decision from.
        const ratio = target > 0 ? Number((actual / target).toFixed(4)) : 0;
        return {
          targetId: row.id,
          ownerUserId: row.owner_user_id,
          ownerName: row.owner_name ?? (row.owner_user_id ? null : "Whole team"),
          metric: row.metric as TargetMetric,
          periodStart: row.period_start,
          periodEnd: row.period_end,
          target,
          actual,
          ratio,
          periodElapsed: elapsed,
          pace: Number((target * elapsed).toFixed(2)),
          status: attainmentStatus(ratio, elapsed),
        };
      });

      return { attainment, asOf: on ?? new Date().toISOString().slice(0, 10) };
    });
  }

  @Post()
  @RequireCrmPermission("deal", "edit")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = SalesTargetInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const t = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      if (t.ownerUserId) {
        const found = await client.query(`SELECT 1 FROM users WHERE id = $1`, [t.ownerUserId]);
        if (!found.rowCount) throw new BadRequestException("user not found");
      }

      // ON CONFLICT on both partial unique indexes would need two statements,
      // so the overlap is checked explicitly — and it gives a message that
      // says what happened rather than surfacing a 23505.
      const clash = await client.query(
        `SELECT 1 FROM sales_targets
          WHERE metric = $1 AND period_start = $2::date AND period_end = $3::date
            AND owner_user_id IS NOT DISTINCT FROM $4`,
        [t.metric, t.periodStart, t.periodEnd, t.ownerUserId ?? null],
      );
      if (clash.rowCount) {
        throw new BadRequestException("a target already exists for that person and period");
      }

      const {
        rows: [target],
      } = await client.query(
        `INSERT INTO sales_targets
           (org_id, workspace_id, owner_user_id, period_start, period_end, metric,
            target_value, notes, created_by)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9)
         RETURNING ${TARGET_COLUMNS}`,
        [
          orgId,
          t.workspaceId ?? null,
          t.ownerUserId ?? null,
          t.periodStart,
          t.periodEnd,
          t.metric,
          t.targetValue,
          t.notes ?? null,
          actorUserId(req),
        ],
      );
      await this.audit(client, orgId, "target.create", target.id);
      return { target };
    });
  }

  /**
   * Deleted, not archived.
   *
   * A target holds no history that anything else refers to — attainment is
   * computed live from `deals`, so removing a target removes a comparison and
   * nothing else. Contrast a custom field, which is archived because records
   * still carry its values.
   */
  @Delete(":id")
  @RequireCrmPermission("deal", "edit")
  async remove(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // A scoped rep can only delete their own target — and in practice
      // should not be setting targets at all, which is what `deal:edit`
      // being required already expresses.
      const scoped = scopeClause("deal", recordScope, 2);
      const { rowCount } = await client.query(
        `DELETE FROM sales_targets WHERE id = $1 ${
          scoped ? "AND owner_user_id = $2" : ""
        }`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!rowCount) throw new NotFoundException("target not found");
      await this.audit(client, orgId, "target.delete", id);
      return { deleted: true };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'user', 'dev-admin', $2, 'sales_target', $3)`,
      [orgId, action, targetId],
    );
  }
}

function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
