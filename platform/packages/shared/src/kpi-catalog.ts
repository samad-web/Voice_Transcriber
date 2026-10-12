import { z } from "zod";

/**
 * The KPI catalogue: what an owner may choose to be measured on.
 *
 * `Build docs/41_TELECALLER_PERFORMANCE_KPI_SPINE.md` Part F1, built for the
 * API-only tier (`Build docs/no-crm-api-dashboard-build-plan.md` §7, M4) and
 * shared with the CRM tier. Migration 0191 holds the owner's choices; this
 * holds the formulas.
 *
 * ── WHY THIS IS CODE AND NOT A TABLE ────────────────────────────────────────
 *
 * The no-CRM spec's §10 puts `kpi_catalog` in the database. Doc 41 F1 refuses
 * and this file follows it: a KPI's definition is a numerator, a denominator
 * and a source predicate - SQL that has to ship with the code that runs it. A
 * tenant-editable formula is an injection surface, and a tenant-editable row
 * *pointing at* code is two places to keep in step. Vocabulary belongs in
 * tables (`call_dispositions`, `call_sops`); formulas belong here, next to the
 * derivations that already live in this package.
 *
 * ── EVERY KPI IS A RATIO OF TWO ADDITIVE MEASURES, AND THAT IS NOT A STYLE ──
 *
 * `kpi_snapshots` stores a numerator and a denominator per day, never a rate,
 * so that a week is `Σnum ÷ Σden` (doc 41 G1). That identity only holds if
 * both measures are additive over days. A median is not: the median of seven
 * daily medians is not the week's median, and summing them is nonsense.
 *
 * So the catalogue is **closed under addition**: every entry names two
 * measures from `DAILY_MEASURES` below, and every measure is a `count` or a
 * `sum`. Nothing percentile-shaped is selectable.
 *
 * That is a real exclusion and it costs something: `median_idle_gap`, which
 * doc 41 lists under Activity, is NOT here. §8.3 of the no-CRM spec does ask
 * for medians and 90th percentiles "not just averages" - those are computed
 * directly from the facts on the telecaller drill-down, as display statistics,
 * where there is one window and one query and the arithmetic is sound. They
 * are statistics, not KPIs: nobody's score depends on them, so nothing needs
 * them to be summable.
 *
 * If a percentile ever must become scorable, the honest change is a
 * `additive: false` flag plus a read path that recomputes from facts for the
 * requested window - not a snapshot row that gets summed.
 *
 * ── WHAT IS DELIBERATELY NOT IN THE CATALOGUE YET ───────────────────────────
 *
 * Doc 41 F1 lists seven more that read Aura's own tables rather than the
 * ingested facts: `sop_adherence`, `consent_rate`, `sentiment_index`,
 * `first_response_minutes`, `followup_compliance` (user-keyed), `sla_breaches`
 * and `unanswered_leads`. They are named in `PLANNED_KPIS` and not offered,
 * because an entry an owner can select that then always answers `null` is
 * worse than an absent one. Adding each is: a measure in `DAILY_MEASURES`, the
 * SQL for it in the engine, and an entry here.
 */

export const KpiCategory = z.enum(["activity", "quality", "result", "discipline"]);
export type KpiCategory = z.infer<typeof KpiCategory>;

/**
 * Which identity the KPI lives on - doc 41 D3.
 *
 * `telecallers.user_id` is nullable: a person on the floor may have no login.
 * A `user`-keyed KPI (one computed from tasks, which belong to a user) simply
 * cannot be computed for such a person, and the wizard says how many that is
 * rather than averaging the gap away. `kpi_snapshots` keys on
 * `(subject_kind, subject_id)` for exactly this reason.
 */
export const KpiIdentity = z.enum(["telecaller", "user"]);
export type KpiIdentity = z.infer<typeof KpiIdentity>;

/**
 * `direction` is a property of the METRIC, not a tenant's choice.
 *
 * Doc 41 F1: the original plan made it configurable, which would let a
 * workspace declare that fewer complaints is worse. There is no owner-facing
 * control for this and there must not be one.
 */
export const KpiDirection = z.enum(["higher", "lower"]);
export type KpiDirection = z.infer<typeof KpiDirection>;

export const KpiUnit = z.enum(["count", "percent", "seconds", "currency", "ratio"]);
export type KpiUnit = z.infer<typeof KpiUnit>;

