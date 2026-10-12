import { type KpiDirection, type KpiSpec, type KpiUnit, minBaseMeasure } from "./kpi-catalog";

/**
 * Achievement, pro-rating and the composite score.
 *
 * `Build docs/41_TELECALLER_PERFORMANCE_KPI_SPINE.md` Part G2. Pure arithmetic
 * over numbers the engine has already read, so it lives here with the other
 * derivations and is tested without a database.
 *
 * ── THE LICENCE FOR HAVING A SCORE AT ALL ───────────────────────────────────
 *
 * Doc 41 D1 refuses to average QA, sentiment and FCR: three rates over three
 * different subsets, and `agent-scorecard.ts` already declines to blend them.
 * What this file does is a different object with the same arithmetic: it
 * weights ACHIEVEMENT - `actual ÷ an agreed target` - which is unit-free. A
 * connect rate of 38% against a target of 40% and ₹4L closed against a target
 * of ₹5L are both "95% of what we agreed", and those two numbers can be
 * averaged because the division has already removed the units.
 *
 * That distinction is the whole licence for this file, and the moment somebody
 * adds a term that is not an achievement, the licence is gone.
 */

/**
 * Achievement is capped here, so one enormous number cannot paper over a weak
 * area. Doc 41 G2 keeps the original plan's §5 cap.
 *
 * 1.2 and not 1.0: a cap at parity would make over-delivery invisible and
 * remove any reward for it, which is its own kind of wrong.
 */
export const ACHIEVEMENT_CAP = 1.2;

/** Doc 41 G2 / migration 0191's `insights_settings.coverage_floor`. */
export const DEFAULT_COVERAGE_FLOOR = 0.6;

/**
 * One day of one KPI, as `kpi_snapshots` stores it.
 *
 * `numerator` and `denominator`, never a rate - see 0191's header for why this
 * is the most important column choice on that table.
 */
export interface SnapshotRow {
  kpiKey: string;
  day: string;
  numerator: number;
  denominator: number | null;
  targetValue: number | null;
  /** The period the target was set over, needed to pro-rate it. */
  targetPeriod: "daily" | "weekly" | "monthly" | null;
  weightPct: number | null;
}

/**
 * The actual value of a KPI over a window.
 *
 * `Σnum ÷ Σden` for a rate, `Σnum` for a count. This is the identity that the
 * catalogue's closed-under-addition rule exists to protect: summing rows is
 * only the right answer because every measure in `DAILY_MEASURES` is a count
 * or a sum.
 *
 * Returns `null` - not 0 - when there is nothing to divide by, and `null` is
 * the answer the whole way up the stack (doc 41 D2). A rate over an empty
 * denominator is not 0%; it is unknown, and a dashboard that prints 0% for it
 * has told the reader something false.
 */
export function windowValue(
  rows: readonly SnapshotRow[],
  spec: KpiSpec,
): { value: number | null; numerator: number; denominator: number | null; base: number } {
  let numerator = 0;
  let denominator = spec.denominator ? 0 : null;
  for (const row of rows) {
    numerator += row.numerator;
    if (denominator !== null) denominator += row.denominator ?? 0;
  }
  // The floor is checked against the base measure, which is usually the
  // denominator but is `qa_reviews` for `qa_score` - see `minBaseMeasure`.
  // Callers pass the base in `denominator` when the two coincide; when they do
  // not, the engine has already put the review count there.
  const base = denominator ?? numerator;
  if (denominator === null) {
    return { value: numerator, numerator, denominator: null, base };
  }
  if (denominator === 0) {
    return { value: null, numerator, denominator: 0, base: 0 };
  }
  return { value: numerator / denominator, numerator, denominator, base };
}

/**
 * Whether the KPI has enough behind it to be worth stating.
 *
 * `minBase` is per-KPI in the catalogue, because "enough" differs: ten calls
 * is enough to talk about a connect rate, one review is enough to talk about a
 * quality score, and five people worked is enough to talk about a conversion
 * rate.
 */
export function hasEnoughBase(spec: KpiSpec, base: number): boolean {
  const floor = spec.minBase;
  if (!floor) return true;
  // A count KPI with no denominator has no base to floor, and
  // `minBaseMeasure` returning null says so.
  if (!minBaseMeasure(spec)) return true;
  return base >= floor;
}

/**
 * Does a target for this unit scale with the length of the window?
 *
 * **This is a correction to doc 41 G2**, which says a monthly target read over
 * an arbitrary window is scaled by `window_days ÷ period_days` without
 * qualifying it. That is right for a count, a duration or an amount: 500 calls
 * a month is 250 calls over a fortnight.
 *
 * It is wrong, and badly wrong, for a rate. A connect-rate target of 45% is
 * 45% over a day, a week or a year - pro-rating it would produce a target of
 * 22.5% for a fortnight, which every telecaller would then "achieve" at 200%.
 * A composite built on that is not slightly off, it is inverted.
 *
 * So pro-rating is a property of the unit, and the two percent-shaped units
 * are excluded.
 */
