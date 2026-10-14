import { BadRequestException, Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { describeScope, operatorScopeSql, scopeForRequest } from "../../common/operator-scope";
import { OperatorMayCall, OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { CrossTenant, OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const OverviewQuery = z.object({ instanceId: z.string().uuid().optional() });

/**
 * Core analytics (§4.2 Platform Hub) + usage summary (§2.7 metering).
 *
 * Only the operator console reads these, on the bare admin key. A person the
 * owner console proxies for must be an owner or manager (doc 31 §2 X8): the
 * overview is whole-org call volume and usage, which the console's own
 * dashboards already restrict to those two personas.
 */
@Controller("analytics")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@OperatorMayCall()
@RequireOwnerRole("owner", "manager")
export class AnalyticsController {
  constructor(private readonly db: DbService) {}

  /**
   * Org-wide by default; pass `instanceId` to scope every figure to one
   * instance, which is what the instance detail page renders. Usage events are
   * not attributed per instance, so they stay org-wide either way.
   */
  @Get("overview")
  async overview(
    @OrgId() orgId: string,
    @Query() query: unknown,
  ) {
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
        // Live handsets only (0087), same as devices.controller's fleet.
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'active')::int AS active
           FROM devices
          WHERE removed_at IS NULL AND ($1::uuid IS NULL OR instance_id = $1::uuid)`,
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
   * `overview` above is per-org by construction - it reads under one RLS
   * context - so a console built only on it can never answer "how is the whole
   * fleet doing", and its totals get mistaken for exactly that. This runs on
   * the admin pool (like the rest of the /admin surface) because no single org
   * context spans every tenant, and returns a per-tenant breakdown alongside
   * the totals so the number is always attributable.
   */
  @Get("fleet")
  @CrossTenant()
  async fleet(@Req() req: PrincipalRequest) {
    const admin = this.db.adminPool();
    // ── SCOPED (doc 49 P13b) ───────────────────────────────────────────────
    //
    // Every number on this route is an aggregate ACROSS tenants, which makes
    // it the least obvious place a scope is needed and the worst place to
    // forget one: a superadmin reading the fleet's total call count is reading
    // the size of somebody else's business, even though no tenant is named.
    //
    // The gate is woven into each query rather than applied once, because
    // these are five independent aggregates and "apply it once" is how four of
    // them end up unfiltered.
    const scope = scopeForRequest(req);
    const callGate = operatorScopeSql(scope, "calls.org_id", 1);
    const orgGate = operatorScopeSql(scope, "organizations.id", 1);
    const deviceGate = operatorScopeSql(scope, "devices.org_id", 1);
    const byTenantGate = operatorScopeSql(scope, "o.id", 1);

    const {
      rows: [totals],
    } = await admin.query(
      `SELECT count(*)::int                                            AS calls,
              count(*) FILTER (WHERE status = 'COMPLETE')::int         AS complete,
              count(*) FILTER (WHERE status LIKE 'FAILED%')::int       AS failed,
              count(*) FILTER (WHERE status NOT IN ('COMPLETE', 'NO_AUDIO')
                                 AND status NOT LIKE 'FAILED%')::int   AS in_pipeline,
              COALESCE(sum(duration_s), 0)::int                        AS total_seconds
         FROM calls
        WHERE ${callGate.sql}`,
      callGate.params,
    );
    const {
      rows: [tenants],
    } = await admin.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active
         FROM organizations
        WHERE ${orgGate.sql}`,
      orgGate.params,
    );
    const {
      rows: [devices],
    } = await admin.query(
      // Live handsets only (0087) - a removed phone is not part of the fleet
      // this platform-wide count is describing.
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active
         FROM devices WHERE removed_at IS NULL AND ${deviceGate.sql}`,
      deviceGate.params,
    );
    const { rows: byTenant } = await admin.query(
      `SELECT o.id, o.name, o.status,
              count(c.id)::int                                      AS calls,
              count(c.id) FILTER (WHERE c.status LIKE 'FAILED%')::int AS failed,
              COALESCE(sum(c.duration_s), 0)::int                    AS total_seconds,
              max(c.started_at)                                     AS last_call_at
         FROM organizations o
         LEFT JOIN calls c ON c.org_id = o.id
        WHERE ${byTenantGate.sql}
        GROUP BY o.id, o.name, o.status
        ORDER BY calls DESC, o.name ASC`,
      byTenantGate.params,
    );
    const { rows: byDay } = await admin.query(
      `SELECT date_trunc('day', started_at)::date AS day,
              count(*)::int AS volume,
              count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete
         FROM calls
        WHERE started_at > now() - interval '30 days'
          AND ${callGate.sql}
        GROUP BY 1 ORDER BY 1`,
      callGate.params,
    );

    return {
      calls: totals,
      tenants,
      devices,
      byTenant,
      byDay,
      scope: scope.kind,
      // The caption, not just the kind. Every tile on the platform hub is an
      // aggregate over these rows, so a scoped hub reporting "4 tenants, 812
      // calls" is stating the size of one operator's book in the typography of
      // a platform total.
      scopeNote: describeScope(scope),
    };
  }

  /**
   * Platform-wide sign-ins, for the Platform Hub's "active users" tile.
   *
   * Counts DISTINCT `auth_user_id` from `auth_events` (0127) - a person who
   * signs in three times in a day is one active person, not three. Both
   * consoles count: an operator working the fleet and a tenant owner checking
   * their calls are both "the platform being used" from where this number is
   * read. Two adjacent 24h windows so the caller can compute a trend without a
   * second round trip; `last7d` gives the tile's context line.
   */
  @Get("active-users")
  @CrossTenant()
  async activeUsers() {
    const admin = this.db.adminPool();
    const {
      rows: [row],
    } = await admin.query(
      `SELECT count(DISTINCT auth_user_id) FILTER (
                WHERE created_at > now() - interval '24 hours')::int AS last24h,
              count(DISTINCT auth_user_id) FILTER (
                WHERE created_at <= now() - interval '24 hours'
                  AND created_at >  now() - interval '48 hours')::int AS previous24h,
              count(DISTINCT auth_user_id) FILTER (
                WHERE created_at > now() - interval '7 days')::int AS last7d
         FROM auth_events
        WHERE kind = 'sign_in'`,
    );
    return { last24h: row.last24h, previous24h: row.previous24h, last7d: row.last7d };
  }

  /**
   * The sales funnel's booking conversion, for the Platform Hub's
   * "transaction/booking rate" tile - the one place in this schema a
   * "booking" or a "conversion" is a real, stored fact rather than something
   * this route would have to invent. `marketing.funnel_submissions` is every
   * inbound enquiry; `marketing.booking_slots` with `status = 'booked'` is the
   * subset that turned into a sales call. Both counted in the SAME two
   * 30-day windows so the rate and its trend describe the same cohorts.
   */
  @Get("booking-rate")
  @CrossTenant()
  async bookingRate() {
    const admin = this.db.adminPool();
    const {
      rows: [row],
    } = await admin.query(
      `SELECT
         (SELECT count(*) FILTER (WHERE created_at > now() - interval '30 days')::int
            FROM marketing.funnel_submissions)                                       AS submissions_current,
         (SELECT count(*) FILTER (
                   WHERE created_at <= now() - interval '30 days'
                     AND created_at >  now() - interval '60 days')::int
            FROM marketing.funnel_submissions)                                       AS submissions_previous,
         (SELECT count(*) FILTER (WHERE booked_at > now() - interval '30 days')::int
            FROM marketing.booking_slots WHERE status = 'booked')                    AS booked_current,
         (SELECT count(*) FILTER (
                   WHERE booked_at <= now() - interval '30 days'
                     AND booked_at >  now() - interval '60 days')::int
            FROM marketing.booking_slots WHERE status = 'booked')                    AS booked_previous`,
    );
    return {
      submissionsCurrent: row.submissions_current,
      bookedCurrent: row.booked_current,
      submissionsPrevious: row.submissions_previous,
      bookedPrevious: row.booked_previous,
    };
  }
}
