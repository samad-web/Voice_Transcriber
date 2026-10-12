import {
  type Band,
  type CompositeEntry,
  type CompositeResult,
  type KpiSpec,
  type SnapshotRow,
  DEFAULT_KPI_BANDS,
  achievement,
  bandFor,
  compositeScore,
  hasEnoughBase,
  kpiSpec,
  minBaseMeasure,
  suppressionReason,
  windowTarget,
  windowValue,
} from "@aura/shared";

/**
 * Reading the KPI spine: the queries and the assembly every dashboard shares.
 *
 * Plain functions over the client the controller already opened, the same
 * arrangement `org-chart/tree.ts` uses - which is what keeps a page's four
 * reads inside ONE transaction and therefore consistent with each other. A
 * dashboard assembled from four separately-committed snapshots can show a
 * composite that disagrees with the KPI cards it is made of.
 *
 * ── THE READ NEVER RECOMPUTES ───────────────────────────────────────────────
 *
 * Everything here reads `kpi_snapshots`. §11's p95 target is met by precomputed
 * snapshots, and the one thing that would quietly destroy it is a read path
 * that falls back to scanning facts when a snapshot is missing. A missing
 * snapshot renders as "not computed yet" and the sweep fills it within the
 * quarter hour; it does not become a twelve-table aggregate inside somebody's
 * page load.
 *
 * The exception is the percentile statistics on the drill-down, which cannot be
 * stored (see `kpi-catalog.ts`'s header) and are computed over one person's
 * window - a bounded query by construction.
 */

export interface DayWindow {
  /** Inclusive, `YYYY-MM-DD` in the org's own timezone. */
  from: string;
  /** Inclusive. */
  to: string;
}

export interface SubjectRef {
  kind: "telecaller" | "user" | "team" | "org";
  id: string | null;
}

interface QueryClient {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
}

/** One KPI, resolved for one subject over one window. */
export interface KpiReading {
  key: string;
  label: string;
  blurb: string;
  category: string;
  unit: string;
  direction: "higher" | "lower";
  /** `null` means "not enough to say" - never 0. */
  actual: number | null;
  numerator: number;
  denominator: number | null;
  /** The base the `minBase` floor was checked against. */
  base: number;
  target: number | null;
  achievement: number | null;
  bandKey: string | null;
  bandLabel: string | null;
  bandTone: string | null;
  weightPct: number;
  suppressed: boolean;
  /** A sentence, rendered next to the dash. Never omitted when suppressed. */
  suppressionReason: string | null;
  /** How many days in the window actually had a snapshot row. */
  daysCovered: number;
}

export interface SubjectSummary {
  subject: SubjectRef;
  kpis: KpiReading[];
  composite: CompositeResult;
  bandKey: string | null;
  bandLabel: string | null;
  bandTone: string | null;
}

/**
 * The bands in force on a day, or the shipped defaults.
 *
 * An org that has never saved bands gets `DEFAULT_KPI_BANDS` rather than no
 * bands: a composite with no band is a number with no verdict, and the page
 * would have to invent one.
 */
export async function loadBands(
  client: QueryClient,
  orgId: string,
  onDay: string,
): Promise<Band[]> {
  const { rows } = await client.query<{
    band_key: string;
    label: string;
    min_pct: string;
    max_pct: string | null;
    tone: string;
  }>(
    `SELECT band_key, label, min_pct, max_pct, tone
       FROM org_kpi_bands
      WHERE org_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to > $2::date)
      ORDER BY sort, min_pct`,
    [orgId, onDay],
  );
  if (rows.length === 0) {
    return DEFAULT_KPI_BANDS.map((b) => ({
      bandKey: b.bandKey,
      label: b.label,
      minPct: b.minPct,
      maxPct: b.maxPct,
      tone: b.tone,
    }));
  }
  return rows.map((r) => ({
    bandKey: r.band_key,
    label: r.label,
    // `numeric` arrives as a string from node-postgres. Coerced once, here,
    // rather than at each comparison - a string compared with `>=` against a
    // number is a silent lexicographic bug ("9" >= "10").
    minPct: Number(r.min_pct),
    maxPct: r.max_pct === null ? null : Number(r.max_pct),
    tone: r.tone,
  }));
}

