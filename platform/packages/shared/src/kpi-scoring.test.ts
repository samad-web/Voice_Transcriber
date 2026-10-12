import { describe, expect, it } from "vitest";
import {
  DAILY_MEASURES,
  DEFAULT_KPI_BANDS,
  KPI_CATALOG,
  KpiKey,
  kpiDataStatus,
  minBaseMeasure,
  requireKpiSpec,
} from "./kpi-catalog";
import {
  ACHIEVEMENT_CAP,
  achievement,
  bandFor,
  compositeScore,
  effectiveTarget,
  hasEnoughBase,
  paceVerdict,
  periodDays,
  suppressionReason,
  unitProrates,
  windowTarget,
  windowValue,
  type SnapshotRow,
} from "./kpi-scoring";

const BANDS = DEFAULT_KPI_BANDS.map((b) => ({ ...b }));

function rows(spec: { numerator: number; denominator: number | null }[]): SnapshotRow[] {
  return spec.map((r, i) => ({
    kpiKey: "connect_rate",
    day: `2026-10-0${i + 1}`,
    numerator: r.numerator,
    denominator: r.denominator,
    targetValue: null,
    targetPeriod: null,
    weightPct: null,
  }));
}

describe("KPI catalogue", () => {
  it("names only measures the engine computes", () => {
    const known = new Set<string>(DAILY_MEASURES);
    for (const spec of KPI_CATALOG) {
      expect([spec.key, known.has(spec.numerator)]).toEqual([spec.key, true]);
      if (spec.denominator) {
        expect([spec.key, known.has(spec.denominator)]).toEqual([spec.key, true]);
      }
    }
  });

  it("keeps the key enum and the catalogue in step", () => {
    expect(KPI_CATALOG.map((k) => k.key).sort()).toEqual([...KpiKey.options].sort());
  });

  it("offers at least one activity and one result KPI", () => {
    // The wizard requires an owner to pick one of each, so the catalogue has
    // to be able to satisfy that. A set that was all-activity would be
    // gameable, which is the reason for the rule.
    const categories = new Set(KPI_CATALOG.map((k) => k.category));
    expect(categories.has("activity")).toBe(true);
    expect(categories.has("result")).toBe(true);
  });

  it("gives every rate KPI a floor and every count KPI none", () => {
    for (const spec of KPI_CATALOG) {
      const label = spec.key;
      if (spec.denominator) {
        expect([label, typeof spec.minBase]).toEqual([label, "number"]);
      } else {
        expect([label, spec.minBase]).toEqual([label, undefined]);
      }
    }
  });

  it("floors qa_score on reviews, not on rubric points", () => {
    // The one KPI whose denominator is a sum of magnitudes. A floor of 1
    // against `qa_max_sum` would mean "one point of rubric", which is not a
    // base at all.
    expect(minBaseMeasure(requireKpiSpec("qa_score"))).toBe("qa_reviews");
    expect(minBaseMeasure(requireKpiSpec("connect_rate"))).toBe("connect_known");
    expect(minBaseMeasure(requireKpiSpec("calls_made"))).toBeNull();
  });

  it("offers no KPI the API-only tier cannot source", () => {
    // Every entry is `fact` or `either`. A `native`-only entry would be
    // selectable by a tenant who can never fill it, which is the thing
    // PLANNED_KPIS exists to keep out of the catalogue.
    for (const spec of KPI_CATALOG) {
      expect([spec.key, spec.source]).toEqual([spec.key, expect.stringMatching(/^(fact|either)$/)]);
    }
  });
});

describe("windowValue", () => {
  it("sums numerator and denominator rather than averaging daily rates", () => {
    // The single most important assertion about this engine. A four-call
    // Saturday at 25% and a ninety-call Tuesday at 50% is 49.5% for the week,
    // not 37.5% - and 37.5% is what averaging the two rates gives.
    const spec = requireKpiSpec("connect_rate");
    const result = windowValue(rows([{ numerator: 1, denominator: 4 }, { numerator: 45, denominator: 90 }]), spec);
    expect(result.numerator).toBe(46);
    expect(result.denominator).toBe(94);
    expect(result.value).toBeCloseTo(46 / 94, 6);
    expect(result.value).not.toBeCloseTo((0.25 + 0.5) / 2, 3);
  });

  it("returns null, never zero, for a rate with nothing to divide by", () => {
    const spec = requireKpiSpec("connect_rate");
    const result = windowValue(rows([{ numerator: 0, denominator: 0 }]), spec);
    expect(result.value).toBeNull();
    expect(result.base).toBe(0);
  });

  it("totals a count KPI and reports no denominator", () => {
    const spec = requireKpiSpec("calls_made");
    const result = windowValue(rows([{ numerator: 40, denominator: null }, { numerator: 2, denominator: null }]), spec);
    expect(result).toMatchObject({ value: 42, numerator: 42, denominator: null });
  });

  it("returns a count of zero for an empty window, because zero calls is a fact", () => {
    // Deliberately NOT null. "You made no calls" is knowable and true; "your
    // connect rate was 0%" is neither.
    expect(windowValue([], requireKpiSpec("calls_made")).value).toBe(0);
    expect(windowValue([], requireKpiSpec("connect_rate")).value).toBeNull();
  });
});

