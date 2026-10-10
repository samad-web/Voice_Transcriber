import { describe, expect, it } from "vitest";

import {
  addMonths,
  asDateKey,
  asFyStartMonth,
  daysInMonth,
  DEFAULT_FY_START_MONTH,
  FISCAL_UNITS,
  fiscalHalfOf,
  fiscalPeriod,
  fiscalQuarterOf,
  fiscalYearLabel,
  fiscalYearRange,
  fyStartYearOf,
  monthEnd,
  monthStart,
  monthsIntoFy,
  periodsInFiscalYear,
  periodToDate,
  previousPeriod,
  samePeriodLastYear,
} from "./fiscal";

const APRIL = DEFAULT_FY_START_MONTH;
const JANUARY = 1;

describe("the default", () => {
  it("is April, which is what §2 says the Indian financial year opens in", () => {
    expect(DEFAULT_FY_START_MONTH).toBe(4);
  });
});

describe("date-key primitives", () => {
  it("knows February's length in a leap year and out of one", () => {
    expect([daysInMonth(2024, 2), daysInMonth(2026, 2), daysInMonth(2000, 2), daysInMonth(1900, 2)]).toEqual([
      29, 28, 29, 28,
    ]);
  });

  it("clamps a month addition rather than letting the overflow run", () => {
    // 31 January + 1 month is 28 February, not 3 March.
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("crosses a year boundary in both directions", () => {
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-02-15", -3)).toBe("2025-11-15");
    expect(addMonths("2026-06-10", -12)).toBe("2025-06-10");
  });

  it("finds a month's first and last day", () => {
    expect([monthStart("2026-09-17"), monthEnd("2026-09-17")]).toEqual(["2026-09-01", "2026-09-30"]);
    expect(monthEnd("2024-02-10")).toBe("2024-02-29");
  });
});

describe("fyStartYearOf", () => {
  it("puts January to March in the financial year that opened the previous April", () => {
    // The bug this test exists for: a Q4 that reports the wrong three months.
    expect(fyStartYearOf("2027-01-15", APRIL)).toBe(2026);
    expect(fyStartYearOf("2027-03-31", APRIL)).toBe(2026);
  });

  it("flips on the first day of the start month", () => {
    expect(fyStartYearOf("2027-03-31", APRIL)).toBe(2026);
    expect(fyStartYearOf("2027-04-01", APRIL)).toBe(2027);
  });

  it("is the calendar year for a January start", () => {
    for (const d of ["2026-01-01", "2026-06-30", "2026-12-31"]) {
      expect(fyStartYearOf(d, JANUARY)).toBe(2026);
    }
  });

  it("handles a start month late in the year, where most of the FY is next year", () => {
    expect(fyStartYearOf("2026-10-01", 10)).toBe(2026);
    expect(fyStartYearOf("2026-09-30", 10)).toBe(2025);
    expect(fyStartYearOf("2027-09-30", 10)).toBe(2026);
  });
});

describe("fiscalYearRange", () => {
  it("runs 1 April to 31 March", () => {
    expect(fiscalYearRange(2026, APRIL)).toEqual({ from: "2026-04-01", to: "2027-03-31" });
  });

  it("runs the calendar year for a January start", () => {
    expect(fiscalYearRange(2026, JANUARY)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("ends on a leap 29 February for a March start", () => {
    expect(fiscalYearRange(2023, 3)).toEqual({ from: "2023-03-01", to: "2024-02-29" });
  });
});

describe("fiscalYearLabel", () => {
  it("spans two years for an April start", () => {
    expect(fiscalYearLabel(2026, APRIL)).toBe("FY 2026-27");
  });

  it("pads the second year across a century", () => {
    expect(fiscalYearLabel(2099, APRIL)).toBe("FY 2099-00");
  });

  it("names a single year when the financial year IS the calendar year", () => {
    // Otherwise a January-start tenant reads "FY 2026-27" over figures that
    // stop in December.
    expect(fiscalYearLabel(2026, JANUARY)).toBe("FY 2026");
  });
});

describe("quarters and halves", () => {
  it("matches §2's table exactly: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar", () => {
    const q = (d: string) => fiscalQuarterOf(d, APRIL);
    expect([q("2026-04-01"), q("2026-06-30")]).toEqual([1, 1]);
    expect([q("2026-07-01"), q("2026-09-30")]).toEqual([2, 2]);
    expect([q("2026-10-01"), q("2026-12-31")]).toEqual([3, 3]);
    expect([q("2027-01-01"), q("2027-03-31")]).toEqual([4, 4]);
  });

  it("splits the year in two halves", () => {
    expect([fiscalHalfOf("2026-04-01", APRIL), fiscalHalfOf("2026-09-30", APRIL)]).toEqual([1, 1]);
    expect([fiscalHalfOf("2026-10-01", APRIL), fiscalHalfOf("2027-03-31", APRIL)]).toEqual([2, 2]);
  });

  it("counts months into the financial year from zero", () => {
    expect(monthsIntoFy("2026-04-15", APRIL)).toBe(0);
    expect(monthsIntoFy("2027-03-15", APRIL)).toBe(11);
  });
});

describe("fiscalPeriod", () => {
  it("returns the WHOLE period, including days that have not happened", () => {
    // The distinction this module exists for: a filing's period is the whole
    // month even when it is generated on the 2nd.
    expect(fiscalPeriod("month", "2026-09-02", APRIL)).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-30",
      label: "September 2026",
      fyStartYear: 2026,
    });
  });

  it("gives a quarter its real three months and an FY-relative label", () => {
    expect(fiscalPeriod("quarter", "2026-08-15", APRIL)).toMatchObject({
      from: "2026-07-01",
      to: "2026-09-30",
      label: "Q2 FY 2026-27",
      fyStartYear: 2026,
    });
  });

  it("keeps a January-March quarter inside the financial year that opened in April", () => {
    expect(fiscalPeriod("quarter", "2027-02-10", APRIL)).toMatchObject({
      from: "2027-01-01",
      to: "2027-03-31",
      label: "Q4 FY 2026-27",
      fyStartYear: 2026,
    });
  });

  it("builds halves and years", () => {
    expect(fiscalPeriod("half", "2026-12-01", APRIL)).toMatchObject({
      from: "2026-10-01",
      to: "2027-03-31",
      label: "H2 FY 2026-27",
    });
    expect(fiscalPeriod("year", "2027-01-01", APRIL)).toMatchObject({
      from: "2026-04-01",
      to: "2027-03-31",
      label: "FY 2026-27",
    });
  });

  it("starts a week on Monday and leaves its financial year unclaimed", () => {
    // 2026-09-17 is a Thursday.
    expect(fiscalPeriod("week", "2026-09-17", APRIL)).toMatchObject({
      from: "2026-09-14",
      to: "2026-09-20",
      fyStartYear: null,
    });
  });

  it("treats Sunday as the last day of the week it closes, not the first", () => {
    // 2026-09-20 is a Sunday; the week it belongs to opened on the 14th.
    expect(fiscalPeriod("week", "2026-09-20", APRIL).from).toBe("2026-09-14");
  });

  it("makes a day its own period", () => {
    expect(fiscalPeriod("day", "2026-09-17", APRIL)).toMatchObject({
      from: "2026-09-17",
      to: "2026-09-17",
      label: "17 Sep 2026",
      fyStartYear: null,
    });
  });

  it("collapses onto the calendar year when the start month is January", () => {
    expect(fiscalPeriod("quarter", "2026-02-10", JANUARY)).toMatchObject({
      from: "2026-01-01",
      to: "2026-03-31",
      label: "Q1 FY 2026",
    });
    expect(fiscalPeriod("year", "2026-02-10", JANUARY)).toMatchObject({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });

  it("produces a from <= to range for every unit, in every month, under every start month", () => {
    for (let fy = 1; fy <= 12; fy += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const day = `2026-${String(m).padStart(2, "0")}-15`;
        for (const unit of FISCAL_UNITS) {
          const p = fiscalPeriod(unit, day, fy);
          expect(p.from <= p.to).toBe(true);
          expect(p.from <= day && day <= p.to).toBe(true);
        }
      }
    }
  });
});

describe("periodToDate", () => {
  it("clips to today and says it is partial", () => {
    expect(periodToDate("month", "2026-09-17", APRIL)).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-17",
      partial: true,
    });
  });

  it("is not partial on the period's last day", () => {
    expect(periodToDate("month", "2026-09-30", APRIL)).toMatchObject({
      to: "2026-09-30",
      partial: false,
    });
  });

  it("keeps the period's own label, so the heading names the period and the dates name the days", () => {
    expect(periodToDate("quarter", "2026-07-02", APRIL).label).toBe("Q2 FY 2026-27");
  });
});

describe("previousPeriod", () => {
  it("steps a quarter back by months, not by days", () => {
    // Q1 Apr-Jun is 91 days and Q4 Jan-Mar is 90; day arithmetic lands wrong.
    const q1 = fiscalPeriod("quarter", "2026-05-01", APRIL);
    expect(previousPeriod(q1, APRIL)).toMatchObject({
      from: "2026-01-01",
      to: "2026-03-31",
      label: "Q4 FY 2025-26",
    });
  });

  it("steps a month back onto a shorter month without losing days", () => {
    const march = fiscalPeriod("month", "2026-03-15", APRIL);
    expect(previousPeriod(march, APRIL)).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("steps a year, a half, a week and a day", () => {
    expect(previousPeriod(fiscalPeriod("year", "2026-06-01", APRIL), APRIL).label).toBe("FY 2025-26");
    expect(previousPeriod(fiscalPeriod("half", "2026-05-01", APRIL), APRIL).label).toBe("H2 FY 2025-26");
    expect(previousPeriod(fiscalPeriod("week", "2026-09-17", APRIL), APRIL).from).toBe("2026-09-07");
    expect(previousPeriod(fiscalPeriod("day", "2026-09-01", APRIL), APRIL).from).toBe("2026-08-31");
  });
});

describe("samePeriodLastYear", () => {
  it("lands on the same month a year earlier", () => {
    const sep = fiscalPeriod("month", "2026-09-17", APRIL);
    expect(samePeriodLastYear(sep, APRIL)).toMatchObject({
      from: "2025-09-01",
      to: "2025-09-30",
      label: "September 2025",
    });
  });

  it("lands on the same quarter of the previous financial year", () => {
    const q2 = fiscalPeriod("quarter", "2026-08-01", APRIL);
    expect(samePeriodLastYear(q2, APRIL)).toMatchObject({
      from: "2025-07-01",
      to: "2025-09-30",
      label: "Q2 FY 2025-26",
    });
  });

  it("keeps February whole when last year was a leap year", () => {
    const feb = fiscalPeriod("month", "2025-02-10", APRIL);
    expect(samePeriodLastYear(feb, APRIL)).toMatchObject({ from: "2024-02-01", to: "2024-02-29" });
  });
});

describe("periodsInFiscalYear", () => {
  it("gives twelve months opening in April and closing in March", () => {
    const months = periodsInFiscalYear("month", 2026, APRIL);
    expect(months).toHaveLength(12);
    expect([months[0].from, months[11].to]).toEqual(["2026-04-01", "2027-03-31"]);
    expect(months[0].label).toBe("April 2026");
  });

  it("gives four quarters covering the year with no gap and no overlap", () => {
    const qs = periodsInFiscalYear("quarter", 2026, APRIL);
    expect(qs.map((q) => q.label)).toEqual([
      "Q1 FY 2026-27",
      "Q2 FY 2026-27",
      "Q3 FY 2026-27",
      "Q4 FY 2026-27",
    ]);
    // Each quarter starts the day after the previous one ends.
    for (let i = 1; i < qs.length; i += 1) {
      expect(new Date(qs[i].from).getTime() - new Date(qs[i - 1].to).getTime()).toBe(86_400_000);
    }
  });

  it("gives two halves and a single year", () => {
    expect(periodsInFiscalYear("half", 2026, APRIL).map((h) => h.from)).toEqual(["2026-04-01", "2026-10-01"]);
    expect(periodsInFiscalYear("year", 2026, APRIL)).toHaveLength(1);
  });

  it("every month of the year belongs to exactly one quarter of the same FY", () => {
    const qs = periodsInFiscalYear("quarter", 2026, APRIL);
    for (const month of periodsInFiscalYear("month", 2026, APRIL)) {
      const owning = qs.filter((q) => q.from <= month.from && month.to <= q.to);
      expect(owning).toHaveLength(1);
      expect(owning[0].fyStartYear).toBe(2026);
    }
  });
});

describe("the request-body guards", () => {
  it("accepts a real date and rejects a shaped one that does not exist", () => {
    expect(asDateKey("2026-09-17")).toBe("2026-09-17");
    expect(asDateKey("2026-02-30")).toBeNull();
    expect(asDateKey("17-09-2026")).toBeNull();
    expect(asDateKey(20260917)).toBeNull();
    expect(asDateKey(null)).toBeNull();
  });

  it("accepts months 1-12 and nothing else", () => {
    expect([asFyStartMonth(1), asFyStartMonth(12), asFyStartMonth("4")]).toEqual([1, 12, 4]);
    expect([asFyStartMonth(0), asFyStartMonth(13), asFyStartMonth(4.5), asFyStartMonth("April")]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});