/** The KPI keys an org has configured as live on a day, with their weights. */
export async function liveKpiKeys(
  client: QueryClient,
  orgId: string,
  onDay: string,
): Promise<{ kpiKey: string; weightPct: number }[]> {
  const { rows } = await client.query<{ kpi_key: string; weight_pct: number }>(
    // The ORG-scoped rows decide WHICH KPIs are live and what they weigh;
    // narrower scopes (team, role, person) override the TARGET only. A
    // telecaller-scoped row that could add a KPI to the set would mean two
    // people in one workspace being scored on different things, and their
    // composites would not be comparable - which is the whole point of a
    // leaderboard.
    `SELECT kpi_key, weight_pct
       FROM org_kpi_config
      WHERE org_id = $1 AND scope_kind = 'org'
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to > $2::date)
      ORDER BY kpi_key`,
    [orgId, onDay],
  );
  return rows.map((r) => ({ kpiKey: r.kpi_key, weightPct: Number(r.weight_pct) }));
}

/**
 * Snapshots for a set of subjects over a window, grouped by subject.
 *
 * `env` is always `'live'` from the console. A test key's facts are in the same
 * tables with `env = 'test'` and the engine never writes snapshots for them,
 * so this filter is belt-and-braces - but it is the belt that makes "a sandbox
 * never affects live KPIs" (§6.3) true at the read as well as at the write.
 */
export async function loadSnapshots(
  client: QueryClient,
  params: {
    orgId: string;
    subjectKind: SubjectRef["kind"];
    subjectIds?: string[] | null;
    window: DayWindow;
    kpiKeys?: string[];
  },
): Promise<Map<string, SnapshotRow[]>> {
  const { orgId, subjectKind, subjectIds, window, kpiKeys } = params;
  const { rows } = await client.query<{
    subject_id: string | null;
    kpi_key: string;
    day: string;
    numerator: string;
    denominator: string | null;
    target_value: string | null;
    target_period: string | null;
    weight_pct: number | null;
  }>(
    `SELECT subject_id, kpi_key, to_char(day, 'YYYY-MM-DD') AS day,
            numerator, denominator, target_value, target_period, weight_pct
       FROM kpi_snapshots
      WHERE org_id = $1
        AND subject_kind = $2
        AND day >= $3::date AND day <= $4::date
        AND ($5::uuid[] IS NULL OR subject_id = ANY($5::uuid[]))
        AND ($6::text[] IS NULL OR kpi_key = ANY($6::text[]))`,
    [
      orgId,
      subjectKind,
      window.from,
      window.to,
      subjectIds && subjectIds.length > 0 ? subjectIds : null,
      kpiKeys && kpiKeys.length > 0 ? kpiKeys : null,
    ],
  );

  const out = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    // `org` subjects have a null id; keyed by the empty string so one Map
    // serves every subject kind and the caller does not branch.
    const key = row.subject_id ?? "";
    const list = out.get(key) ?? [];
    list.push({
      kpiKey: row.kpi_key,
      day: row.day,
      numerator: Number(row.numerator),
      denominator: row.denominator === null ? null : Number(row.denominator),
      targetValue: row.target_value === null ? null : Number(row.target_value),
      targetPeriod: (row.target_period as SnapshotRow["targetPeriod"]) ?? null,
      weightPct: row.weight_pct === null ? null : Number(row.weight_pct),
    });
    out.set(key, list);
  }
  return out;
}

