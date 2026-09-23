import { getAdminPool } from "@aura/db";
import { formatBytes, storageAlertLevel, storagePercent, type StorageSummary } from "@aura/shared";

/**
 * How much each tenant is storing (doc 27 §6.2, migration 0128).
 *
 * ── A SNAPSHOT, WRITTEN HERE, READ EVERYWHERE ELSE ────────────────────────
 *
 * The console reads storage on every navigation (it rides on
 * /v1/auth/context to reach the account menu). Summing a year of recordings
 * per page, Mumbai to Seoul, is the cost setup.controller.ts refuses to pay -
 * so this sweep writes one row per org per hour, and every read is one row.
 *
 * ── SET-BASED AND CROSS-TENANT, LIKE THE OTHER SWEEPS ─────────────────────
 *
 * One statement for every org's totals on the admin pool, as recycle-bin-purge
 * and the outreach sweep do. Looping orgs would be N round trips to answer
 * what one GROUP BY answers, and 0128's partial covering index makes that
 * GROUP BY an index-only scan.
 *
 * `uploaded_at IS NOT NULL` is not optional: a recordings row exists from
 * call-create time, before any audio does, and counting AWAITING_AUDIO or
 * FAILED_UPLOAD rows would report bytes that were never stored.
 *
 * ── THE QUOTA WARNS AND NEVER BLOCKS ──────────────────────────────────────
 *
 * At 80 % and 100 % of an operator-set quota, each OWNER gets one in-app
 * notification (kind 'storage_quota'). `last_quota_alert_pct` records the
 * threshold last told, so an org sitting at 85 % hears about it once, not
 * hourly; dropping under 80 % resets it so a second climb is told again.
 * Nothing leaves Aura - no email, no WhatsApp - and nothing refuses an upload.
 */

/** Heaviest tenant tables, for the nightly "about N MB of CRM data" estimate (A4b). */
const ESTIMATED_TABLES = [
  "transcripts",
  "conversation_messages",
  "report_dataset_rows",
  "ai_outputs",
  "audit_log",
  "leads",
  "contacts",
  "deals",
  "calls",
] as const;

/** The first run at or after this hour (IST) each day computes the estimate. */
const ESTIMATE_HOUR_IST = 2;
const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * Is a nightly database estimate due? True once per IST day, on the first run
 * at or after 02:00 IST - it is a full scan of nine tables and must never run
 * hourly. Pure, so the schedule is testable without a clock.
 */
export function estimateDue(now: Date, lastEstimatedAt: Date | null): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  if (ist.getUTCHours() < ESTIMATE_HOUR_IST) return false;
  // 02:00 IST today, as an instant.
  const todayAt2 = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), ESTIMATE_HOUR_IST) - IST_OFFSET_MS;
  return lastEstimatedAt === null || lastEstimatedAt.getTime() < todayAt2;
}

/**
 * What the quota sweep should do for one org: notify at a newly crossed
 * threshold, or just record a lower/cleared level. Pure - see the header.
 */
export function quotaAlertDecision(
  percent: number | null,
  lastAlertPct: number | null,
): { level: 80 | 100 | null; notify: boolean } {
  const level = storageAlertLevel(percent);
  const notify = level !== null && (lastAlertPct === null || level > lastAlertPct);
  return { level, notify };
}

interface UsageRow {
  org_id: string;
  recording_bytes: string;
  recording_count: number;
  db_bytes_estimate: string | null;
  db_estimated_at: Date | null;
  last_quota_alert_pct: number | null;
  storage_quota_bytes: string | null;
  retention_days: number;
  computed_at: Date;
}

/**
 * Every org's recording totals, orgs with none included.
 *
 * A named constant so apps/api/verify-account-storage-setup.cjs can execute
 * this exact text against a real database - typecheck cannot see SQL.
 */
export const STORAGE_SWEEP_SQL = `INSERT INTO org_storage_usage (org_id, recording_bytes, recording_count, oldest_recording_at, computed_at)
     SELECT o.id, COALESCE(r.bytes, 0), COALESCE(r.n, 0), r.oldest, now()
       FROM organizations o
       LEFT JOIN (
         SELECT org_id, sum(bytes)::bigint AS bytes, count(*)::int AS n, min(uploaded_at) AS oldest
           FROM recordings
          WHERE uploaded_at IS NOT NULL
          GROUP BY org_id
       ) r ON r.org_id = o.id
     ON CONFLICT (org_id) DO UPDATE SET
       recording_bytes     = EXCLUDED.recording_bytes,
       recording_count     = EXCLUDED.recording_count,
       oldest_recording_at = EXCLUDED.oldest_recording_at,
       computed_at         = EXCLUDED.computed_at`;

/**
 * Today's reading in each org's own calendar.
 *
 * A named constant so apps/api/verify-account-storage-setup.cjs can execute
 * this exact text against a real database - typecheck cannot see SQL.
 */
export const STORAGE_DAILY_SQL = `INSERT INTO org_storage_daily (org_id, day, recording_bytes)
     SELECT s.org_id, (now() AT TIME ZONE o.reporting_timezone)::date, s.recording_bytes
       FROM org_storage_usage s
       JOIN organizations o ON o.id = s.org_id
     ON CONFLICT (org_id, day) DO UPDATE SET recording_bytes = EXCLUDED.recording_bytes`;

