import { Controller, Get, Headers, UseGuards } from "@nestjs/common";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

/** Core analytics (§4.2 Platform Hub) + usage summary (§2.7 metering). */
@Controller("analytics")
@UseGuards(AdminKeyGuard)
export class AnalyticsController {
  constructor(private readonly db: DbService) {}

  @Get("overview")
  async overview(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [calls],
      } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete,
                count(*) FILTER (WHERE status LIKE 'FAILED%')::int AS failed,
                COALESCE(sum(duration_s), 0)::int AS total_seconds
           FROM calls`,
      );
      const {
        rows: [devices],
      } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'active')::int AS active
           FROM devices`,
      );
      const { rows: usage } = await client.query(
        `SELECT kind, sum(quantity)::float AS total FROM usage_events GROUP BY kind`,
      );
      const { rows: byDay } = await client.query(
        `SELECT date_trunc('day', started_at)::date AS day,
                count(*)::int AS volume,
                count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete
           FROM calls
          WHERE started_at > now() - interval '7 days'
          GROUP BY 1 ORDER BY 1`,
      );
      return {
        calls,
        devices,
        usage: Object.fromEntries(usage.map((u) => [u.kind, u.total])),
        byDay,
      };
    });
  }
}