/** How many whole days a window spans, inclusive of both ends. */
export function windowDays(window: DayWindow): number {
  const from = Date.parse(`${window.from}T00:00:00Z`);
  const to = Date.parse(`${window.to}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 1;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * Turn one subject's snapshot rows into the thing a page renders.
 *
 * ── A KPI WITH NO ROWS IS STILL LISTED ──────────────────────────────────────
 *
 * The configured set comes from `live`, not from what the snapshots happen to
 * contain, so a KPI the engine has not computed for this person appears with
 * `actual: null` and a reason. The alternative - listing only what has rows -
 * would silently shorten somebody's scorecard, and the composite's coverage
 * figure would have nothing to be a fraction OF.
 */
export function summariseSubject(
  subject: SubjectRef,
  snapshots: readonly SnapshotRow[],
  live: readonly { kpiKey: string; weightPct: number }[],
  bands: readonly Band[],
  coverageFloor: number,
): SubjectSummary {
  const readings: KpiReading[] = [];
  const entries: CompositeEntry[] = [];

  for (const { kpiKey, weightPct } of live) {
    const spec = kpiSpec(kpiKey);
    // A configured key with no catalogue entry means the config outlived a KPI
    // the code removed. Skipped rather than crashed, and skipped rather than
    // guessed: there is no formula to compute it with.
    if (!spec) continue;

    const rows = snapshots.filter((r) => r.kpiKey === kpiKey);
    const value = windowValue(rows, spec);
    const base = baseOf(spec, rows, value);
    const { suppressed, reason } = suppressionReason(spec, base);
    const actual = suppressed ? null : value.value;

    // Already window-correct: `windowTarget` pro-rates per day for an
    // extensive unit and takes the latest for a rate, so there is nothing
    // further to scale here. `effectiveTarget` is the single-target version
    // and is used by the handset-era pace bar, not by this path.
    const target = windowTarget(rows, spec);
    const achieved = achievement(actual, target, spec.direction);
    const band = bandFor(achieved, bands);

    readings.push({
      key: spec.key,
      label: spec.label,
      blurb: spec.blurb,
      category: spec.category,
      unit: spec.unit,
      direction: spec.direction,
      actual,
      numerator: value.numerator,
      denominator: value.denominator,
      base,
      target,
      achievement: achieved,
      bandKey: band?.bandKey ?? null,
      bandLabel: band?.label ?? null,
      bandTone: band?.tone ?? null,
      weightPct,
      suppressed,
      suppressionReason: reason,
      daysCovered: new Set(rows.map((r) => r.day)).size,
    });
    entries.push({ kpiKey: spec.key, weightPct, achievement: achieved });
  }

  const composite = compositeScore(entries, coverageFloor);
  const compositeBand = composite.score === null ? null : bandFor(composite.score / 100, bands);

  return {
    subject,
    kpis: readings,
    composite,
    bandKey: compositeBand?.bandKey ?? null,
    bandLabel: compositeBand?.label ?? null,
    bandTone: compositeBand?.tone ?? null,
  };
}

/**
 * The base a `minBase` floor is checked against.
 *
 * For most KPIs it is the summed denominator. For `qa_score` the catalogue
 * says the base is the REVIEW COUNT, which is not the denominator - so the
 * engine stores it in a companion row. Until it does, the honest fallback is
 * the denominator, and `minBase: 1` makes that harmless for the one KPI
 * affected: a non-zero points total means at least one review.
 */
function baseOf(
  spec: KpiSpec,
  rows: readonly SnapshotRow[],
  value: { denominator: number | null; numerator: number },
): number {
  if (!minBaseMeasure(spec)) return Number.POSITIVE_INFINITY;
  if (spec.key === "qa_score") {
    // One row per day, so the number of days with a non-zero denominator is a
    // lower bound on the number of reviews - and `minBase` is 1.
    return rows.filter((r) => (r.denominator ?? 0) > 0).length;
  }
  return value.denominator ?? value.numerator;
}

/** Rank a set of summaries, best first, with ties sharing a rank. */
export function rank(summaries: SubjectSummary[]): (SubjectSummary & { rank: number | null })[] {
  const scored = summaries
    .filter((s) => s.composite.score !== null)
    .sort((a, b) => (b.composite.score as number) - (a.composite.score as number));
  const unscored = summaries.filter((s) => s.composite.score === null);

  const out: (SubjectSummary & { rank: number | null })[] = [];
  let lastScore: number | null = null;
  let lastRank = 0;
  for (const [index, summary] of scored.entries()) {
    const score = summary.composite.score as number;
    // Ties share a rank. Two people on 87.4% are not 3rd and 4th, and telling
    // them they are is the kind of detail that gets a dashboard distrusted.
    const r = lastScore !== null && score === lastScore ? lastRank : index + 1;
    out.push({ ...summary, rank: r });
    lastScore = score;
    lastRank = r;
  }
  // A suppressed composite gets no rank at all, and sorts last. Ranking
  // somebody 24th of 24 because their score could not be computed would be a
  // judgement the data does not support.
  for (const summary of unscored) out.push({ ...summary, rank: null });
  return out;
}

/**
 * Doc 41 D2's "hasEnoughBase" re-exported for the controllers, so they do not
 * import two modules to answer one question.
 */
export { hasEnoughBase };
