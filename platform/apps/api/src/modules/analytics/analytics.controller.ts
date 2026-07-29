import { BadRequestException, Controller, Get, Headers, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

const OverviewQuery = z.object({ instanceId: z.string().uuid().optional() });

/** Core analytics (§4.2 Platform Hub) + usage summary (§2.7 metering). */
@Controller("analytics")
@UseGuards(AdminKeyGuard)
export class AnalyticsController {
  constructor(private readonly db: DbService) {}

  /**
   * Org-wide by default; pass `instanceId` to scope every figure to one
   * instance, which is what the instance detail page renders. Usage events are
   * not attributed per instance, so they stay org-wide either way.
   */
  @Get("overview")
  async overview(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Query() query: unknown,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = OverviewQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const instanceId = parsed.data.instanceId ?? null;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [calls],
      } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE c.status = 'COMPLETE')::int AS complete,
                count(*) FILTER (WHERE c.status LIKE 'FAILED%')::int AS failed,
                COALESCE(sum(c.duration_s), 0)::int AS total_seconds
           FROM calls c
           JOIN devices d ON d.id = c.device_id
          WHERE ($1::uuid IS NULL OR d.instance_id = $1::uuid)`,
        [instanceId],
      );
      const {
        rows: [devices],
      } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'active')::int AS active
           FROM devices
          WHERE ($1::uuid IS NULL OR instance_id = $1::uuid)`,
        [instanceId],
      );
      const { rows: usage } = await client.query(
        `SELECT kind, sum(quantity)::float AS total FROM usage_events GROUP BY kind`,
      );
      const { rows: byDay } = await client.query(
        `SELECT date_trunc('day', c.started_at)::date AS day,
                count(*)::int AS volume,
                count(*) FILTER (WHERE c.status = 'COMPLETE')::int AS complete
           FROM calls c
           JOIN devices d ON d.id = c.device_id
          WHERE c.started_at > now() - interval '7 days'
            AND ($1::uuid IS NULL OR d.instance_id = $1::uuid)
          GROUP BY 1 ORDER BY 1`,
        [instanceId],
      );
      return {
        calls,
        devices,
        usage: Object.fromEntries(usage.map((u) => [u.kind, u.total])),
        byDay,
      };
    });
  }

  /**
   * True cross-tenant rollup for the operator's Platform Hub.
   *
   * `overview` above is per-org by construction — it reads under one RLS
   * context — so a console built only on it can never answer "how is the whole
   * fleet doing", and its totals get mistaken for exactly that. This runs on
   * the admin pool (like the rest of the /admin surface) because no single org
   * context spans every tenant, and returns a per-tenant breakdown alongside
   * the totals so the number is always attributable.
   */
  @Get("fleet")
  async fleet() {
    const admin = this.db.adminPool();

    const {
      rows: [totals],
    } = await admin.query(
      `SELECT count(*)::int                                            AS calls,
              count(*) FILTER (WHERE status = 'COMPLETE')::int         AS complete,
              count(*) FILTER (WHERE status LIKE 'FAILED%')::int       AS failed,
              count(*) FILTER (WHERE status <> 'COMPLETE'
                                 AND status NOT LIKE 'FAILED%')::int   AS in_pipeline,
              COALESCE(sum(duration_s), 0)::int                        AS total_seconds
         FROM calls`,
    );
    const {
      rows: [tenants],
    } = await admin.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active
         FROM organizations`,
    );
    const {
      rows: [devices],
    } = await admin.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active
         FROM devices`,
    );
    const { rows: byTenant } = await admin.query(
      `SELECT o.id, o.name, o.status,
              count(c.id)::int                                      AS calls,
              count(c.id) FILTER (WHERE c.status LIKE 'FAILED%')::int AS failed,
              COALESCE(sum(c.duration_s), 0)::int                    AS total_seconds,
              max(c.started_at)                                     AS last_call_at
         FROM organizations o
         LEFT JOIN calls c ON c.org_id = o.id
        GROUP BY o.id, o.name, o.status
        ORDER BY calls DESC, o.name ASC`,
    );
    const { rows: byDay } = await admin.query(
      `SELECT date_trunc('day', started_at)::date AS day,
              count(*)::int AS volume,
              count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete
         FROM calls
        WHERE started_at > now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
    );

    return { calls: totals, tenants, devices, byTenant, byDay };
  }
}
