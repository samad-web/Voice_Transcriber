/**
 * The pure half of the three Tier-1 reports from the Hawcus gap analysis:
 * response-time bucketing, lead-aging bucketing, and the compliance ratio.
 *
 * Split out of reports.service.ts for the same reason csv.ts is: these are the
 * definitions people will argue about in a performance review, and an argument
 * about what "compliant" means should be settleable by reading one small file
 * and its tests rather than by reading a 200-line SQL string.
 *
 * Nothing here touches the database or the clock. Every function takes the
 * numbers it needs.
 */

// ── Response time ───────────────────────────────────────────────────────────

/**
 * Minutes-to-first-response, bucketed.
 *
 * The boundaries are not arbitrary and they are not ours: 5 / 30 / 60 minutes
 * are the three thresholds the industry reports against, and they are what
 * Hawcus surfaces (`within_5min`, `within_30min`, `within_1hr`). Matching them
 * means our number is comparable to the one a customer may already be quoting
 * at us.
 *
 * `never` is a bucket rather than an omission. A lead nobody has answered is
 * the single most important row on this report, and dropping it would improve
 * the average every time the floor ignored someone.
 */
export const RESPONSE_BUCKETS = [
  { key: "under_5m", label: "Under 5 min", maxMinutes: 5 },
  { key: "under_30m", label: "5–30 min", maxMinutes: 30 },
  { key: "under_1h", label: "30–60 min", maxMinutes: 60 },
  { key: "under_4h", label: "1–4 hours", maxMinutes: 240 },
  { key: "under_24h", label: "4–24 hours", maxMinutes: 1440 },
  { key: "over_24h", label: "Over 24 hours", maxMinutes: Number.POSITIVE_INFINITY },
  { key: "never", label: "No response yet", maxMinutes: null },
] as const;

export type ResponseBucketKey = (typeof RESPONSE_BUCKETS)[number]["key"];

/**
 * `null` minutes means nobody has responded yet, which is `never` - NOT the
 * slowest bucket. They are different facts: "answered after three days" is a
 * bad response, "not answered" is an open piece of work.
 */
export function responseBucket(minutes: number | null): ResponseBucketKey {
  if (minutes === null || !Number.isFinite(minutes)) return "never";
  // Defensive: a clock-skewed device can produce a response that precedes the
  // lead. The migration's guard should stop it reaching us; if it does, it is
  // the fastest bucket, not a negative one.
  if (minutes <= 0) return "under_5m";
  for (const b of RESPONSE_BUCKETS) {
    if (b.maxMinutes !== null && minutes <= b.maxMinutes) return b.key;
  }
  return "over_24h";
}

// ── Lead aging ──────────────────────────────────────────────────────────────

/**
 * Age of an OPEN lead in whole days.
 *
 * Same boundaries Hawcus uses (0-3 / 4-7 / 8-15 / 16-30 / 30+), for the same
 * comparability reason as above. `maxDays: null` is the open-ended tail.
 *
 * These carry their own filter bounds because every bucket on the dashboard is
 * a link into the lead list - that is the whole point of the widget (see
 * §3.7 of the gap analysis: "every dashboard number is a filter into a work
 * queue"). Keeping the bounds beside the label is what stops the tile and the
 * list it links to from ever disagreeing.
 */
export const AGING_BUCKETS = [
  { key: "d0_3", label: "0–3 days", minDays: 0, maxDays: 3 },
  { key: "d4_7", label: "4–7 days", minDays: 4, maxDays: 7 },
  { key: "d8_15", label: "8–15 days", minDays: 8, maxDays: 15 },
  { key: "d16_30", label: "16–30 days", minDays: 16, maxDays: 30 },
  { key: "d30_plus", label: "30+ days", minDays: 31, maxDays: null },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]["key"];

export function agingBucket(days: number): AgingBucketKey {
  const d = Math.max(0, Math.floor(days));
  for (const b of AGING_BUCKETS) {
    if (b.maxDays !== null && d <= b.maxDays) return b.key;
  }
  return "d30_plus";
}

// ── Follow-up compliance ────────────────────────────────────────────────────

export interface ComplianceCounts {
  /** Completed, regardless of whether it was completed late. */
  completed: number;
  /** Past its due date and still open. */
  overdue: number;
  /** Due in the future and still open. */
  pending: number;
}

/**
 * Compliance is `completed / (completed + overdue)` - deliberately NOT
 * `completed / total`.
 *
 * The denominator is promises whose time has come. A task due next Friday is
 * not evidence of anything yet, and counting it as a failure would mean a rep
 * who plans a week ahead scores worse than one who plans nothing. Hawcus
 * divides by the whole window (§3.6) and gets exactly that artefact.
 *
 * Returns `null`, not 0, when nothing was due. "No tasks were due" and "every
 * task due was missed" are opposite facts and 0% cannot mean both - the same
 * rule migration 0088 applies to its nullable metric columns.
 */
export function compliancePct(counts: ComplianceCounts): number | null {
  const settled = counts.completed + counts.overdue;
  if (settled === 0) return null;
  return round1((counts.completed / settled) * 100);
}

/** Whole days a task is past due. 0 when it is not overdue. */
export function overdueDays(dueOn: string, today: string): number {
  const due = Date.parse(`${dueOn}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.round((now - due) / 86_400_000));
}

// ── Shared ──────────────────────────────────────────────────────────────────

/**
 * Median, not mean, is the headline response number.
 *
 * One lead answered three weeks late drags a mean far enough to make a good
 * week look bad, and response times are heavily right-skewed by construction -
 * they are bounded below by zero and unbounded above. Both are reported; the
 * median is the one on the tile.
 */
export function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function mean(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  return round1(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/** Percentage of `n` out of `total`, or null when there is no basis. */
export function pctOf(n: number, total: number): number | null {
  if (total <= 0) return null;
  return round1((n / total) * 100);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Tally a list of bucket keys into a dense, ordered result.
 *
 * Dense because a bucket with no leads in it must still render: an aging chart
 * that silently drops "30+ days" when it is empty looks identical to one where
 * the tile was never built, and the reader cannot tell good news from a bug.
 */
export function tally<K extends string>(
  definitions: readonly { key: K; label: string }[],
  keys: K[],
): { key: K; label: string; count: number; pct: number | null }[] {
  const counts = new Map<K, number>(definitions.map((d) => [d.key, 0]));
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const total = keys.length;
  return definitions.map((d) => ({
    key: d.key,
    label: d.label,
    count: counts.get(d.key) ?? 0,
    pct: pctOf(counts.get(d.key) ?? 0, total),
  }));
}
