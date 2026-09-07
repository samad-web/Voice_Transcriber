import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard } from "../../common/owner-role.guard";
import { OwnerScope, type OwnerRecordScope, ownerScopeClause } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Telecaller productivity - talk time, call volume and the idle gap between
 * calls, read from the daily rollup (migration 0090).
 *
 * ── WHY THIS IS ITS OWN CONTROLLER ──────────────────────────────────────────
 *
 * owner.controller.ts already has a per-telecaller leaderboard, and this is
 * deliberately not merged into it. That one is a list of DEVICES joined
 * through `devices.telecaller_id` - it answers "which handset is producing
 * leads". This one is a list of PEOPLE keyed on the write-once
 * `calls.telecaller_id` snapshot (0068) - it answers "how did this person
 * spend their day", and has to stay correct across a handset being reassigned,
 * which is precisely what the device-joined version cannot do.
 *
 * ── THE PERSONA RULE ────────────────────────────────────────────────────────
 *
 * No `@RequireOwnerRole` on the read, and that is the considered choice rather
 * than an omission. Every persona is entitled to see their own numbers - a
 * telecaller looking at their own talk time is the feature working. What must
 * never happen is a telecaller reading the floor's, so the row filter comes
 * from `ownerScopeGuard` and is applied in the SQL below.
 *
 * That is the same shape, and the same trap, as
 * 13_ROUTE_AND_GUARD_INVENTORY.md finding 3: a route that mounts
 * OwnerRoleGuard and declares no requirement leaves the guard INERT. Here the
 * narrowing is done by OwnerScopeGuard instead, which is never inert - it
 * writes a scope for every request and defaults to matching nothing when an
 * own-scoped persona has no telecaller identity.
 */

const RangeQuery = z.object({
  /**
   * Calendar dates in the org's `reporting_timezone`, not instants. The rollup
   * stores a `date`, so a range expressed as timestamps would need a timezone
   * the caller does not have and would silently clip a day at each end.
   */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  /** Ranked worst-first when set, for a manager triaging who needs coaching. */
  sort: z.enum(["name", "calls", "talk", "gap", "sop"]).default("calls"),
});

/**
 * The one read.
 *
 * Aggregates the daily rows into a per-person total over the range, because a
 * manager compares people, not people-days. The daily rows stay available for
 * a trend line later - that is why the rollup is stored per day rather than
 * per range in the first place.
 *
 * Every talk figure is guarded by `talk_sample_calls`: an org that switched
 * diarization on midway through the range (or off) otherwise reports a partial
 * sample as if it were the whole period. Rather than hide that, the response
 * carries the sample size and lets the page say so.
 */
const SUMMARY_SQL = (scopeAnd: string) => `
  SELECT s.telecaller_id,
         t.display_name,
         t.status,
         sum(s.calls_total)::int        AS calls_total,
         sum(s.calls_connected)::int    AS calls_connected,
         sum(s.total_call_seconds)::int AS total_call_seconds,
         count(*)::int                  AS active_days,
         -- Median of the daily medians. Not a median of every gap in the
         -- range: that would let one busy day dominate a quiet week, and the
         -- question this answers is "on a typical day, how long does this
         -- person sit between calls".
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY s.median_gap_seconds
         )::int AS median_gap_seconds,
         max(s.longest_gap_seconds)::int AS longest_gap_seconds,
         sum(s.active_span_seconds)::int AS active_span_seconds,
         sum(s.presence_seconds)::int    AS presence_seconds,
         -- Talk. NULL across the board for a non-diarized org, by construction
         -- of the rollup - see 0090's header.
         sum(s.agent_talk_seconds)::int    AS agent_talk_seconds,
         sum(s.customer_talk_seconds)::int AS customer_talk_seconds,
         sum(s.interruption_count)::int    AS interruption_count,
         sum(s.talk_sample_calls)::int     AS talk_sample_calls,
         -- Weighted by the calls each day contributed, not a mean of daily
         -- means: a day with two calls must not count as much as a day with
         -- forty when describing how much of the range this person talked.
         CASE WHEN sum(s.talk_sample_calls) > 0
              THEN sum(s.mean_talk_ratio * s.talk_sample_calls) / sum(s.talk_sample_calls)
         END AS mean_talk_ratio,
         -- SOP adherence (0091), as scalar subqueries rather than a join.
         --
         -- A join would have to be pre-aggregated (call_sop_results is one row
         -- per CALL, this query is one row per PERSON) and would then need both
         -- its columns in GROUP BY. Two index seeks on
         -- call_sop_results_telecaller, once per person, is simpler to read and
         -- costs less than the reader has to spend understanding the join.
         --
         -- Ranged on call_started_at, never created_at: see 0091.
         (SELECT round(avg(r.adherence_pct))::int
            FROM call_sop_results r
           WHERE r.telecaller_id = s.telecaller_id
             AND r.adherence_pct IS NOT NULL
             AND r.call_started_at >= $1::date
             AND r.call_started_at < ($2::date + 1)) AS mean_adherence_pct,
         (SELECT count(*)::int
            FROM call_sop_results r
           WHERE r.telecaller_id = s.telecaller_id
             AND r.adherence_pct IS NOT NULL
             AND r.call_started_at >= $1::date
             AND r.call_started_at < ($2::date + 1)) AS sop_scored_calls
    FROM telecaller_daily_stats s
    JOIN telecallers t ON t.id = s.telecaller_id
   WHERE s.day >= $1::date AND s.day <= $2::date${scopeAnd}
   GROUP BY 1, 2, 3`;

