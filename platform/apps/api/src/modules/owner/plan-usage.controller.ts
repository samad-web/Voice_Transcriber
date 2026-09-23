import { Controller, Get, UseGuards } from "@nestjs/common";
import type { PlanUsage, StorageSummary } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Plan & usage's one query. $1 is the org.
 *
 * A named constant so apps/api/verify-account-storage-setup.cjs can execute
 * this exact text against a real database - typecheck cannot see SQL.
 */
export const PLAN_USAGE_SQL = `WITH o AS (
           SELECT id, enabled_modules, retention_days, storage_quota_bytes,
                  asr_monthly_minutes_budget, reporting_timezone,
                  -- Midnight on the 1st in the org's own zone, as an instant.
                  (date_trunc('month', now() AT TIME ZONE reporting_timezone)
                     AT TIME ZONE reporting_timezone)                        AS month_start_at,
                  (now() AT TIME ZONE reporting_timezone)::date              AS today
             FROM organizations WHERE id = $1
         ),
         baseline AS (
           -- The reading nearest 30 days ago; failing that (a young org), the
           -- oldest one there is, so growth is "in the last N days" honestly.
           SELECT d.recording_bytes, (o.today - d.day) AS age_days
             FROM org_storage_daily d, o
            WHERE d.org_id = o.id AND d.day <= o.today - 30
            ORDER BY d.day DESC LIMIT 1
         ),
         oldest AS (
           SELECT d.recording_bytes, (o.today - d.day) AS age_days
             FROM org_storage_daily d, o
            WHERE d.org_id = o.id
            ORDER BY d.day ASC LIMIT 1
         )
         SELECT o.enabled_modules, o.retention_days, o.storage_quota_bytes::text,
                o.asr_monthly_minutes_budget, o.reporting_timezone,
                to_char(o.month_start_at AT TIME ZONE o.reporting_timezone, 'YYYY-MM-DD') AS month_start,
                s.recording_bytes::text, s.recording_count, s.db_bytes_estimate::text, s.computed_at,
                (SELECT recording_bytes::text FROM org_storage_daily
                  WHERE org_id = o.id ORDER BY day DESC LIMIT 1)                        AS today_bytes,
                COALESCE((SELECT recording_bytes FROM baseline),
                         (SELECT recording_bytes FROM oldest))::text                    AS baseline_bytes,
                COALESCE((SELECT age_days FROM baseline), (SELECT age_days FROM oldest)) AS baseline_age_days,
                -- Recorded calls only: a missed call (NO_AUDIO, 0133) used no plan.
                (SELECT count(*)::int FROM calls
                  WHERE started_at >= o.month_start_at AND status <> 'NO_AUDIO')        AS calls,
                (SELECT COALESCE(sum(duration_s), 0)::text FROM calls
                  WHERE started_at >= o.month_start_at)                                  AS recorded_seconds,
                (SELECT COALESCE(sum(quantity), 0)::text FROM usage_events
                  WHERE kind IN ('asr_minutes', 'asr_minutes_diarized')
                    AND occurred_at >= date_trunc('month', now(), 'UTC'))                AS transcription_minutes,
                (SELECT count(*)::int FROM devices
                  WHERE status = 'active' AND removed_at IS NULL)                        AS active_handsets,
                (SELECT count(DISTINCT user_id)::int FROM memberships
                  WHERE status = 'active')                                               AS active_members
           FROM o
           LEFT JOIN org_storage_usage s ON s.org_id = o.id`;

/**
 * Plan & usage (doc 27 §6.7) - the account menu's third entry.
 *
 * Labelled "Plan & usage", not "Billing": Aura does not bill tenants yet, and a
 * "Billing" page with no bills is a dead end. So there is no invoices card here
 * either - an empty section that will never fill is the same dead end one
 * level down.
 *
 * ── ONE QUERY ──────────────────────────────────────────────────────────────
 *
 * Every card on the page is a scalar subquery of one SELECT, the setup
 * checklist's technique, for the same Mumbai-to-Seoul reason.
 *
 * ── TWO MONTHS, ON PURPOSE ─────────────────────────────────────────────────
 *
 * Calls and recorded minutes use the org's `reporting_timezone` month, like
 * every other report. Transcription minutes do NOT: they sit beside the
 * `asr_monthly_minutes_budget` meter, and the worker enforces that budget over
 * the platform's UTC calendar month (pipeline.ts, `date_trunc('month', now(), 'UTC')`).
 * Both say 'UTC' explicitly since doc 30 put tenant transactions on the org's
 * clock - a bare date_trunc here would now be the org's month.
 * A meter measured over a different window than the one enforced would read
 * "40 of 50 minutes" while calls were already being refused. The honest
 * number is the enforced one.
 *
 * Dates leave SQL through `to_char`, never as a Date: a `date` column read into
 * JS becomes midnight UTC and prints as the previous day east of Greenwich.
 */
@Controller("owner/plan-usage")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class PlanUsageController {
  constructor(private readonly db: DbService) {}

  @Get()
  async get(@OrgId() orgId: string): Promise<{ usage: PlanUsage | null }> {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{
        enabled_modules: string[];
        retention_days: number;
        storage_quota_bytes: string | null;
        asr_monthly_minutes_budget: number | null;
        reporting_timezone: string;
        month_start: string;
        recording_bytes: string | null;
        recording_count: number | null;
        db_bytes_estimate: string | null;
        computed_at: Date | null;
        today_bytes: string | null;
        baseline_bytes: string | null;
        baseline_age_days: number | null;
        calls: number;
        recorded_seconds: string;
        transcription_minutes: string;
        active_handsets: number;
        active_members: number;
      }>(
        PLAN_USAGE_SQL,
        [orgId],
      );
      if (!row) return { usage: null };

      const storage: StorageSummary | null = row.computed_at
        ? {
            recordingBytes: Number(row.recording_bytes ?? 0),
            recordingCount: row.recording_count ?? 0,
            dbBytesEstimate: row.db_bytes_estimate === null ? null : Number(row.db_bytes_estimate),
            quotaBytes: row.storage_quota_bytes === null ? null : Number(row.storage_quota_bytes),
            computedAt: row.computed_at.toISOString(),
            retentionDays: row.retention_days,
          }
        : null;

      const growth =
        row.today_bytes !== null && row.baseline_bytes !== null && (row.baseline_age_days ?? 0) > 0
          ? { bytes: Number(row.today_bytes) - Number(row.baseline_bytes), days: row.baseline_age_days ?? 0 }
          : null;

      return {
        usage: {
          modules: row.enabled_modules ?? [],
          retentionDays: row.retention_days,
          storage,
          growth,
          month: {
            start: row.month_start,
            timezone: row.reporting_timezone,
            calls: row.calls,
            recordedMinutes: Math.round(Number(row.recorded_seconds) / 60),
            transcriptionMinutes: Math.round(Number(row.transcription_minutes)),
            transcriptionBudget: row.asr_monthly_minutes_budget,
          },
          activeHandsets: row.active_handsets,
          activeMembers: row.active_members,
        },
      };
    });
  }
}