/**
 * Where the KPI's inputs come from.
 *
 * `fact`   - only the ingested fact tables (0190). Offered to every tier.
 * `native` - only Aura's own tables. Never offered to the API-only tier.
 * `either` - computable from both, preferring the richer source per entry.
 *
 * This single field is what lets one engine serve both tiers, and it is why
 * the no-CRM tier needed no second catalogue.
 */
export const KpiSource = z.enum(["fact", "native", "either"]);
export type KpiSource = z.infer<typeof KpiSource>;

/**
 * The additive measures the engine computes once per subject per day.
 *
 * The engine runs ONE aggregate per subject-kind per org per day window and
 * then fans those columns out into snapshot rows. A KPI is a pair of names
 * from this list, which is what keeps "add a KPI" from meaning "add a query".
 *
 * `_known` measures are the honest denominators. `connect_known` counts calls
 * where the customer actually told us whether it connected - so a tenant that
 * never sends `connected` gets `connect_rate` suppressed with a reason, rather
 * than 0% over every call, which would read as a catastrophe rather than as a
 * missing field. Doc 41 D2.
 */
export const DAILY_MEASURES = [
  "calls",
  "connected_calls",
  "connect_known",
  "talk_seconds",
  "talk_sample",
  "duration_seconds",
  "dispositioned_calls",
  "distinct_leads",
  "conversions",
  "won_minor",
  "collected_minor",
  "qa_score_sum",
  "qa_max_sum",
  "qa_reviews",
  "present_days",
  "active_days",
] as const;

export const DailyMeasure = z.enum(DAILY_MEASURES);
export type DailyMeasure = z.infer<typeof DailyMeasure>;

export interface KpiSpec {
  key: string;
  label: string;
  /** One line an owner reads while choosing. Plain words, no jargon. */
  blurb: string;
  category: KpiCategory;
  identity: KpiIdentity;
  direction: KpiDirection;
  unit: KpiUnit;
  source: KpiSource;
  numerator: DailyMeasure;
  /** Absent for a count KPI: `calls_made` has no denominator. */
  denominator?: DailyMeasure;
  /**
   * The D2 floor. Below this many in the denominator over the window, the KPI
   * answers `null` - "not enough to say" - rather than a rate computed from
   * three calls. A count KPI has no floor, because a count of 2 is just 2.
   */
  minBase?: number;
  /**
   * What the customer has to send for this to work, in their words, for the
   * wizard's "Data needed" line (§7 and §8.5). The field names are the
   * ingestion API's, so an integrator can act on it without a translation.
   */
  dataNeeded: string;
  /**
   * The fact columns whose presence the "ready / partial / missing data"
   * status is computed from. A measure is `partial` when some rows have it
   * and some do not, which is the common and confusing case - half a dialer's
   * calls carrying `connected` and half not.
   */
  requires: { table: string; column?: string }[];
}