@Controller("owner/productivity")
// Same four guards, same order, mounted on the class rather than per-handler -
// a new endpoint added below is scoped by default and has to opt out
// deliberately.
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OwnerScopeGuard, OrgFeatureGuard)
@RequireFeature("productivity")
export class TelecallerProductivityController {
  constructor(private readonly db: DbService) {}

  @Get()
  async productivity(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = RangeQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to, sort } = parsed.data;
    if (from > to) throw new BadRequestException("from must not be after to");

    return this.db.withOrg(orgId, async (client) => {
      const params: unknown[] = [from, to];
      // $3 when the persona narrows, absent when it does not - so an owner's
      // query is byte-for-byte the query it was before personas existed.
      const clause = ownerScopeClause("telecaller_stats", scope, params.length + 1, "s");
      if (clause) params.push(scope.telecallerId ?? null);

      const { rows } = await client.query(SUMMARY_SQL(clause ? ` AND ${clause}` : ""), params);

      // Sorted here rather than in SQL: the comparators differ in direction
      // (more calls is better, a longer gap is worse) and expressing that as
      // an interpolated ORDER BY would put caller-influenced text into the
      // statement for no gain on a result set this size.
      const sorted = [...rows].sort((a, b) => {
        switch (sort) {
          case "name":
            return String(a.display_name).localeCompare(String(b.display_name));
          case "talk":
            return (b.agent_talk_seconds ?? -1) - (a.agent_talk_seconds ?? -1);
          case "gap":
            // Worst first - the longest idle gap is the one worth looking at.
            return (b.median_gap_seconds ?? -1) - (a.median_gap_seconds ?? -1);
          case "sop":
            // LOWEST adherence first: this sort exists to find who needs
            // coaching, not to rank the top of the floor. Unscored people sort
            // last rather than first - an absent score is not a bad one.
            return (a.mean_adherence_pct ?? 101) - (b.mean_adherence_pct ?? 101);
          default:
            return (b.calls_total ?? 0) - (a.calls_total ?? 0);
        }
      });

      /**
       * The floor's midpoint, so a number on the page has something to be
       * read against. An individual figure with no reference invites the
       * reader to supply their own, which on a coaching screen is how "42
       * calls" becomes "not enough" without anyone checking.
       *
       * Computed over whatever rows this persona could see: for a telecaller
       * that is their own row alone, and the comparison is correctly
       * meaningless rather than a leak of the floor's distribution.
       */
      const median = (key: string): number | null => {
        const values = sorted
          .map((r) => r[key])
          .filter((v): v is number => typeof v === "number")
          .sort((a, b) => a - b);
        if (values.length === 0) return null;
        const mid = Math.floor(values.length / 2);
        return values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);
      };

      return {
        from,
        to,
        scope: scope.scope,
        telecallers: sorted,
        benchmarks: {
          calls_total: median("calls_total"),
          total_call_seconds: median("total_call_seconds"),
          agent_talk_seconds: median("agent_talk_seconds"),
          median_gap_seconds: median("median_gap_seconds"),
          mean_adherence_pct: median("mean_adherence_pct"),
        },
        /**
         * Whether talk metrics are available at all for this org, so the page
         * can say "not enabled" rather than rendering a column of dashes that
         * reads like missing data. Diarization is a per-instance cost decision
         * (0083), not a fault.
         */
        talk_metrics_available: sorted.some((r) => (r.talk_sample_calls ?? 0) > 0),
        /**
         * Whether any call in the range was scored against an SOP, so the page
         * can distinguish "no SOP defined" from "nobody followed it". The two
         * look identical in a column of dashes and mean opposite things.
         */
        sop_scoring_available: sorted.some((r) => (r.sop_scored_calls ?? 0) > 0),
      };
    });
  }

  /*
   * NO RECOMPUTE ENDPOINT, deliberately.
   *
   * The obvious next route is POST /recompute for a range, and it is not here
   * because there is nothing honest for it to do yet: the API process does not
   * import worker code, and a range recompute belongs on the worker's clock.
   * A route that accepted the request and returned 202 without anything
   * reading it would be the `startFollowUpDrain` bug again - a console
   * reporting "queued" for work nothing drains.
   *
   * The sweep already recomputes the last TELECALLER_STATS_LOOKBACK_DAYS every
   * 15 minutes, which covers every case anyone has asked for. Backfilling
   * history after a bulk reprocess is `runTelecallerStats(from, to)` on the
   * worker, the same way the other backfills in scripts/ work. Wire a route
   * when there is a queue behind it.
   */
}