describe("the minimum base", () => {
  it("suppresses a rate below its floor and explains why in words", () => {
    const spec = requireKpiSpec("connect_rate");
    expect(hasEnoughBase(spec, 9)).toBe(false);
    expect(hasEnoughBase(spec, 10)).toBe(true);

    const { suppressed, reason } = suppressionReason(spec, 3);
    expect(suppressed).toBe(true);
    // The sentence matters: a dash on a performance dashboard is read as a
    // zero unless something says otherwise, and the person being read is real.
    expect(reason).toContain("Only 3");
    expect(reason).toContain("10");
  });

  it("says 'none yet' rather than 'only 0'", () => {
    expect(suppressionReason(requireKpiSpec("connect_rate"), 0).reason).toMatch(/^No /);
  });

  it("never suppresses a count", () => {
    expect(suppressionReason(requireKpiSpec("calls_made"), 0)).toEqual({
      suppressed: false,
      reason: null,
    });
  });
});

describe("pro-rating", () => {
  it("scales a count target with the window and leaves a rate alone", () => {
    // The correction to doc 41 G2. Pro-rating a 45% connect-rate target over a
    // fortnight would give 22.5%, which every telecaller then "achieves" at
    // 200% - a composite built on that is not slightly off, it is inverted.
    const calls = requireKpiSpec("calls_made");
    const rate = requireKpiSpec("connect_rate");
    const october = new Date("2026-10-15T00:00:00Z");

    expect(unitProrates(calls.unit)).toBe(true);
    expect(unitProrates(rate.unit)).toBe(false);

    expect(effectiveTarget(calls, 620, "monthly", 15, october)).toBeCloseTo((620 * 15) / 31, 6);
    expect(effectiveTarget(rate, 0.45, "monthly", 15, october)).toBe(0.45);
  });

  it("uses the reference month's real length, not 30", () => {
    // A February target pro-rated against 30 days is 7% out, every February.
    expect(periodDays("monthly", new Date("2026-02-10T00:00:00Z"))).toBe(28);
    expect(periodDays("monthly", new Date("2024-02-10T00:00:00Z"))).toBe(29);
    expect(periodDays("monthly", new Date("2026-10-10T00:00:00Z"))).toBe(31);
    expect(periodDays("weekly", new Date("2026-10-10T00:00:00Z"))).toBe(7);
    expect(periodDays("daily", new Date("2026-10-10T00:00:00Z"))).toBe(1);
  });

  it("scales above the period target for a window longer than the period", () => {
    const calls = requireKpiSpec("calls_made");
    // 45 days of a monthly target is 1.5 months of work, and that is correct.
    const value = effectiveTarget(calls, 600, "monthly", 45, new Date("2026-10-15T00:00:00Z"));
    expect(value).toBeGreaterThan(600);
  });

  it("leaves a null target null", () => {
    expect(effectiveTarget(requireKpiSpec("calls_made"), null, "monthly", 15, new Date())).toBeNull();
  });
});

