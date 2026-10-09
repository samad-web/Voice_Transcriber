import type { PoolClient } from "@aura/db";
import { FINANCE_DEFAULTS, toMinor } from "@aura/shared";

/**
 * One org's finance settings, resolved against §15's defaults.
 *
 * ── WHY THE DEFAULTS ARE NOT IN THE COLUMNS ─────────────────────────────────
 *
 * Every column on `finance_settings` is NULLable with no `DEFAULT`, and this
 * is the function that fills them in. The alternative - `DEFAULT 50000` in the
 * migration - puts §15's table in two places, and the column quietly wins: a
 * later change to `FINANCE_DEFAULTS` would then apply to new orgs only, which
 * is the hardest kind of inconsistency to notice because both halves look
 * right on their own.
 *
 * So: the migration stores only what an owner CHANGED, and this is the single
 * place the default is read. A test pins that every key of `FINANCE_DEFAULTS`
 * is reachable through here.
 *
 * Returns MINOR units for money, so a caller never has to remember which unit
 * a settings field is in.
 */
export interface FinanceSettings {
  manualApprovalThresholdMinor: number;
  autoMatchConfidence: number;
  minStatisticalSample: number;
  escalationHours: number[];
  quietHours: { from: number; to: number };
  minimumCashMinor: number;
  settlementToleranceMinor: number;
  discountPolicyPercent: number;
  /** False when the org has never saved any of this - drives the setup hint. */
  configured: boolean;
}

interface SettingsRow {
  manual_approval_threshold: string | null;
  auto_match_confidence: string | null;
  min_statistical_sample: number | null;
  escalation_hours: number[] | null;
  quiet_hours_from: number | null;
  quiet_hours_to: number | null;
  minimum_cash: string | null;
  settlement_tolerance: string | null;
  discount_policy_percent: string | null;
}

export const FINANCE_SETTINGS_COLUMNS = `manual_approval_threshold, auto_match_confidence,
  min_statistical_sample, escalation_hours, quiet_hours_from, quiet_hours_to,
  minimum_cash, settlement_tolerance, discount_policy_percent`;

export async function loadFinanceSettings(
  client: PoolClient,
  orgId: string,
): Promise<FinanceSettings> {
  const { rows } = await client.query<SettingsRow>(
    `SELECT ${FINANCE_SETTINGS_COLUMNS} FROM finance_settings WHERE org_id = $1`,
    [orgId],
  );
  return resolveFinanceSettings(rows[0]);
}

/**
 * Exported separately from the query so the pure resolution can be tested
 * without a database - which is where the interesting cases are: a row of all
 * NULLs, a partially-filled row, and a quiet-hours pair where only one half
 * was saved.
 */
export function resolveFinanceSettings(row: SettingsRow | undefined): FinanceSettings {
  const d = FINANCE_DEFAULTS;
  if (!row) {
    return {
      manualApprovalThresholdMinor: d.manualApprovalThresholdMinor,
      autoMatchConfidence: d.autoMatchConfidence,
      minStatisticalSample: d.minStatisticalSample,
      escalationHours: [...d.escalationHours],
      quietHours: { ...d.quietHours },
      minimumCashMinor: 0,
      settlementToleranceMinor: d.settlementToleranceMinor,
      discountPolicyPercent: 10,
      configured: false,
    };
  }
  return {
    manualApprovalThresholdMinor:
      row.manual_approval_threshold === null
        ? d.manualApprovalThresholdMinor
        : toMinor(row.manual_approval_threshold),
    autoMatchConfidence:
      row.auto_match_confidence === null ? d.autoMatchConfidence : Number(row.auto_match_confidence),
    minStatisticalSample: row.min_statistical_sample ?? d.minStatisticalSample,
    // An EMPTY array is treated as absent, not as "never escalate". An org that
    // genuinely wants no escalation disables the rules; an empty array in this
    // column is almost always a form that posted `[]` by accident, and
    // silently switching the ladder off is the failure nobody notices.
    escalationHours:
      row.escalation_hours && row.escalation_hours.length > 0
        ? row.escalation_hours
        : [...d.escalationHours],
    // Both halves or neither. A row with `from` saved and `to` NULL would make
    // `inQuietHours` compare against a default `to` the owner never chose, and
    // 21:00-08:00 is not a window you want half of.
    quietHours:
      row.quiet_hours_from !== null && row.quiet_hours_to !== null
        ? { from: row.quiet_hours_from, to: row.quiet_hours_to }
        : { ...d.quietHours },
    minimumCashMinor: row.minimum_cash === null ? 0 : toMinor(row.minimum_cash),
    settlementToleranceMinor:
      row.settlement_tolerance === null
        ? d.settlementToleranceMinor
        : toMinor(row.settlement_tolerance),
    discountPolicyPercent:
      row.discount_policy_percent === null ? 10 : Number(row.discount_policy_percent),
    configured: true,
  };
}

/**
 * The org's own today, as `YYYY-MM-DD`.
 *
 * `org_reporting_today()` (migration 0095), not `current_date` and not a
 * JavaScript `new Date()`. On a UTC box an Indian floor's day rolls over at
 * 05:30 local, so between midnight and 05:30 IST `current_date` is YESTERDAY -
 * which would make a schedule item due today read as overdue for the first
 * five and a half hours of its due date, and tell a customer their payment was
 * late while it was not.
 *
 * Every date comparison in this module goes through this.
 */
export async function orgToday(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT to_char(org_reporting_today(), 'YYYY-MM-DD') AS today`,
  );
  return rows[0].today;
}
