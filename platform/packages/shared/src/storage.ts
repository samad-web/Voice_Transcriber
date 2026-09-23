/**
 * How much a tenant is storing (doc 27 §6).
 *
 * ── WHAT COUNTS ───────────────────────────────────────────────────────────
 *
 * The only per-org FILES in object storage are handset call recordings, at
 * `org/<orgId>/calls/<callId>.m4a`, and their size is already on
 * `recordings.bytes`. Everything else a tenant "has" is rows, not files: report
 * CSVs are jsonb, imports are rows, WhatsApp media is never downloaded, logos
 * are URLs, PDFs are streamed. So "storage used" is recordings, plus - as a
 * separate, labelled estimate - the heaviest tables' row bytes (A4b).
 *
 * APK releases and database backups are the platform's storage, not the
 * tenant's, and never appear here.
 *
 * ── A SNAPSHOT, NOT A LIVE SUM ────────────────────────────────────────────
 *
 * The worker writes `org_storage_usage` once an hour; every read is one row.
 * Summing a year of recordings on each page load, Mumbai to Seoul, is the cost
 * the setup checklist's controller already refuses to pay. `computedAt` is
 * carried so every screen can say how old the number is.
 */
export interface StorageSummary {
  recordingBytes: number;
  recordingCount: number;
  /** Row bytes of the heaviest tables, estimated nightly. Null until the first run. */
  dbBytesEstimate: number | null;
  /** Operator-set, display-and-warn only. Null = no quota shown. */
  quotaBytes: number | null;
  /** When the worker last measured it. ISO. */
  computedAt: string;
  /** organizations.retention_days - recordings older than this are deleted. */
  retentionDays: number;
}

/**
 * The one unit factor, used both by the meter and by the operator's quota
 * input. "10 GB" typed into the input must equal "10 GB" on the meter, and
 * two factors (1000 in one place, 1024 in another) are exactly how an owner
 * ends up at "10.7 GB of 10 GB" on day one.
 */
export const BYTES_PER_KB = 1024;
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * "3.2 GB", "740 MB", "0 B".
 *
 * 1024-based but labelled KB/MB/GB, not KiB/GiB: tenants read "GB", and a
 * console that says "GiB" reads as a typo to everyone it is written for. One
 * decimal below 10 of a unit, none at or above it - "3.2 GB" but "740 MB",
 * which is how a person would say it and keeps the column from jittering.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let value = n;
  let unit = 0;
  while (value >= BYTES_PER_KB && unit < UNITS.length - 1) {
    value /= BYTES_PER_KB;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  // Rounded BEFORE choosing the precision, so 9.96 prints as "10 GB" rather
  // than "10.0 GB" - the same number in two spellings on one page is noise.
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  const text = rounded < 10 ? rounded.toFixed(1).replace(/\.0$/, "") : String(rounded);
  return `${text} ${UNITS[unit]}`;
}

/** GB (as typed in the operator's quota field) to bytes, with the same factor. */
export function gbToBytes(gb: number): number {
  return Math.round(gb * BYTES_PER_KB ** 3);
}

/** Bytes to GB, for pre-filling that same field. */
export function bytesToGb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_KB ** 3) * 100) / 100;
}

/** Recordings plus the database estimate when there is one. */
export function storageUsedBytes(s: StorageSummary): number {
  return s.recordingBytes + (s.dbBytesEstimate ?? 0);
}

/**
 * Percent of the quota used, or null when there is no quota.
 *
 * NOT clamped at 100: an org at 130 % is a fact the operator needs, and the
 * meter component clamps its own fill. Clamped at 0 below, since a negative
 * percentage can only be a bad row.
 */
export function storagePercent(s: StorageSummary): number | null {
  if (!s.quotaBytes || s.quotaBytes <= 0) return null;
  return Math.max(0, (storageUsedBytes(s) / s.quotaBytes) * 100);
}

/** What GET /v1/owner/plan-usage returns (doc 27 §6.7). Every number is read, none invented. */
export interface PlanUsage {
  modules: string[];
  retentionDays: number;
  /** Null until the worker's first storage sweep has run for this org. */
  storage: StorageSummary | null;
  /** Growth since the reading nearest 30 days ago, or since the oldest one if younger. */
  growth: { bytes: number; days: number } | null;
  month: {
    /** First day of this month in the org's reporting timezone, YYYY-MM-DD. */
    start: string;
    timezone: string;
    calls: number;
    recordedMinutes: number;
    /** Minutes transcribed in the window the worker enforces the budget over. */
    transcriptionMinutes: number;
    transcriptionBudget: number | null;
  };
  activeHandsets: number;
  activeMembers: number;
}

/** The two thresholds the in-app warning fires at (§6.6). */
export const STORAGE_ALERT_THRESHOLDS = [80, 100] as const;

/**
 * Which threshold a usage percentage has crossed - 100, 80, or null.
 *
 * The sweep compares this with `last_quota_alert_pct` and notifies only when it
 * RISES, so an org sitting at 85 % is told once, not every hour. Falling back
 * under 80 resets it, so a second climb is told again.
 */
export function storageAlertLevel(percent: number | null): 80 | 100 | null {
  if (percent === null) return null;
  if (percent >= 100) return 100;
  if (percent >= 80) return 80;
  return null;
}

/**
 * "At this rate you'll reach your limit in about N days", or null.
 *
 * Only with a quota and real growth, and only when N < 120: a projection four
 * months out is a guess dressed as a number, and "in about 3,000 days" reads as
 * a bug. `growthBytes` is over `windowDays` (30 on the Plan page).
 */
export function daysUntilQuota(
  s: StorageSummary,
  growthBytes: number,
  windowDays = 30,
): number | null {
  if (!s.quotaBytes || growthBytes <= 0 || windowDays <= 0) return null;
  const remaining = s.quotaBytes - storageUsedBytes(s);
  if (remaining <= 0) return 0;
  const days = Math.ceil(remaining / (growthBytes / windowDays));
  return days < 120 ? days : null;
}