describe("windowTarget", () => {
  function day(d: string, targetValue: number | null, period: "daily" | "weekly" | "monthly" = "monthly") {
    return {
      kpiKey: "calls_made",
      day: d,
      numerator: 0,
      denominator: null,
      targetValue,
      targetPeriod: period,
      weightPct: 100,
    };
  }

  it("honours a target raised mid-window from the day it was raised", () => {
    // 500/month for the first 14 days of October, 600/month for the next 17.
    // Neither 500 nor 600 is the right answer for the window, and both are
    // what a single pro-rated number would give.
    const rows = [
      ...Array.from({ length: 14 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, 500)),
      ...Array.from({ length: 17 }, (_, i) => day(`2026-10-${String(i + 15).padStart(2, "0")}`, 600)),
    ];
    expect(windowTarget(rows, requireKpiSpec("calls_made"))).toBeCloseTo(
      (14 * 500) / 31 + (17 * 600) / 31,
      6,
    );
  });

  it("sums the days it has, so a part-month window expects part of the target", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      day(`2026-10-${String(i + 1).padStart(2, "0")}`, 620),
    );
    expect(windowTarget(rows, requireKpiSpec("calls_made"))).toBeCloseTo((620 * 10) / 31, 6);
  });

  it("takes the latest target for a rate, by day and not by array order", () => {
    // Deliberately out of order: a leaderboard query's row order is not a
    // contract, and taking the last element would silently depend on it.
    const rows = [
      { ...day("2026-10-20", 0.5), kpiKey: "connect_rate" },
      { ...day("2026-10-01", 0.45), kpiKey: "connect_rate" },
    ];
    expect(windowTarget(rows, requireKpiSpec("connect_rate"))).toBe(0.5);
  });

  it("is null when no day in the window had a target", () => {
    expect(windowTarget([day("2026-10-01", null)], requireKpiSpec("calls_made"))).toBeNull();
    expect(windowTarget([], requireKpiSpec("calls_made"))).toBeNull();
  });

  it("ignores days with no target rather than counting them as zero", () => {
    // A KPI configured from the 15th has no target on the 14th. Treating that
    // as a target of 0 would make the window's expectation too low and hand
    // everybody an achievement over 100%.
    const rows = [day("2026-10-01", null), day("2026-10-02", 310)];
    expect(windowTarget(rows, requireKpiSpec("calls_made"))).toBeCloseTo(310 / 31, 6);
  });
});

describe("achievement", () => {
  it("is actual over target, capped", () => {
    expect(achievement(45, 50, "higher")).toBeCloseTo(0.9, 6);
    expect(achievement(500, 50, "higher")).toBe(ACHIEVEMENT_CAP);
  });

  it("inverts for a lower-is-better KPI, and the cap still applies", () => {
    // Two breaches against a target of two is parity; one is better, and
    // `target / actual` = 2 is clamped to the cap like any over-delivery. The
    // cap is not a higher-is-better special case.
    expect(achievement(2, 2, "lower")).toBe(1);
    expect(achievement(3, 2, "lower")).toBeCloseTo(2 / 3, 6);
    expect(achievement(1, 2, "lower")).toBe(ACHIEVEMENT_CAP);
  });

  it("treats zero on a lower-is-better KPI as the cap, not as undefined", () => {
    // Zero breaches against a target of two is as good as it gets, and
    // `target / 0` is Infinity - which must not reach a score.
    expect(achievement(0, 2, "lower")).toBe(ACHIEVEMENT_CAP);
  });

  it("is null, never zero, with no target", () => {
    // A person with no target has not failed to meet it.
    expect(achievement(45, null, "higher")).toBeNull();
    expect(achievement(null, 50, "higher")).toBeNull();
    expect(achievement(45, 0, "higher")).toBeNull();
  });
});

describe("bands", () => {
  it("covers every achievement with exactly one band", () => {
    for (const pct of [0, 0.3, 0.599, 0.6, 0.89, 0.9, 1, 1.2]) {
      const band = bandFor(pct, BANDS);
      expect([pct, band?.bandKey]).toEqual([pct, expect.any(String)]);
    }
    expect(bandFor(0.59, BANDS)?.bandKey).toBe("needs_support");
    expect(bandFor(0.6, BANDS)?.bandKey).toBe("on_track");
    expect(bandFor(0.9, BANDS)?.bandKey).toBe("excellent");
    expect(bandFor(1.2, BANDS)?.bandKey).toBe("excellent");
  });

  it("gives no band at all to a null achievement", () => {
    // Not the lowest band. A person with no target is not "Needs support".
    expect(bandFor(null, BANDS)).toBeNull();
  });

  it("never tones the lowest band as an error", () => {
    // Red means MISSED and orange means ERROR in this console. A person behind
    // pace is neither a missed call nor a system fault.
    for (const band of BANDS) {
      expect([band.bandKey, band.tone]).toEqual([
        band.bandKey,
        expect.stringMatching(/^(neutral|attention|steady|strong)$/),
      ]);
    }
  });
});