export async function sweepStorageUsage(now: Date = new Date()): Promise<{ orgs: number; alerts: number }> {
  const pool = getAdminPool();

  // 1 ── every org's recording totals, orgs with none included (a zero is a
  // measurement too, and the menu should show "0 B" rather than nothing).
  const { rowCount: orgs } = await pool.query(
    STORAGE_SWEEP_SQL,
  );

  // 2 ── today's reading, in each org's own calendar, for 30-day growth.
  await pool.query(
    STORAGE_DAILY_SQL,
  );

  // 3 ── the nightly database estimate (A4b). Labelled "about" everywhere it
  // shows: pg_column_size ignores indexes and counts TOASTed values
  // compressed, so it is an order of magnitude, not an invoice line.
  const {
    rows: [oldestEstimate],
  } = await pool.query<{ at: Date | null }>(`SELECT min(db_estimated_at) AS at FROM org_storage_usage`);
  const {
    rows: [missing],
  } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM org_storage_usage WHERE db_estimated_at IS NULL`,
  );
  if (estimateDue(now, (missing?.n ?? 0) > 0 ? null : (oldestEstimate?.at ?? null))) {
    await estimateDatabaseBytes();
  }

  // 4 ── quota warnings.
  const { rows } = await pool.query<UsageRow>(
    `SELECT s.org_id, s.recording_bytes::text, s.recording_count, s.db_bytes_estimate::text,
            s.db_estimated_at, s.last_quota_alert_pct, o.storage_quota_bytes::text,
            o.retention_days, s.computed_at
       FROM org_storage_usage s
       JOIN organizations o ON o.id = s.org_id
      WHERE o.storage_quota_bytes IS NOT NULL OR s.last_quota_alert_pct IS NOT NULL`,
  );
  let alerts = 0;
  for (const row of rows) {
    const summary: StorageSummary = {
      recordingBytes: Number(row.recording_bytes),
      recordingCount: row.recording_count,
      dbBytesEstimate: row.db_bytes_estimate === null ? null : Number(row.db_bytes_estimate),
      quotaBytes: row.storage_quota_bytes === null ? null : Number(row.storage_quota_bytes),
      computedAt: row.computed_at.toISOString(),
      retentionDays: row.retention_days,
    };
    const { level, notify } = quotaAlertDecision(storagePercent(summary), row.last_quota_alert_pct);
    if (level === row.last_quota_alert_pct && !notify) continue;

    if (notify && summary.quotaBytes) {
      const used = formatBytes(summary.recordingBytes + (summary.dbBytesEstimate ?? 0));
      const title =
        level === 100
          ? `Storage is full: ${used} of ${formatBytes(summary.quotaBytes)}`
          : `Storage is ${level}% used: ${used} of ${formatBytes(summary.quotaBytes)}`;
      // Owners only - the persona that talks to the account manager. The
      // dedupe key carries the day, so a concurrent second sweep cannot double
      // up, while a genuine re-crossing on a later day is still told.
      const { rowCount } = await pool.query(
        `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
         SELECT m.org_id, m.user_id, 'storage_quota', $2, $3, '/owner/account/plan',
                'storage_quota:' || $4 || ':' || to_char(now(), 'YYYY-MM-DD')
           FROM memberships m
          WHERE m.org_id = $1 AND m.owner_role = 'owner' AND m.status = 'active'
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          row.org_id,
          title,
          "Recordings are still being saved. To raise your limit, talk to your account manager.",
          String(level),
        ],
      );
      alerts += rowCount ?? 0;
    }
    await pool.query(`UPDATE org_storage_usage SET last_quota_alert_pct = $2 WHERE org_id = $1`, [row.org_id, level]);
  }

  return { orgs: orgs ?? 0, alerts };
}

/** Row bytes per org across the heaviest tables. One GROUP BY per table. */
async function estimateDatabaseBytes(): Promise<void> {
  const pool = getAdminPool();
  // Every measured org starts at zero, so one with no rows in any of these
  // tables is written as "estimated at nothing" rather than left NULL, which
  // means "not estimated yet".
  const { rows: orgRows } = await pool.query<{ org_id: string }>(`SELECT org_id FROM org_storage_usage`);
  const totals = new Map<string, number>(orgRows.map((r) => [r.org_id, 0]));
  for (const table of ESTIMATED_TABLES) {
    const { rows } = await pool.query<{ org_id: string; bytes: string }>(
      `SELECT org_id, sum(pg_column_size(t.*))::bigint::text AS bytes FROM ${table} t GROUP BY org_id`,
    );
    for (const r of rows) {
      if (totals.has(r.org_id)) totals.set(r.org_id, (totals.get(r.org_id) ?? 0) + Number(r.bytes));
    }
  }
  await pool.query(
    `UPDATE org_storage_usage s
        SET db_bytes_estimate = e.bytes, db_estimated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS e(org_id uuid, bytes bigint)
      WHERE e.org_id = s.org_id`,
    [JSON.stringify([...totals].map(([org_id, bytes]) => ({ org_id, bytes })))],
  );
}

export function startStorageUsageSweep(): NodeJS.Timeout {
  const interval = Number(process.env.STORAGE_USAGE_INTERVAL_MS ?? 60 * 60 * 1000);
  const run = () =>
    void sweepStorageUsage()
      .then(({ orgs, alerts }) => {
        if (alerts > 0) console.log(`storage-usage: measured ${orgs} org(s), ${alerts} quota notification(s)`);
      })
      .catch((err) => console.error("storage-usage:", err));
  // Once at boot, so a fresh deploy has numbers within seconds rather than an hour.
  setTimeout(run, 30_000);
  return setInterval(run, interval);
}