export function unitProrates(unit: KpiUnit): boolean {
  return unit === "count" || unit === "seconds" || unit === "currency";
}

/** How many days the configured period covers, at a given reference date. */
export function periodDays(period: "daily" | "weekly" | "monthly", reference: Date): number {
  if (period === "daily") return 1;
  if (period === "weekly") return 7;
  // The real length of the reference month, not 30. A February target
  // pro-rated against 30 days is 7% out, every February.
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * The target to compare against, for a window of `windowDays` days.
 *
 * Pro-rated for extensive units, left alone for rates. Never scaled above the
 * period's own target by a window longer than the period - a 45-day read of a
 * monthly target gives 1.5x the target, which is correct: they have had 1.5
 * months to do it.
 */
export function effectiveTarget(
  spec: KpiSpec,
  target: number | null,
  period: "daily" | "weekly" | "monthly",
  windowDays: number,
  reference: Date,
): number | null {
  if (target === null) return null;
  if (!unitProrates(spec.unit)) return target;
  const days = periodDays(period, reference);
  if (days <= 0) return target;
  return (target * windowDays) / days;
}

/**
 * The target a window should be measured against, built from the per-day
 * targets the snapshots carry.
 *
 * ── WHY THIS IS A SUM OVER DAYS AND NOT ONE PRO-RATED NUMBER ────────────────
 *
 * `effectiveTarget` pro-rates ONE target to a window, which is right when the
 * target did not move. Targets do move: a monthly target of 500 raised to 600
 * on the 15th should give a 31-day window
 *
 *     14 × (500/31) + 17 × (600/31)
 *
 * and not 600 (which would judge the first fortnight by a target nobody had
 * agreed to then) nor 500 (which would ignore the raise). Each snapshot row
 * carries the target in force on ITS day, so summing each day's own share is
 * both the simplest implementation and the only correct one. It is also what
 * makes a recompute of a past day idempotent across a target change - the
 * property doc 41 F2 builds the resolution rule around.
 *
 * For a rate-shaped KPI nothing is pro-rated (see `unitProrates`), so the
 * answer is the target in force at the END of the window: a connect-rate
 * target of 45% raised to 50% means they are now measured against 50%.
 */
export function windowTarget(rows: readonly SnapshotRow[], spec: KpiSpec): number | null {
  const withTarget = rows.filter((r) => r.targetValue !== null);
  if (withTarget.length === 0) return null;

  if (!unitProrates(spec.unit)) {
    // Last by day, not last in the array - the caller's ordering is not a
    // contract and a leaderboard query may return days in any order.
    const latest = withTarget.reduce((a, b) => (a.day >= b.day ? a : b));
    return latest.targetValue;
  }

  let total = 0;
  for (const row of withTarget) {
    const period = row.targetPeriod ?? "monthly";
    const days = periodDays(period, new Date(`${row.day}T00:00:00Z`));
    if (days > 0) total += (row.targetValue as number) / days;
  }
  return total;
}

/**
 * `actual ÷ target`, inverted for a `lower`-is-better KPI, capped.
 *
 * `null` when there is no target (the owner chose to measure without judging),
 * when the actual is unknown, or when the arithmetic would divide by zero.
 * Every one of those is "no achievement", and none of them is 0% - a person
 * with no target has not failed to meet it.
 *
 * The `lower` inversion is `target ÷ actual`, which needs `actual > 0`. An
 * actual of 0 on a lower-is-better KPI is perfect performance and returns the
 * cap: zero breaches against a target of two breaches is not undefined, it is
 * as good as it gets.
 */
export function achievement(
  actual: number | null,
  target: number | null,
  direction: KpiDirection,
): number | null {
  if (actual === null || target === null) return null;
  if (direction === "higher") {
    if (target <= 0) return null;
    return Math.min(actual / target, ACHIEVEMENT_CAP);
  }
  if (actual <= 0) return ACHIEVEMENT_CAP;
  if (target < 0) return null;
  return Math.min(target / actual, ACHIEVEMENT_CAP);
}

export interface Band {
  bandKey: string;
  label: string;
  minPct: number;
  maxPct: number | null;
  tone: string;
}

/**
 * Which band an achievement lands in.
 *
 * Half-open intervals - `[minPct, maxPct)` - so three bands cover every value
 * with no gap and no overlap. The top band's `maxPct` is null and catches
 * everything above it, including the cap.
 *
 * `null` achievement gets `null` band, not the lowest one. A person with no
 * target is not "Needs support".
 */
export function bandFor(achievementFraction: number | null, bands: readonly Band[]): Band | null {
  if (achievementFraction === null) return null;
  const pct = achievementFraction * 100;
  const ordered = [...bands].sort((a, b) => a.minPct - b.minPct);
  for (const band of ordered) {
    if (pct >= band.minPct && (band.maxPct === null || pct < band.maxPct)) return band;
  }
  return null;
}

export interface CompositeEntry {
  kpiKey: string;
  weightPct: number;
  /** `null` when the KPI did not answer - suppressed, or no target. */
  achievement: number | null;
}

export interface CompositeResult {
  /** 0-120, or `null` when suppressed. */
  score: number | null;
  /** Fraction of configured weight that answered. */
  coverage: number;
  /** Total weight the owner configured, which SHOULD be 100 and may not be. */
  configuredWeight: number;
  suppressed: boolean;
  /** A machine reason, and the thing the UI turns into a sentence. */
  reason: "ok" | "below_coverage_floor" | "no_configuration" | "no_weights";
}

/**
 * `Σ(achievement × weight)` over the KPIs that answered.
 *
 * ── WHAT THIS FUNCTION REFUSES TO DO ────────────────────────────────────────
 *
 * It does not renormalise. If three of five KPIs answered, carrying 55% of the
 * weight, the score is the weighted sum over those three divided by 100 - not
 * divided by 55. Doc 41 G2 is explicit, and the reason is worth restating: a
 * score over 55% of the configured set is not the same object as a score over
 * all of it, and quietly renormalising is how a dashboard reports 94% for a
 * rep whose three measured KPIs happened to be the easy ones.
 *
 * Instead the score is suppressed below the coverage floor, and above it the
 * score is reported WITH its coverage, so the reader can see what it is a
 * score over. The console states coverage beside the number, always.
 */
export function compositeScore(
  entries: readonly CompositeEntry[],
  coverageFloor = DEFAULT_COVERAGE_FLOOR,
): CompositeResult {
  if (entries.length === 0) {
    return {
      score: null,
      coverage: 0,
      configuredWeight: 0,
      suppressed: true,
      reason: "no_configuration",
    };
  }
  const configuredWeight = entries.reduce((sum, e) => sum + e.weightPct, 0);
  if (configuredWeight <= 0) {
    return { score: null, coverage: 0, configuredWeight, suppressed: true, reason: "no_weights" };
  }

  let weighted = 0;
  let answeredWeight = 0;
  for (const entry of entries) {
    if (entry.achievement === null) continue;
    weighted += entry.achievement * entry.weightPct;
    answeredWeight += entry.weightPct;
  }
  const coverage = answeredWeight / configuredWeight;
  if (coverage < coverageFloor) {
    return { score: null, coverage, configuredWeight, suppressed: true, reason: "below_coverage_floor" };
  }
  // Divided by the CONFIGURED weight, not the answered weight. See above.
  return {
    score: (weighted / configuredWeight) * 100,
    coverage,
    configuredWeight,
    suppressed: false,
    reason: "ok",
  };
}

/**
 * Where somebody stands against a pro-rated target part-way through a period.
 *
 * The vocabulary matches `targets.ts`'s existing page - ahead of pace / on
 * track / behind / at risk - deliberately, so a reader who already knows one
 * screen is not learning a second set of words for the same idea.
 *
 * `paceSource` is carried through rather than inferred, because doc 41 D4
 * says a description must never silently become a quota: a bar whose pace came
 * from the floor's median must keep saying so, in words, and the moment a real
 * target exists it says that instead.
 */
export type PaceVerdict = "ahead" | "on_track" | "behind" | "at_risk" | "unknown";

export function paceVerdict(actual: number | null, expectedByNow: number | null): PaceVerdict {
  if (actual === null || expectedByNow === null || expectedByNow <= 0) return "unknown";
  const ratio = actual / expectedByNow;
  if (ratio >= 1.05) return "ahead";
  if (ratio >= 0.95) return "on_track";
  if (ratio >= 0.75) return "behind";
  return "at_risk";
}

/**
 * How a suppressed KPI explains itself.
 *
 * Every suppressed number renders as a dash WITH this sentence next to it, on
 * every screen. That is not politeness: a dash on a performance dashboard is
 * read as a zero unless something says otherwise, and the person being read is
 * a real one.
 */
export function suppressionReason(
  spec: KpiSpec,
  base: number,
): { suppressed: boolean; reason: string | null } {
  if (hasEnoughBase(spec, base)) return { suppressed: false, reason: null };
  const measure = minBaseMeasure(spec);
  if (base === 0) {
    return { suppressed: true, reason: `No ${noun(measure)} in this period yet.` };
  }
  return {
    suppressed: true,
    reason: `Only ${base} ${noun(measure)} — needs ${spec.minBase} before this is worth stating.`,
  };
}

function noun(measure: string | null): string {
  switch (measure) {
    case "connect_known":
      return "calls with a recorded outcome";
    case "distinct_leads":
      return "people worked";
    case "qa_reviews":
      return "reviews";
    case "active_days":
      return "working days";
    case "calls":
      return "calls";
    default:
      return "data points";
  }
}