describe("the composite", () => {
  it("weights achievements over the CONFIGURED weight, not the answered weight", () => {
    // Doc 41 G2's refusal to renormalise, and the reason: a score over 60% of
    // the set is not the same object as a score over all of it. Renormalising
    // is how a dashboard reports 94% for a rep whose three measured KPIs
    // happened to be the easy ones.
    const result = compositeScore([
      { kpiKey: "calls_made", weightPct: 40, achievement: 1 },
      { kpiKey: "connect_rate", weightPct: 20, achievement: 1 },
      { kpiKey: "conversion_rate", weightPct: 40, achievement: null },
    ]);
    expect(result.suppressed).toBe(false);
    expect(result.coverage).toBeCloseTo(0.6, 6);
    // 60, not 100 - which is what dividing by the answered weight would give.
    expect(result.score).toBeCloseTo(60, 6);
  });

  it("suppresses below the coverage floor rather than reporting a subset", () => {
    const result = compositeScore([
      { kpiKey: "calls_made", weightPct: 50, achievement: 1.2 },
      { kpiKey: "connect_rate", weightPct: 50, achievement: null },
    ]);
    expect(result).toMatchObject({ score: null, suppressed: true, reason: "below_coverage_floor" });
    expect(result.coverage).toBeCloseTo(0.5, 6);
  });

  it("carries coverage even when it does not suppress, so the page can state it", () => {
    const result = compositeScore([{ kpiKey: "calls_made", weightPct: 100, achievement: 0.8 }]);
    expect(result.coverage).toBe(1);
    expect(result.score).toBeCloseTo(80, 6);
  });

  it("distinguishes no configuration from no weights", () => {
    expect(compositeScore([]).reason).toBe("no_configuration");
    expect(
      compositeScore([{ kpiKey: "calls_made", weightPct: 0, achievement: 1 }]).reason,
    ).toBe("no_weights");
  });

  it("respects a tenant's own coverage floor", () => {
    const entries = [
      { kpiKey: "calls_made", weightPct: 50, achievement: 1 },
      { kpiKey: "connect_rate", weightPct: 50, achievement: null },
    ];
    expect(compositeScore(entries, 0.5).suppressed).toBe(false);
    expect(compositeScore(entries, 0.51).suppressed).toBe(true);
  });
});

describe("pace", () => {
  it("names where somebody stands, and says nothing when it cannot", () => {
    expect(paceVerdict(110, 100)).toBe("ahead");
    expect(paceVerdict(100, 100)).toBe("on_track");
    expect(paceVerdict(80, 100)).toBe("behind");
    expect(paceVerdict(50, 100)).toBe("at_risk");
    expect(paceVerdict(null, 100)).toBe("unknown");
    expect(paceVerdict(50, null)).toBe("unknown");
    expect(paceVerdict(50, 0)).toBe("unknown");
  });
});

describe("data-needed status", () => {
  const connect = requireKpiSpec("connect_rate");

  it("is ready when the column is on nearly every row", () => {
    expect(
      kpiDataStatus(connect, [
        { table: "insights_calls", column: "connected", rows: 1000, present: 950 },
      ]),
    ).toBe("ready");
  });

  it("is partial when some rows carry the column and some do not", () => {
    // The common, confusing case - half a dialer's calls carrying `connected`
    // and half not - and it gets its own word because "ready" would be a lie
    // and "missing" would be wrong.
    expect(
      kpiDataStatus(connect, [
        { table: "insights_calls", column: "connected", rows: 1000, present: 400 },
      ]),
    ).toBe("partial");
  });

  it("is missing with no rows, or with the column never set", () => {
    expect(
      kpiDataStatus(connect, [{ table: "insights_calls", column: "connected", rows: 0, present: 0 }]),
    ).toBe("missing");
    expect(
      kpiDataStatus(connect, [{ table: "insights_calls", column: "connected", rows: 500, present: 0 }]),
    ).toBe("missing");
  });

  it("is missing when a requirement was never measured, rather than assuming ready", () => {
    // Fail closed. Telling an owner a KPI is ready when we have not looked is
    // how a dashboard shows a dash they were promised a number for.
    expect(kpiDataStatus(connect, [])).toBe("missing");
  });

  it("takes the worst of several requirements", () => {
    const conversion = requireKpiSpec("conversion_rate");
    expect(
      kpiDataStatus(conversion, [
        { table: "insights_conversions", rows: 100, present: 100 },
        { table: "insights_calls", column: "lead_ref", rows: 1000, present: 100 },
      ]),
    ).toBe("partial");
  });
});
