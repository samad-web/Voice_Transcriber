import {
  AGING_BUCKETS,
  RESPONSE_BUCKETS,
  agingBucket,
  compliancePct,
  mean,
  median,
  overdueDays,
  pctOf,
  responseBucket,
  tally,
} from "./sla";

/**
 * These are the definitions a manager reads next to a person's name, so the
 * edge cases below are the point of the file rather than padding: "no tasks
 * were due" must not render as 0% compliance, and a lead nobody answered must
 * not quietly improve the average.
 */

describe("responseBucket", () => {
  it("puts an unanswered lead in `never`, not in the slowest bucket", () => {
    // The whole reason `never` exists: dropping these, or filing them under
    // "over 24 hours", both make ignoring a lead look like slow service.
    expect(responseBucket(null)).toBe("never");
    expect(responseBucket(Number.NaN)).toBe("never");
    expect(responseBucket(Number.POSITIVE_INFINITY)).toBe("never");
  });

  it("is inclusive at each upper boundary", () => {
    expect(responseBucket(5)).toBe("under_5m");
    expect(responseBucket(5.1)).toBe("under_30m");
    expect(responseBucket(30)).toBe("under_30m");
    expect(responseBucket(30.5)).toBe("under_1h");
    expect(responseBucket(60)).toBe("under_1h");
    expect(responseBucket(61)).toBe("under_4h");
    expect(responseBucket(240)).toBe("under_4h");
    expect(responseBucket(1440)).toBe("under_24h");
    expect(responseBucket(1441)).toBe("over_24h");
  });

  it("treats a clock-skewed negative response as instant, never as negative", () => {
    // The migration guards against this at write time; if one still arrives,
    // "-3 minutes" must not reach a report.
    expect(responseBucket(0)).toBe("under_5m");
    expect(responseBucket(-90)).toBe("under_5m");
  });

  it("keeps every key unique so a tally cannot silently merge two buckets", () => {
    const keys = RESPONSE_BUCKETS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("agingBucket", () => {
  it("matches the published boundaries", () => {
    expect(agingBucket(0)).toBe("d0_3");
    expect(agingBucket(3)).toBe("d0_3");
    expect(agingBucket(4)).toBe("d4_7");
    expect(agingBucket(7)).toBe("d4_7");
    expect(agingBucket(8)).toBe("d8_15");
    expect(agingBucket(15)).toBe("d8_15");
    expect(agingBucket(16)).toBe("d16_30");
    expect(agingBucket(30)).toBe("d16_30");
    expect(agingBucket(31)).toBe("d30_plus");
    expect(agingBucket(4000)).toBe("d30_plus");
  });

  it("floors a partial day rather than rounding it up", () => {
    // A lead created 3.9 days ago is in its fourth day but has not completed
    // it. Rounding up would move a card into "4-7 days" a whole day early.
    expect(agingBucket(3.9)).toBe("d0_3");
    expect(agingBucket(-2)).toBe("d0_3");
  });

  it("covers every day with exactly one bucket", () => {
    for (let d = 0; d <= 400; d++) {
      const key = agingBucket(d);
      const hit = AGING_BUCKETS.filter(
        (b) => d >= b.minDays && (b.maxDays === null || d <= b.maxDays),
      );
      expect(hit).toHaveLength(1);
      expect(hit[0].key).toBe(key);
    }
  });
});

describe("compliancePct", () => {
  it("returns null when nothing was due, rather than 0%", () => {
    // "No tasks were due" and "every task was missed" are opposite facts.
    expect(compliancePct({ completed: 0, overdue: 0, pending: 0 })).toBeNull();
    expect(compliancePct({ completed: 0, overdue: 0, pending: 12 })).toBeNull();
  });

  it("excludes not-yet-due work from the denominator", () => {
    // A rep who plans a week ahead must not score worse for it.
    expect(compliancePct({ completed: 1, overdue: 1, pending: 0 })).toBe(50);
    expect(compliancePct({ completed: 1, overdue: 1, pending: 98 })).toBe(50);
  });

  it("reports the honest extremes", () => {
    expect(compliancePct({ completed: 0, overdue: 7, pending: 0 })).toBe(0);
    expect(compliancePct({ completed: 7, overdue: 0, pending: 0 })).toBe(100);
  });

  it("rounds to one decimal", () => {
    expect(compliancePct({ completed: 1, overdue: 2, pending: 0 })).toBe(33.3);
  });
});

describe("overdueDays", () => {
  it("counts whole days past due and never goes negative", () => {
    expect(overdueDays("2026-09-01", "2026-09-08")).toBe(7);
    expect(overdueDays("2026-09-08", "2026-09-08")).toBe(0);
    expect(overdueDays("2026-09-20", "2026-09-08")).toBe(0);
  });

  it("survives a malformed date instead of emitting NaN into a report", () => {
    expect(overdueDays("not-a-date", "2026-09-08")).toBe(0);
  });
});

describe("median / mean", () => {
  it("is null on no data", () => {
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
  });

  it("averages the middle pair on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
  });

  it("is why the median is the headline and the mean is not", () => {
    // One lead answered three weeks late. The median holds; the mean does not.
    const withOutlier = [2, 3, 4, 5, 30000];
    expect(median(withOutlier)).toBe(4);
    expect(mean(withOutlier)).toBe(6002.8);
  });
});

describe("pctOf", () => {
  it("is null rather than 0 when there is no basis", () => {
    expect(pctOf(0, 0)).toBeNull();
    expect(pctOf(3, 4)).toBe(75);
  });
});

describe("tally", () => {
  const defs = [
    { key: "a" as const, label: "A" },
    { key: "b" as const, label: "B" },
  ];

  it("renders empty buckets as real zeroes", () => {
    // An aging chart that drops its empty tail looks identical to one that was
    // never built.
    expect(tally(defs, ["a", "a"])).toEqual([
      { key: "a", label: "A", count: 2, pct: 100 },
      { key: "b", label: "B", count: 0, pct: 0 },
    ]);
  });

  it("keeps the definition order, not first-seen order", () => {
    expect(tally(defs, ["b", "a"]).map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("gives null percentages when there is nothing to divide by", () => {
    expect(tally(defs, []).every((r) => r.pct === null)).toBe(true);
  });
});

describe("agingBucketFilters", () => {
  it("emits one aliased count per bucket, in the same order", async () => {
    const { AGING_BUCKETS, agingBucketFilters } = await import("./sla");
    const sql = agingBucketFilters("age_days");
    for (const b of AGING_BUCKETS) {
      expect(sql).toContain(`AS ${b.key}`);
    }
    // The dashboard reads these aliases positionally into its own tile list;
    // a reordering here would relabel every tile silently.
    const order = AGING_BUCKETS.map((b) => sql.indexOf(`AS ${b.key}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("draws the boundaries where agingBucket() draws them", async () => {
    const { AGING_BUCKETS, agingBucketFilters } = await import("./sla");
    const sql = agingBucketFilters("age_days");
    // The whole reason this generator exists: one definition, so a dashboard
    // tile and the report it links to cannot disagree about where "8-15 days"
    // ends. If somebody edits AGING_BUCKETS, both move together or this fails.
    for (const b of AGING_BUCKETS) {
      if (b.maxDays === null) expect(sql).toContain(`age_days >= ${b.minDays}`);
      else expect(sql).toContain(`age_days BETWEEN ${b.minDays} AND ${b.maxDays}`);
    }
  });

  it("leaves no gap and no overlap between consecutive buckets", async () => {
    const { AGING_BUCKETS } = await import("./sla");
    for (let i = 1; i < AGING_BUCKETS.length; i++) {
      const previous = AGING_BUCKETS[i - 1];
      // A gap means a lead counted nowhere; an overlap means one counted
      // twice. Either makes the tiles stop summing to the total beside them.
      expect(AGING_BUCKETS[i].minDays).toBe((previous.maxDays ?? 0) + 1);
    }
  });
});
