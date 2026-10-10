import { describe, expect, it } from "vitest";

import {
  catalogueFor,
  closableMonths,
  closeReadiness,
  CLOSE_CHECKLIST,
  COMPLIANCE_CATALOGUE,
  complianceStatus,
  daysUntilDue,
  describeDueRule,
  dueDateFor,
  DueRule,
  filingsForYear,
  filingYearLabel,
  itemApplies,
  remindsToday,
  reminderDatesFor,
  ROC_FILERS,
  type ComplianceTag,
} from "./compliance";
import { fiscalPeriod } from "./fiscal";

const APRIL = 4;
const ALL_TAGS: ComplianceTag[] = [
  "gst",
  "tds",
  "income_tax",
  "payroll",
  "roc",
  "professional_tax",
  "import_export",
];

const item = (code: string) => {
  const found = COMPLIANCE_CATALOGUE.find((i) => i.code === code);
  if (!found) throw new Error(`no such catalogue item: ${code}`);
  return found;
};

describe("the catalogue names no legal references", () => {
  it("carries no section, rule or Act citation anywhere", () => {
    // §2: "Section numbers and portal screens changed with the new Act, so the
    // module must not hard-code legal references." This is that rule as a test,
    // so a well-meant "u/s 139(1)" added later fails the build.
    const text = JSON.stringify(COMPLIANCE_CATALOGUE);
    for (const forbidden of [/\bsection\s/i, /\bu\/s\b/i, /\bsec\.\s*\d/i, /\brule\s+\d/i, /Act,?\s+\d{4}/]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it("identifies every item by a form or an authority instead", () => {
    for (const i of COMPLIANCE_CATALOGUE) {
      expect(i.authority.length).toBeGreaterThan(0);
      expect(i.code).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("flags every statutory item for CA verification", () => {
    const statutory = COMPLIANCE_CATALOGUE.filter((i) => i.authority !== "Internal");
    expect(statutory.every((i) => i.verifyWithCa)).toBe(true);
  });

  it("has unique codes", () => {
    const codes = COMPLIANCE_CATALOGUE.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every item at least one reminder offset, all non-negative", () => {
    for (const i of COMPLIANCE_CATALOGUE) {
      expect(i.reminderOffsets.length).toBeGreaterThan(0);
      expect(i.reminderOffsets.every((d) => d >= 0)).toBe(true);
    }
  });

  it("parses every shipped due rule against the schema the table stores", () => {
    for (const i of COMPLIANCE_CATALOGUE) {
      expect(DueRule.safeParse(i.dueRule).success).toBe(true);
    }
  });
});

describe("dueDateFor - day_of_month_after", () => {
  const sep = fiscalPeriod("month", "2026-09-10", APRIL);

  it("puts GSTR-1 on the 11th of the following month", () => {
    expect(dueDateFor(item("gstr1_monthly").dueRule, sep, APRIL)).toBe("2026-10-11");
  });

  it("puts GSTR-3B on the 20th of the following month", () => {
    expect(dueDateFor(item("gstr3b_monthly").dueRule, sep, APRIL)).toBe("2026-10-20");
  });

  it("clamps day 31 to a short month", () => {
    const jan = fiscalPeriod("month", "2026-01-10", APRIL);
    expect(dueDateFor({ kind: "day_of_month_after", day: 31, monthsAfter: 1 }, jan, APRIL)).toBe("2026-02-28");
  });

  it("walks from the period's end month, so a 28-day and a 31-day month land together", () => {
    const feb = fiscalPeriod("month", "2026-02-10", APRIL);
    const mar = fiscalPeriod("month", "2026-03-10", APRIL);
    expect(dueDateFor({ kind: "day_of_month_after", day: 20, monthsAfter: 1 }, feb, APRIL)).toBe("2026-03-20");
    expect(dueDateFor({ kind: "day_of_month_after", day: 20, monthsAfter: 1 }, mar, APRIL)).toBe("2026-04-20");
  });

  it("counts nine months forward for the annual GST return", () => {
    const fy = fiscalPeriod("year", "2026-06-01", APRIL);
    // FY closes 31 March 2027; nine months on is December 2027.
    expect(dueDateFor(item("gstr9_annual").dueRule, fy, APRIL)).toBe("2027-12-31");
  });
});

describe("dueDateFor - the March TDS exception", () => {
  it("gives March's deduction until 30 April, not 7 April", () => {
    const mar = fiscalPeriod("month", "2027-03-10", APRIL);
    expect(dueDateFor(item("tds_deposit").dueRule, mar, APRIL)).toBe("2027-04-30");
  });

  it("leaves every other month on the 7th", () => {
    for (const m of ["2026-04-10", "2026-09-10", "2026-12-10", "2027-01-10", "2027-02-10"]) {
      const period = fiscalPeriod("month", m, APRIL);
      expect(dueDateFor(item("tds_deposit").dueRule, period, APRIL).slice(8)).toBe("07");
    }
  });

  it("gives the January-March TDS return an extra month", () => {
    const q4 = fiscalPeriod("quarter", "2027-02-10", APRIL);
    const q1 = fiscalPeriod("quarter", "2026-05-10", APRIL);
    expect(dueDateFor(item("tds_return").dueRule, q4, APRIL)).toBe("2027-05-31");
    expect(dueDateFor(item("tds_return").dueRule, q1, APRIL)).toBe("2026-07-31");
  });
});

describe("dueDateFor - fy_month_day, the advance tax case §2 works through", () => {
  const fy = fiscalPeriod("year", "2026-06-01", APRIL);

  it("places all four instalments on 15 June, September, December and March", () => {
    expect(
      ["advance_tax_q1", "advance_tax_q2", "advance_tax_q3", "advance_tax_q4"].map((code) =>
        dueDateFor(item(code).dueRule, fy, APRIL),
      ),
    ).toEqual(["2026-06-15", "2026-09-15", "2026-12-15", "2027-03-15"]);
  });

  it("names the cumulative share §2 gives, in order", () => {
    expect(
      ["advance_tax_q1", "advance_tax_q2", "advance_tax_q3", "advance_tax_q4"].map((c) => item(c).name),
    ).toEqual([
      "Advance tax - first instalment (15% cumulative)",
      "Advance tax - second instalment (45% cumulative)",
      "Advance tax - third instalment (75% cumulative)",
      "Advance tax - fourth instalment (100% cumulative)",
    ]);
  });

  it("puts the first instalment INSIDE the year it pays tax on", () => {
    // The whole reason this rule kind exists: 15 June is three months before
    // the quarter-after-period-end arithmetic would put it, and nine months
    // before the FY ends.
    const due = dueDateFor(item("advance_tax_q1").dueRule, fy, APRIL);
    expect(due >= fy.from && due <= fy.to).toBe(true);
  });

  it("follows a January financial year start", () => {
    const calFy = fiscalPeriod("year", "2026-06-01", 1);
    // monthIntoFy 2 from January is March.
    expect(dueDateFor(item("advance_tax_q1").dueRule, calFy, 1)).toBe("2026-03-15");
  });

  it("derives the financial year from the period when it is not given", () => {
    expect(
      dueDateFor({ kind: "fy_month_day", monthIntoFy: 2, day: 15 }, { from: "2027-01-01", to: "2027-03-31" }, APRIL),
    ).toBe("2026-06-15");
  });
});

describe("dueDateFor - days_after", () => {
  it("counts plain days from the period end", () => {
    const fy = fiscalPeriod("year", "2026-06-01", APRIL);
    expect(dueDateFor({ kind: "days_after", days: 15 }, fy, APRIL)).toBe("2027-04-15");
  });

  it("treats zero as the period's last day", () => {
    expect(dueDateFor({ kind: "days_after", days: 0 }, { from: "2026-09-01", to: "2026-09-30" })).toBe("2026-09-30");
  });
});

describe("describeDueRule", () => {
  it("reads as words in the console's item editor", () => {
    expect(describeDueRule({ kind: "day_of_month_after", day: 20, monthsAfter: 1 })).toBe(
      "Day 20 of the following month",
    );
    expect(describeDueRule({ kind: "days_after", days: 30 })).toBe("30 days after the period ends");
    expect(describeDueRule({ kind: "fy_month_day", monthIntoFy: 2, day: 15 }, APRIL)).toBe(
      "15 Jun, within the financial year",
    );
  });

  it("says how many exceptions a rule carries, so one is not invisible", () => {
    expect(describeDueRule(item("tds_deposit").dueRule)).toContain("1 month-specific exception");
  });
});

describe("applicability - §5's proprietor-vs-company question", () => {
  const proprietor = { entityType: "proprietorship" as const, tags: ["gst"] as ComplianceTag[] };
  const company = { entityType: "private_limited" as const, tags: ALL_TAGS };

  it("keeps ROC filings away from a proprietor", () => {
    expect(itemApplies(item("roc_financials"), proprietor)).toBe(false);
    expect(itemApplies(item("roc_financials"), company)).toBe(true);
  });

  it("only counts a company and a public company as ROC filers", () => {
    expect([...ROC_FILERS]).toEqual(["private_limited", "public_limited"]);
  });

  it("requires EVERY tag an item names, not just one", () => {
    // Form 16 needs payroll AND tds: employees but no TDS registration means
    // no Form 16.
    const employerNoTds = { entityType: "proprietorship" as const, tags: ["payroll"] as ComplianceTag[] };
    expect(itemApplies(item("form16_issue"), employerNoTds)).toBe(false);
    expect(
      itemApplies(item("form16_issue"), { entityType: "proprietorship", tags: ["payroll", "tds"] }),
    ).toBe(true);
  });

  it("applies a no-tag item to everyone", () => {
    expect(itemApplies(item("year_end_stock_assets"), proprietor)).toBe(true);
  });

  it("gives a GST-only proprietor a short list and a full company a long one", () => {
    const short = catalogueFor(proprietor);
    const long = catalogueFor(company);
    expect(short.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(short.length);
    expect(short.map((i) => i.code)).not.toContain("pf_contribution");
  });

  it("gives a business with no registrations only the internal items", () => {
    const bare = catalogueFor({ entityType: "proprietorship", tags: [] });
    expect(bare.map((i) => i.code)).toEqual(["year_end_stock_assets"]);
  });
});

describe("filingsForYear", () => {
  it("generates twelve monthly filings with twelve distinct due dates", () => {
    const filings = filingsForYear(item("gstr3b_monthly"), 2026, APRIL);
    expect(filings).toHaveLength(12);
    expect(new Set(filings.map((f) => f.dueOn)).size).toBe(12);
    expect(filings[0]).toMatchObject({
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
      dueOn: "2026-05-20",
      periodLabel: "April 2026",
    });
    expect(filings[11]).toMatchObject({
      periodFrom: "2027-03-01",
      periodTo: "2027-03-31",
      dueOn: "2027-04-20",
    });
  });

  it("generates four quarterly filings", () => {
    const filings = filingsForYear(item("tds_return"), 2026, APRIL);
    expect(filings.map((f) => f.dueOn)).toEqual(["2026-07-31", "2026-10-31", "2027-01-31", "2027-05-31"]);
    expect(filings.map((f) => f.periodLabel)).toEqual([
      "Q1 FY 2026-27",
      "Q2 FY 2026-27",
      "Q3 FY 2026-27",
      "Q4 FY 2026-27",
    ]);
  });

  it("generates one yearly filing", () => {
    expect(filingsForYear(item("income_tax_return"), 2026, APRIL)).toEqual([
      {
        itemCode: "income_tax_return",
        periodFrom: "2026-04-01",
        periodTo: "2027-03-31",
        dueOn: "2027-07-31",
        periodLabel: "FY 2026-27",
      },
    ]);
  });

  it("generates nothing for a one-time item", () => {
    expect(filingsForYear({ code: "gst_registration", frequency: "one_time", dueRule: { kind: "days_after", days: 0 } }, 2026, APRIL)).toEqual(
      [],
    );
  });

  it("never generates two filings for the same period of the same item", () => {
    for (const i of COMPLIANCE_CATALOGUE) {
      const keys = filingsForYear(i, 2026, APRIL).map((f) => `${f.periodFrom}|${f.periodTo}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("produces a due date on or after the period starts for every catalogue item", () => {
    for (const i of COMPLIANCE_CATALOGUE) {
      for (const f of filingsForYear(i, 2026, APRIL)) {
        expect(f.dueOn >= f.periodFrom).toBe(true);
      }
    }
  });
});

describe("complianceStatus - derived, never stored", () => {
  const today = "2026-09-17";

  it("reads overdue only after the due date, not on it", () => {
    expect(complianceStatus({ dueOn: "2026-09-17" }, today)).toBe("due_soon");
    expect(complianceStatus({ dueOn: "2026-09-16" }, today)).toBe("overdue");
  });

  it("reads due_soon inside the window and upcoming outside it", () => {
    expect(complianceStatus({ dueOn: "2026-09-24" }, today)).toBe("due_soon");
    expect(complianceStatus({ dueOn: "2026-09-25" }, today)).toBe("upcoming");
  });

  it("takes a custom window", () => {
    expect(complianceStatus({ dueOn: "2026-10-10" }, today, 30)).toBe("due_soon");
  });

  it("reads filed whatever the date", () => {
    expect(complianceStatus({ dueOn: "2026-01-01", filedOn: "2026-01-05" }, today)).toBe("filed");
  });

  it("lets filed beat waived - a filing made is a fact", () => {
    expect(
      complianceStatus({ dueOn: "2026-01-01", filedOn: "2026-01-05", waivedAt: "2026-02-01" }, today),
    ).toBe("filed");
  });

  it("reads waived rather than overdue, so switching an item off clears the red", () => {
    expect(complianceStatus({ dueOn: "2026-01-01", waivedAt: "2026-02-01" }, today)).toBe("waived");
  });

  it("uses the same boundary as scheduleItemStatus - due today is not late today", () => {
    expect(complianceStatus({ dueOn: today }, today)).not.toBe("overdue");
  });
});

describe("daysUntilDue", () => {
  it("counts forward and backward", () => {
    expect(daysUntilDue({ dueOn: "2026-09-20" }, "2026-09-17")).toBe(3);
    expect(daysUntilDue({ dueOn: "2026-09-10" }, "2026-09-17")).toBe(-7);
    expect(daysUntilDue({ dueOn: "2026-09-17" }, "2026-09-17")).toBe(0);
  });

  it("is null once filed or waived, where it would be meaningless", () => {
    expect(daysUntilDue({ dueOn: "2026-09-20", filedOn: "2026-09-18" }, "2026-09-17")).toBeNull();
    expect(daysUntilDue({ dueOn: "2026-09-20", waivedAt: "2026-09-18" }, "2026-09-17")).toBeNull();
  });

  it("crosses a month and a leap day correctly", () => {
    expect(daysUntilDue({ dueOn: "2024-03-01" }, "2024-02-28")).toBe(2);
  });
});

describe("reminders", () => {
  it("turns offsets into dates, furthest out first", () => {
    expect(reminderDatesFor("2026-10-20", [7, 3, 1])).toEqual(["2026-10-13", "2026-10-17", "2026-10-19"]);
  });

  it("de-duplicates and drops nonsense offsets", () => {
    expect(reminderDatesFor("2026-10-20", [3, 3, -1, 1.5])).toEqual(["2026-10-17"]);
  });

  it("includes the due date itself for an offset of zero", () => {
    expect(reminderDatesFor("2026-10-20", [0])).toEqual(["2026-10-20"]);
  });

  it("fires on an exact reminder day and not on the days between", () => {
    const filing = { dueOn: "2026-10-20" };
    expect(remindsToday(filing, [7, 3, 1], "2026-10-13")).toBe(true);
    expect(remindsToday(filing, [7, 3, 1], "2026-10-17")).toBe(true);
    expect(remindsToday(filing, [7, 3, 1], "2026-10-14")).toBe(false);
  });

  it("stops reminding once filed or waived", () => {
    expect(remindsToday({ dueOn: "2026-10-20", filedOn: "2026-10-12" }, [7], "2026-10-13")).toBe(false);
    expect(remindsToday({ dueOn: "2026-10-20", waivedAt: "2026-10-12" }, [7], "2026-10-13")).toBe(false);
  });
});

describe("the month-end close checklist", () => {
  it("has unique keys and a blurb on every step", () => {
    const keys = CLOSE_CHECKLIST.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(CLOSE_CHECKLIST.every((s) => s.label && s.blurb)).toBe(true);
  });

  it("puts matching, reconciliation and expense approval ahead of reading the result", () => {
    const order = CLOSE_CHECKLIST.map((s) => s.key);
    expect(order.indexOf("payments_matched")).toBeLessThan(order.indexOf("pl_reviewed"));
    expect(order.indexOf("bank_reconciled")).toBeLessThan(order.indexOf("pl_reviewed"));
    expect(order.indexOf("expenses_approved")).toBeLessThan(order.indexOf("pl_reviewed"));
  });

  it("links every step to a page that does the work, where there is one", () => {
    for (const s of CLOSE_CHECKLIST) {
      if (s.href) expect(s.href).toMatch(/^\/owner\//);
    }
  });

  it("counts nothing done as nothing done", () => {
    expect(closeReadiness([])).toMatchObject({ done: 0, total: CLOSE_CHECKLIST.length, complete: false });
  });

  it("names the blocking steps separately from the merely outstanding ones", () => {
    const r = closeReadiness(["payments_matched"]);
    expect(r.blocking).toEqual(["bank_reconciled", "expenses_approved"]);
    expect(r.outstanding).toContain("dues_reviewed");
    expect(r.blocking).not.toContain("dues_reviewed");
  });

  it("is complete when every step is ticked", () => {
    expect(closeReadiness(CLOSE_CHECKLIST.map((s) => s.key))).toMatchObject({
      done: CLOSE_CHECKLIST.length,
      blocking: [],
      complete: true,
    });
  });

  it("ignores a stale key, so a renamed step cannot report 9 of 8 done", () => {
    const r = closeReadiness([...CLOSE_CHECKLIST.map((s) => s.key), "a_step_that_was_renamed"]);
    expect(r.done).toBe(CLOSE_CHECKLIST.length);
  });
});

describe("closableMonths", () => {
  it("starts with last month, never the one in progress", () => {
    const months = closableMonths("2026-09-17", 3);
    expect(months.map((m) => m.label)).toEqual(["August 2026", "July 2026", "June 2026"]);
  });

  it("crosses a year boundary", () => {
    expect(closableMonths("2026-01-05", 2).map((m) => m.from)).toEqual(["2025-12-01", "2025-11-01"]);
  });

  it("is still right on the first and last day of a month", () => {
    expect(closableMonths("2026-09-01", 1)[0].label).toBe("August 2026");
    expect(closableMonths("2026-09-30", 1)[0].label).toBe("August 2026");
  });
});

describe("filingYearLabel", () => {
  it("files a January period under the financial year that opened in April", () => {
    expect(filingYearLabel("2027-01-01", APRIL)).toBe("FY 2026-27");
    expect(filingYearLabel("2026-04-01", APRIL)).toBe("FY 2026-27");
  });
});
