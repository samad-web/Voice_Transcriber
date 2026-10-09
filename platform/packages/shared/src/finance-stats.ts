/**
 * The statistics the Finance Advisor decides with
 * (Build docs/finance-section-build-plan §12.2, §12.3, §12.4).
 *
 * ── §12'S PRINCIPLE, ENFORCED BY SHAPE ─────────────────────────────────────
 *
 * "Rules and statistics decide; language only explains." Every function here
 * is pure: no client, no fetch, no model. An alert's `explain` payload is
 * assembled from these return values, which is what makes §12's "every
 * advisory must be reproducible from data" literally true - given the same
 * inputs, the same alert, forever. There is no LLM call anywhere under
 * `finance/`, and the only way to keep that property is for the deciding code
 * to be unable to make one.
 *
 * ── WHY EVERY DETECTOR CAN REFUSE TO ANSWER ────────────────────────────────
 *
 * Each statistical function returns `null`, or an `ok: false`, when there is
 * not enough history. §12.4 is explicit: "require a minimum sample size
 * (default 8 periods) before statistical rules fire; otherwise stay silent
 * rather than guess." A detector that fires on three weeks of data teaches an
 * owner to ignore the inbox, and an ignored inbox is worse than an empty one.
 */

/** §15: statistical rules stay silent below this many periods. */
export const MIN_SAMPLE_DEFAULT = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Descriptive statistics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The p-th percentile by LINEAR INTERPOLATION between order statistics
 * (the "R-7" / Excel definition).
 *
 * Chosen because §11 asks for "median and 90th percentile" of days-to-collect
 * and §12.2 for the 25th/50th/75th of collection variance - and those are read
 * beside numbers people compute in a spreadsheet. A nearest-rank percentile
 * would differ from the owner's own check of the same column, and being
 * explainable matters more here than any statistical nicety.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Median absolute deviation - the robust spread §12.4's outlier test needs.
 *
 * Robust meaning one ₹8,00,000 invoice does not widen the band enough to hide
 * everything else, which is exactly what the standard deviation does and
 * exactly why the spec specifies MAD.
 */
export function mad(values: readonly number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * §12.4's outlier test:
 *
 *     modified_z = 0.6745 × (x − median) / MAD      flag when |modified_z| > 3.5
 *
 * The constant is the spec's. (0.6745 is the reciprocal of the 0.75 quantile
 * of the normal distribution, which makes MAD a consistent estimator of σ.)
 *
 * ── THE ZERO-MAD CASE, WHICH IS NOT RARE ───────────────────────────────────
 *
 * MAD is 0 whenever more than half the sample is identical - a rent of exactly
 * ₹45,000 every month, which is the most common shape of a fixed cost. The
 * formula then divides by zero and yields ±Infinity, so any difference at all
 * would be a 3.5-sigma outlier and the rule would fire the first month rent
 * went up by ₹100.
 *
 * So a zero MAD returns null - "cannot tell" - rather than Infinity, and the
 * caller falls back to the week-over-week change limit, which is the right
 * test for a series with no variance to measure.
 */
export function modifiedZScore(value: number, sample: readonly number[]): number | null {
  const m = median(sample);
  const dispersion = mad(sample);
  if (m === null || dispersion === null || dispersion === 0) return null;
  return (0.6745 * (value - m)) / dispersion;
}

export const OUTLIER_THRESHOLD = 3.5;

export interface OutlierVerdict {
  /** False whenever the test could not be run - too little data, or a zero MAD. */
  flagged: boolean;
  modifiedZ: number | null;
  median: number | null;
  mad: number | null;
  sampleSize: number;
  /** Why it did not fire, for the explain panel. Null when it did. */
  silentBecause: "insufficient_sample" | "no_dispersion" | "within_band" | null;
}

/**
 * The outlier test with its refusals made explicit, because the explain panel
 * (§12.6) has to be able to say WHY an alert did not fire as well as why it
 * did - that is the difference between a quiet inbox somebody trusts and one
 * they suspect is broken.
 */
export function outlierTest(
  value: number,
  sample: readonly number[],
  minSample = MIN_SAMPLE_DEFAULT,
): OutlierVerdict {
  const base = { sampleSize: sample.length, median: median(sample), mad: mad(sample) };
  if (sample.length < minSample) {
    return { ...base, flagged: false, modifiedZ: null, silentBecause: "insufficient_sample" };
  }
  const z = modifiedZScore(value, sample);
  if (z === null) {
    return { ...base, flagged: false, modifiedZ: null, silentBecause: "no_dispersion" };
  }
  return {
    ...base,
    flagged: Math.abs(z) > OUTLIER_THRESHOLD,
    modifiedZ: z,
    silentBecause: Math.abs(z) > OUTLIER_THRESHOLD ? null : "within_band",
  };
}