export const KPI_CATALOG: KpiSpec[] = [
  // ── Activity ──────────────────────────────────────────────────────────────
  {
    key: "calls_made",
    label: "Calls made",
    blurb: "How many calls this person made or took.",
    category: "activity",
    identity: "telecaller",
    direction: "higher",
    unit: "count",
    source: "either",
    numerator: "calls",
    dataNeeded: "Calls, with started_at and telecaller_external_id.",
    requires: [{ table: "insights_calls" }],
  },
  {
    key: "connect_rate",
    label: "Connect rate",
    blurb: "Of the calls where you told us the outcome, how many reached a person.",
    category: "activity",
    identity: "telecaller",
    direction: "higher",
    unit: "percent",
    source: "either",
    numerator: "connected_calls",
    denominator: "connect_known",
    minBase: 10,
    dataNeeded: "`connected: true | false` on each call. Calls without it are left out of both sides.",
    requires: [{ table: "insights_calls", column: "connected" }],
  },
  {
    key: "talk_time",
    label: "Talk time",
    blurb: "Total seconds actually spent talking.",
    category: "activity",
    identity: "telecaller",
    direction: "higher",
    unit: "seconds",
    source: "either",
    numerator: "talk_seconds",
    dataNeeded: "`talk_time_sec` on each call. Falls back to nothing - duration is not talk time.",
    requires: [{ table: "insights_calls", column: "talk_time_sec" }],
  },
  {
    key: "calls_per_active_day",
    label: "Calls per working day",
    blurb: "Volume per day actually worked, so a week off does not look like a slump.",
    category: "activity",
    identity: "telecaller",
    direction: "higher",
    unit: "ratio",
    source: "either",
    numerator: "calls",
    denominator: "active_days",
    minBase: 3,
    dataNeeded: "Nothing beyond calls. A day with at least one call counts as worked.",
    requires: [{ table: "insights_calls" }],
  },

  // ── Quality ───────────────────────────────────────────────────────────────
  {
    key: "qa_score",
    label: "Quality score",
    blurb: "What your own reviewers scored this person's calls. No AI is involved.",
    category: "quality",
    identity: "telecaller",
    direction: "higher",
    unit: "percent",
    source: "fact",
    numerator: "qa_score_sum",
    denominator: "qa_max_sum",
    // One review is a real data point about one call, and a floor of 5 would
    // hide a new hire's only feedback. The floor is on reviews, not on the
    // points - which is why the denominator here is `qa_max_sum` but the base
    // the engine checks is `qa_reviews`. See `minBaseMeasure` below.
    minBase: 1,
    dataNeeded: "POST /v1/quality-scores with `score` and `max_score`.",
    requires: [{ table: "insights_quality_reviews" }],
  },

  // ── Result ────────────────────────────────────────────────────────────────
  {
    key: "leads_worked",
    label: "People worked",
    blurb: "How many distinct people this person called, however many times each.",
    category: "result",
    identity: "telecaller",
    direction: "higher",
    unit: "count",
    source: "either",
    numerator: "distinct_leads",
    dataNeeded: "`lead_ref` on each call - your own id for whoever was called.",
    requires: [{ table: "insights_calls", column: "lead_ref" }],
  },
  {
    key: "conversion_rate",
    label: "Conversion rate",
    blurb: "Of the people this person worked, how many converted.",
    category: "result",
    identity: "telecaller",
    direction: "higher",
    unit: "percent",
    source: "either",
    numerator: "conversions",
    denominator: "distinct_leads",
    minBase: 5,
    dataNeeded: "POST /v1/conversions, plus `lead_ref` on calls so there is a base to divide by.",
    requires: [{ table: "insights_conversions" }, { table: "insights_calls", column: "lead_ref" }],
  },
  {
    key: "won_value",
    label: "Value closed",
    blurb: "What this person's conversions were worth when they closed.",
    category: "result",
    identity: "telecaller",
    direction: "higher",
    unit: "currency",
    source: "either",
    numerator: "won_minor",
    dataNeeded: "`value_minor` and `currency` on each conversion.",
    requires: [{ table: "insights_conversions", column: "value_minor" }],
  },
  {
    key: "collected_value",
    label: "Value collected",
    blurb: "What was actually received against those conversions, which is not the same number.",
    category: "result",
    identity: "telecaller",
    direction: "higher",
    unit: "currency",
    source: "either",
    numerator: "collected_minor",
    dataNeeded: "POST /v1/payments. Growth and above.",
    requires: [{ table: "insights_payments" }],
  },

  // ── Discipline ────────────────────────────────────────────────────────────
  {
    key: "dispositioned_rate",
    label: "Outcome recorded",
    blurb: "How many calls ended with an outcome written down. Every other number depends on this one.",
    category: "discipline",
    identity: "telecaller",
    direction: "higher",
    unit: "percent",
    source: "either",
    numerator: "dispositioned_calls",
    denominator: "calls",
    minBase: 10,
    dataNeeded: "`disposition` on each call, or POST /v1/dispositions afterwards.",
    requires: [{ table: "insights_calls", column: "disposition" }],
  },
  {
    key: "attendance_present_days",
    label: "Days present",
    blurb: "Days this person was on the floor.",
    category: "discipline",
    identity: "telecaller",
    direction: "higher",
    unit: "count",
    source: "either",
    numerator: "present_days",
    dataNeeded: "POST /v1/attendance, or the Aura app's own attendance if you run it.",
    requires: [{ table: "insights_attendance" }],
  },
];

/**
 * Doc 41 F1's remaining seven, named so the next person does not have to
 * re-derive the list - and so nobody concludes they were forgotten.
 *
 * Each needs Aura's own tables, which an API-only tenant does not fill:
 * `call_sops`, `calls.consent_status`, the AI analysis, `leads`, `tasks` and
 * the SLA rollups respectively. All are `source: "native"` when they land, and
 * `followup_compliance` is the first `identity: "user"` entry - which is the
 * one that makes doc 41 D3's wizard warning about logins load-bearing.
 */
export const PLANNED_KPIS = [
  "sop_adherence",
  "consent_rate",
  "sentiment_index",
  "first_response_minutes",
  "followup_compliance",
  "sla_breaches",
  "unanswered_leads",
] as const;