/**
 * The ordinary z-score, for the two rules §12.4 specifies in sigma rather than
 * modified-z: `refund_spike` (z > 2.5) and the fee-drift comparison.
 *
 * Kept separate from `modifiedZScore` rather than folded into it, because the
 * spec names a different test for different rules and a single "outlier"
 * helper would quietly apply one rule's statistics to another's threshold.
 */
export function zScore(value: number, sample: readonly number[]): number | null {
  if (sample.length < 2) return null;
  const m = mean(sample);
  if (m === null) return null;
  const variance = sample.reduce((sum, v) => sum + (v - m) ** 2, 0) / (sample.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  return (value - m) / sd;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.4 drift: the EWMA control chart
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exponentially weighted moving average, for the gradual drift §12.4 asks for.
 *
 * ── WHY AN OUTLIER TEST IS NOT ENOUGH ──────────────────────────────────────
 *
 * A gateway fee that climbs 0.05 pp a week is never an outlier against its own
 * trailing window - the window moves with it - so after six months the fee is
 * a third higher and no rule ever fired. EWMA fixes the baseline at a target
 * and accumulates the small deviations, which is the classic control-chart
 * answer to exactly that failure.
 *
 * λ = 0.2 is the standard default: responsive enough to catch a real shift
 * within a few periods, slow enough that one bad week does not trip it.
 */
export const EWMA_LAMBDA = 0.2;

export function ewma(values: readonly number[], lambda = EWMA_LAMBDA): number[] {
  const out: number[] = [];
  let z: number | undefined;
  for (const value of values) {
    z = z === undefined ? value : lambda * value + (1 - lambda) * z;
    out.push(z);
  }
  return out;
}

export interface DriftVerdict {
  flagged: boolean;
  /** The smoothed series' last value - what the alert quotes. */
  current: number | null;
  /** The target the series is measured against (the first `baselinePeriods`). */
  baseline: number | null;
  /** Control limit actually used, for the explain panel. */
  limit: number | null;
  sampleSize: number;
  silentBecause: "insufficient_sample" | "no_dispersion" | "within_limits" | null;
}

/**
 * An EWMA control chart with 3-sigma limits, narrowed for the smoothing.
 *
 * The control limit is `L × σ × sqrt(λ / (2 − λ))` - the standard asymptotic
 * EWMA limit. The sqrt term is why this is not just "3 sigma on a smoothed
 * series": smoothing shrinks the variance, so using the raw σ would make the
 * chart almost impossible to trip and the rule decorative.
 */
export function driftTest(
  series: readonly number[],
  options: { lambda?: number; sigmaLimit?: number; minSample?: number; baselinePeriods?: number } = {},
): DriftVerdict {
  const lambda = options.lambda ?? EWMA_LAMBDA;
  const sigmaLimit = options.sigmaLimit ?? 3;
  const minSample = options.minSample ?? MIN_SAMPLE_DEFAULT;
  const baselinePeriods = options.baselinePeriods ?? Math.floor(series.length / 2);

  if (series.length < minSample) {
    return {
      flagged: false,
      current: null,
      baseline: null,
      limit: null,
      sampleSize: series.length,
      silentBecause: "insufficient_sample",
    };
  }

  const baselineWindow = series.slice(0, Math.max(baselinePeriods, 2));
  const baseline = mean(baselineWindow);
  const m = mean(baselineWindow);
  const sd =
    m === null
      ? 0
      : Math.sqrt(
          baselineWindow.reduce((sum, v) => sum + (v - m) ** 2, 0) /
            Math.max(baselineWindow.length - 1, 1),
        );

  if (baseline === null || sd === 0) {
    return {
      flagged: false,
      current: ewma(series, lambda).at(-1) ?? null,
      baseline,
      limit: null,
      sampleSize: series.length,
      silentBecause: "no_dispersion",
    };
  }

  const limit = sigmaLimit * sd * Math.sqrt(lambda / (2 - lambda));
  const current = ewma(series, lambda).at(-1) ?? baseline;
  const flagged = Math.abs(current - baseline) > limit;
  return {
    flagged,
    current,
    baseline,
    limit,
    sampleSize: series.length,
    silentBecause: flagged ? null : "within_limits",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.2 the cash-flow forecast
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weighted moving average of recent periods, newest weighted highest
 * (§12.2's `new_sales_run_rate`).
 *
 * ── WHY NOT HOLT-WINTERS ───────────────────────────────────────────────────
 *
 * §12.2 says to move to Holt-Winters "only when at least two seasonal cycles
 * exist". For a weekly series that is two years of history, which no tenant on
 * this platform has. Fitting a seasonal model to fourteen weeks produces a
 * confident-looking forecast whose seasonality is noise - and a forecast an
 * owner acts on is worse than no forecast when its confidence is fictional.
 * `seasonalIndex` below is the honest intermediate: a measured day-of-month
 * shape when there IS a year of history, and 1 when there is not.
 */
export function weightedRunRate(periods: readonly number[], halfLife = 3): number | null {
  if (periods.length === 0) return null;
  // Newest last. Weight decays with age, halving every `halfLife` periods -
  // so a floor that doubled its sales last month is not averaged back down by
  // a quiet quarter.
  let weightedSum = 0;
  let weights = 0;
  periods.forEach((value, index) => {
    const age = periods.length - 1 - index;
    const weight = 0.5 ** (age / halfLife);
    weightedSum += value * weight;
    weights += weight;
  });
  return weights === 0 ? null : weightedSum / weights;
}

/**
 * The probability that money in a given aging bucket is ever collected,
 * learned from the org's own history (§12.2's `P(collected | aging_bucket, …)`).
 *
 * Conservative global priors when history is thin, and the caller labels the
 * forecast "low confidence" - §12.2's own instruction. The priors are
 * deliberately pessimistic: a forecast that over-promises cash is the one that
 * causes a business to spend money it does not have.
 */
export const COLLECTION_PRIORS = {
  current: 0.9,
  "0_30": 0.75,
  "31_60": 0.5,
  "61_90": 0.3,
  "90_plus": 0.1,
} as const;

export interface CollectionRateObservation {
  bucket: keyof typeof COLLECTION_PRIORS;
  /** Minor units that sat in this bucket. */
  billedMinor: number;
  /** Minor units of that which were eventually collected. */
  collectedMinor: number;
}

export interface CollectionProbabilities {
  byBucket: Record<keyof typeof COLLECTION_PRIORS, number>;
  /** True when at least one bucket fell back to a prior. Drives the UI label. */
  lowConfidence: boolean;
  /** Buckets that used the org's own history, for the assumptions table. */
  learned: (keyof typeof COLLECTION_PRIORS)[];
}

/**
 * Blend the org's own history with the priors, per bucket.
 *
 * ── A WEIGHTED BLEND, NOT A SWITCH ─────────────────────────────────────────
 *
 * The obvious implementation is "use history if there are N observations,
 * otherwise the prior", and it has a visible discontinuity: the forecast
 * lurches on the day the Nth invoice lands. This is Laplace-style shrinkage
 * instead - the prior acts as `priorWeightMinor` of pseudo-observations, so
 * history takes over smoothly as it accumulates and the forecast line never
 * jumps for a reason that is not about the business.
 */
export function collectionProbabilities(
  observations: readonly CollectionRateObservation[],
  priorWeightMinor = 10_000_000,
): CollectionProbabilities {
  const byBucket = { ...COLLECTION_PRIORS } as Record<keyof typeof COLLECTION_PRIORS, number>;
  const learned: (keyof typeof COLLECTION_PRIORS)[] = [];

  for (const bucket of Object.keys(COLLECTION_PRIORS) as (keyof typeof COLLECTION_PRIORS)[]) {
    const rows = observations.filter((o) => o.bucket === bucket);
    const billed = rows.reduce((sum, o) => sum + o.billedMinor, 0);
    if (billed <= 0) continue;
    const collected = rows.reduce((sum, o) => sum + o.collectedMinor, 0);
    const prior = COLLECTION_PRIORS[bucket];
    byBucket[bucket] =
      (collected + prior * priorWeightMinor) / (billed + priorWeightMinor);
    // "Learned" means history is the MAJORITY of the estimate. Below that the
    // number is mostly the prior wearing the org's clothes, and calling it
    // learned would overstate the forecast's confidence.
    if (billed >= priorWeightMinor) learned.push(bucket);
  }

  return {
    byBucket,
    lowConfidence: learned.length < Object.keys(COLLECTION_PRIORS).length,
    learned,
  };
}

export interface ForecastInflowItem {
  dueDate: string;
  amountMinor: number;
  bucket: keyof typeof COLLECTION_PRIORS;
}

export interface ForecastOutflowItem {
  /** `YYYY-MM-DD`. A fixed cost's recurrence is expanded by the caller. */
  on: string;
  amountMinor: number;
}

export interface ForecastScenarioPoint {
  date: string;
  inflowMinor: number;
  outflowMinor: number;
  balanceMinor: number;
}

export interface ForecastScenario {
  key: "low" | "base" | "high";
  points: ForecastScenarioPoint[];
  /** The lowest balance this scenario reaches, and when. Drives `cash_runway_low`. */
  troughMinor: number;
  troughOn: string | null;
}

export interface ForecastInput {
  /** Day 0 of the horizon, `YYYY-MM-DD`. */
  from: string;
  horizonDays: number;
  openingBalanceMinor: number;
  scheduled: readonly ForecastInflowItem[];
  outflows: readonly ForecastOutflowItem[];
  probabilities: CollectionProbabilities;
  /** Per-day expected new sales, already run-rated. */
  newSalesPerDayMinor: number;
  /** Day-of-month seasonality, 1 = ordinary. Indexed 1-31. */
  seasonality?: Record<number, number>;
  /**
   * §12.2: the low/high band comes from the 25th/75th percentile of the org's
   * own historical collection variance, as a MULTIPLIER on expected inflow.
   * Defaults to ±20% - wide, honestly labelled, and replaced by measured
   * values as soon as there is history to measure.
   */
  varianceBand?: { low: number; high: number };
}

/**
 * §12.2's forecast, as three scenarios.
 *
 *     expected_inflow(day)  = Σ schedule.amount × P(collected | bucket)
 *                           + new_sales_run_rate × seasonality_index
 *     expected_outflow(day) = scheduled costs
 *     projected_balance(d)  = opening + Σ inflow − Σ outflow
 *
 * ── THE SCENARIOS SCALE THE UNCERTAIN HALF ONLY ────────────────────────────
 *
 * The low scenario multiplies INFLOW by the low band and leaves outflow alone.
 * That is deliberate and it is not symmetry for its own sake: rent is going to
 * be paid whatever happens, and a "low" scenario that also assumed costs come
 * in low would be the pleasant kind of pessimism that never warns anybody.
 */
export function forecast(input: ForecastInput): ForecastScenario[] {
  const band = input.varianceBand ?? { low: 0.8, high: 1.2 };
  const scenarios: { key: "low" | "base" | "high"; factor: number }[] = [
    { key: "low", factor: band.low },
    { key: "base", factor: 1 },
    { key: "high", factor: band.high },
  ];

  const days = Array.from({ length: input.horizonDays }, (_, i) => addDays(input.from, i));
  const dueByDay = new Map<string, number>();
  for (const item of input.scheduled) {
    const p = input.probabilities.byBucket[item.bucket] ?? 0;
    dueByDay.set(item.dueDate, (dueByDay.get(item.dueDate) ?? 0) + item.amountMinor * p);
  }
  const outByDay = new Map<string, number>();
  for (const item of input.outflows) {
    outByDay.set(item.on, (outByDay.get(item.on) ?? 0) + item.amountMinor);
  }

  return scenarios.map(({ key, factor }) => {
    let balance = input.openingBalanceMinor;
    let troughMinor = balance;
    let troughOn: string | null = null;
    const points: ForecastScenarioPoint[] = [];

    for (const date of days) {
      const dayOfMonth = Number(date.slice(8, 10));
      const season = input.seasonality?.[dayOfMonth] ?? 1;
      const inflow = Math.round(
        ((dueByDay.get(date) ?? 0) + input.newSalesPerDayMinor * season) * factor,
      );
      const outflow = outByDay.get(date) ?? 0;
      balance += inflow - outflow;
      if (balance < troughMinor) {
        troughMinor = balance;
        troughOn = date;
      }
      points.push({ date, inflowMinor: inflow, outflowMinor: outflow, balanceMinor: balance });
    }
    return { key, points, troughMinor, troughOn };
  });
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * §12.2's runway: cash divided by average monthly net burn.
 *
 * Null when the business is cash-POSITIVE, and that is the important case:
 * dividing by a negative burn yields a negative runway, which a dashboard
 * would print as "-14 months". A business that is making money has no runway
 * problem, and the honest rendering of that is "—", not a negative number.
 */
export function runwayMonths(cashMinor: number, netBurnPerMonthMinor: number): number | null {
  if (netBurnPerMonthMinor <= 0) return null;
  return cashMinor / netBurnPerMonthMinor;
}

/**
 * §12.6's finance health score, 0-100, with every component visible.
 *
 * ── WHY THE WEIGHTS ARE AN ARGUMENT AND THE COMPONENTS ARE RETURNED ────────
 *
 * §12.6 requires that "weights and each component are visible on screen". A
 * single number that cannot be taken apart is a number nobody can act on: an
 * owner seeing 62 needs to know whether it is the DSO or the leakage, and a
 * score computed inline in a dashboard query could never tell them.
 *
 * Each component is normalised to 0-1 with an explicit "good" target, so the
 * score says "how close to healthy", not "how big".
 */
export interface HealthInputs {
  /** 0-1. collected ÷ billed. */
  collectionRate: number | null;
  /** 0-1. (collected − costs) ÷ collected. May be negative. */
  netMargin: number | null;
  /** Months. Null = cash-positive, which scores full marks. */
  runwayMonths: number | null;
  /** 0-1. ₹ at risk in open alerts ÷ collected. Lower is better. */
  leakageRatio: number | null;
  /** Days. Lower is better. */
  dso: number | null;
}

export const HEALTH_WEIGHTS = {
  collectionRate: 0.3,
  netMargin: 0.25,
  runway: 0.2,
  leakage: 0.15,
  dso: 0.1,
} as const;

/** The value of each component that scores 100. Stated, so the score is arguable. */
export const HEALTH_TARGETS = {
  /** Collect 95% of what you billed. */
  collectionRate: 0.95,
  /** 20% net margin. */
  netMargin: 0.2,
  /** Six months of runway. */
  runwayMonths: 6,
  /** Nothing leaking. Anything at 10% of revenue scores zero. */
  leakageRatioZero: 0.1,
  /** Collect in 30 days; 90 days scores zero. */
  dsoGood: 30,
  dsoZero: 90,
} as const;

export interface HealthComponent {
  key: keyof typeof HEALTH_WEIGHTS;
  label: string;
  /** Raw input, for the screen. */
  value: number | null;
  /** 0-1 after normalising against the target. Null when not measurable. */
  normalised: number | null;
  weight: number;
}

export interface HealthScore {
  /** 0-100, or null when nothing was measurable at all. */
  score: number | null;
  components: HealthComponent[];
  /** Weight that was dropped because its component could not be measured. */
  unmeasuredWeight: number;
}

export function healthScore(inputs: HealthInputs): HealthScore {
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);

  const components: HealthComponent[] = [
    {
      key: "collectionRate",
      label: "Collection rate",
      value: inputs.collectionRate,
      normalised:
        inputs.collectionRate === null
          ? null
          : clamp(inputs.collectionRate / HEALTH_TARGETS.collectionRate),
      weight: HEALTH_WEIGHTS.collectionRate,
    },
    {
      key: "netMargin",
      label: "Net margin",
      value: inputs.netMargin,
      normalised:
        inputs.netMargin === null ? null : clamp(inputs.netMargin / HEALTH_TARGETS.netMargin),
      weight: HEALTH_WEIGHTS.netMargin,
    },
    {
      key: "runway",
      label: "Runway",
      value: inputs.runwayMonths,
      // Null runway is cash-POSITIVE (see `runwayMonths`), which is the best
      // possible state - so it scores 1, not "unmeasured". Getting this
      // backwards would penalise the healthiest businesses.
      normalised:
        inputs.runwayMonths === null
          ? 1
          : clamp(inputs.runwayMonths / HEALTH_TARGETS.runwayMonths),
      weight: HEALTH_WEIGHTS.runway,
    },
    {
      key: "leakage",
      label: "Money at risk",
      value: inputs.leakageRatio,
      normalised:
        inputs.leakageRatio === null
          ? null
          : clamp(1 - inputs.leakageRatio / HEALTH_TARGETS.leakageRatioZero),
      weight: HEALTH_WEIGHTS.leakage,
    },
    {
      key: "dso",
      label: "Days to collect",
      value: inputs.dso,
      normalised:
        inputs.dso === null
          ? null
          : clamp(
              (HEALTH_TARGETS.dsoZero - inputs.dso) /
                (HEALTH_TARGETS.dsoZero - HEALTH_TARGETS.dsoGood),
            ),
      weight: HEALTH_WEIGHTS.dso,
    },
  ];

  const measured = components.filter((c) => c.normalised !== null);
  const totalWeight = measured.reduce((sum, c) => sum + c.weight, 0);
  const unmeasuredWeight = 1 - totalWeight;

  // Re-normalise over what COULD be measured rather than scoring a missing
  // component as zero. A new tenant with no cost data would otherwise read 55
  // out of 100 for having entered nothing, and would reasonably conclude the
  // score is meaningless.
  const score =
    totalWeight === 0
      ? null
      : Math.round(
          (measured.reduce((sum, c) => sum + (c.normalised ?? 0) * c.weight, 0) / totalWeight) *
            100,
        );

  return { score, components, unmeasuredWeight };
}