export const KpiKey = z.enum([
  "calls_made",
  "connect_rate",
  "talk_time",
  "calls_per_active_day",
  "qa_score",
  "leads_worked",
  "conversion_rate",
  "won_value",
  "collected_value",
  "dispositioned_rate",
  "attendance_present_days",
]);
export type KpiKey = z.infer<typeof KpiKey>;

const BY_KEY = new Map(KPI_CATALOG.map((k) => [k.key, k]));

export function kpiSpec(key: string): KpiSpec | null {
  return BY_KEY.get(key) ?? null;
}

/** Throws rather than returning undefined - see `entitlementSpec` for why. */
export function requireKpiSpec(key: string): KpiSpec {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`unknown KPI: ${key}`);
  return spec;
}

/**
 * Which measure the `minBase` floor is checked against.
 *
 * Usually the denominator. `qa_score` is the exception: its denominator is a
 * sum of POINTS (`qa_max_sum`), so a floor of 1 against it would mean "one
 * point of rubric", which is meaningless. The floor belongs on the number of
 * REVIEWS. Rather than a special case in the engine, the rule is stated here:
 * a KPI whose denominator is a sum of magnitudes declares the count that
 * stands in for its base.
 */
const MIN_BASE_MEASURE: Record<string, DailyMeasure> = {
  qa_score: "qa_reviews",
};

export function minBaseMeasure(spec: KpiSpec): DailyMeasure | null {
  return MIN_BASE_MEASURE[spec.key] ?? spec.denominator ?? null;
}

/** The KPIs offerable to a tenant, given what their tier can source. */
export function kpisForSources(available: readonly KpiSource[]): KpiSpec[] {
  const set = new Set(available);
  return KPI_CATALOG.filter((k) => set.has(k.source) || k.source === "either");
}

/** What the API-only tier offers: facts, and anything that works from either. */
export const FACT_KPIS = kpisForSources(["fact"]);

/**
 * The default bands (doc 41 F3), seeded for an org the first time it saves a
 * KPI config rather than by the migration.
 *
 * Three bands, half-open and in order, so every achievement lands in exactly
 * one with no gap and no overlap. `tone` is a palette name and NOT `danger`:
 * the console's standing rule is that red means MISSED and orange means
 * ERROR, and a person behind pace is neither a missed call nor a system fault.
 */
export const DEFAULT_KPI_BANDS = [
  { bandKey: "needs_support", label: "Needs support", minPct: 0, maxPct: 60, tone: "attention", sort: 1 },
  { bandKey: "on_track", label: "On track", minPct: 60, maxPct: 90, tone: "steady", sort: 2 },
  { bandKey: "excellent", label: "Excellent", minPct: 90, maxPct: null, tone: "strong", sort: 3 },
] as const;

/**
 * §8.5 and §7: can this tenant actually compute this KPI from what they have
 * sent us?
 *
 * `ready`   - every required column is present on a healthy majority of rows.
 * `partial` - the table has rows but the column is missing on some of them.
 *             This is the common and confusing case and it gets its own word,
 *             because "ready" would be a lie and "missing" would be wrong.
 * `missing` - no rows at all in a required table, or the column never set.
 *
 * The threshold is deliberately generous: a dialer that fails to send
 * `connected` on 5% of calls has a usable connect rate, and calling that
 * "partial" on the setup screen would teach an owner to ignore the status.
 */
export const KpiDataStatus = z.enum(["ready", "partial", "missing"]);
export type KpiDataStatus = z.infer<typeof KpiDataStatus>;

/** A row is `partial` below this fraction of coverage, `ready` at or above. */
export const KPI_COVERAGE_READY = 0.9;

export interface ColumnCoverage {
  table: string;
  /** Total rows the tenant has sent, in the window the status was measured over. */
  rows: number;
  /** Rows where the column is non-null. Equal to `rows` when no column is required. */
  present: number;
  column?: string;
}

export function kpiDataStatus(spec: KpiSpec, coverage: ColumnCoverage[]): KpiDataStatus {
  const relevant = spec.requires.map((req) =>
    coverage.find((c) => c.table === req.table && c.column === req.column),
  );
  // A requirement we have no measurement for is `missing`, not `ready`. The
  // fail-closed direction: telling an owner a KPI is ready when we have not
  // looked is how a dashboard ends up showing a dash they were promised a
  // number for.
  if (relevant.some((c) => !c || c.rows === 0)) return "missing";
  const worst = Math.min(...relevant.map((c) => (c!.rows === 0 ? 0 : c!.present / c!.rows)));
  if (worst === 0) return "missing";
  return worst >= KPI_COVERAGE_READY ? "ready" : "partial";
}
