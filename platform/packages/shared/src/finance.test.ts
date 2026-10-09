import { describe, expect, it } from "vitest";

import { sumMinor, toMinor } from "./money";
import {
  FINANCE_DEFAULTS,
  agingBucket,
  applyToSchedule,
  balances,
  daysBetween,
  generateSchedule,
  incentiveFor,
  isCollected,
  matchStatusFor,
  paymentStatusMovable,
  scheduleItemStatus,
  validateCustomFieldValues,
  validateScheduleParams,
} from "./finance";

const CLOSED = "2026-01-15";

describe("generateSchedule", () => {
  it("generates a one-time schedule for the whole amount", () => {
    const rows = generateSchedule({
      scheduleType: "one_time",
      params: {},
      totalMinor: toMinor("100000.00"),
      closedOn: CLOSED,
    });
    expect(rows).toEqual([{ dueDate: "2026-01-15", amountMinor: 10_000_000 }]);
  });

  it("honours the first-due offset, so 'due in 7 days' is a date", () => {
    const [row] = generateSchedule({
      scheduleType: "one_time",
      params: { firstDueOffsetDays: 7 },
      totalMinor: 1000,
      closedOn: CLOSED,
    });
    expect(row.dueDate).toBe("2026-01-22");
  });

  it("makes instalments sum to EXACTLY the deal total", () => {
    // ₹1,00,000 in three is the case a float loses a paisa on.
    const rows = generateSchedule({
      scheduleType: "installments",
      params: { installments: 3, intervalMonths: 1 },
      totalMinor: toMinor("100000.00"),
      closedOn: CLOSED,
    });
    expect(rows).toHaveLength(3);
    expect(sumMinor(rows.map((r) => r.amountMinor))).toBe(toMinor("100000.00"));
    expect(rows.map((r) => r.dueDate)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });

  it("clamps a month-end instalment instead of rolling into the next month", () => {
    // The 31st of January + 1 month is the 28th of February. Rolling to 3 March
    // would bill the customer twice in March.
    const rows = generateSchedule({
      scheduleType: "installments",
      params: { installments: 4, intervalMonths: 1 },
      totalMinor: 400,
      closedOn: "2026-01-31",
    });
    expect(rows.map((r) => r.dueDate)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("spaces by days when days were chosen", () => {
    const rows = generateSchedule({
      scheduleType: "installments",
      params: { installments: 3, intervalDays: 15 },
      totalMinor: 300,
      closedOn: CLOSED,
    });
    expect(rows.map((r) => r.dueDate)).toEqual(["2026-01-15", "2026-01-30", "2026-02-14"]);
  });

  it("bills a recurring deal the FULL amount every period, not a split", () => {
    const rows = generateSchedule({
      scheduleType: "recurring",
      params: { recurrencePeriod: "monthly", recurrenceCount: 3 },
      totalMinor: toMinor("5000.00"),
      closedOn: CLOSED,
    });
    expect(rows.map((r) => r.amountMinor)).toEqual([500_000, 500_000, 500_000]);
    expect(rows.map((r) => r.dueDate)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });

  it("handles a weekly recurrence in days, since a week is not a month", () => {
    const rows = generateSchedule({
      scheduleType: "recurring",
      params: { recurrencePeriod: "weekly", recurrenceCount: 3 },
      totalMinor: 100,
      closedOn: CLOSED,
    });
    expect(rows.map((r) => r.dueDate)).toEqual(["2026-01-15", "2026-01-22", "2026-01-29"]);
  });

  it("schedules only the commissionable slice", () => {
    // 2.5% of ₹1,23,456.78 - the deal is still worth what was sold, but only
    // the commission is ever receivable by this business.
    const rows = generateSchedule({
      scheduleType: "commission",
      params: { commissionPercent: 2.5 },
      totalMinor: toMinor("123456.78"),
      closedOn: CLOSED,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountMinor).toBe(308_642);
  });

  it("emits exactly what a person typed for a custom schedule", () => {
    const rows = generateSchedule({
      scheduleType: "custom",
      params: {
        customItems: [
          { dueDate: "2026-03-01", amount: 25_000 },
          { dueDate: "2026-06-01", amount: 75_000 },
        ],
      },
      totalMinor: toMinor("100000.00"),
      closedOn: CLOSED,
    });
    expect(rows).toEqual([
      { dueDate: "2026-03-01", amountMinor: 2_500_000 },
      { dueDate: "2026-06-01", amountMinor: 7_500_000 },
    ]);
  });

  it("works for two templates an owner could define with no code change (§5 acceptance)", () => {
    // This is §5's acceptance criterion, stated as a test: a one-time template
    // and an instalment template, both from data alone.
    const oneTime = generateSchedule({
      scheduleType: "one_time",
      params: { firstDueOffsetDays: 0 },
      totalMinor: toMinor("49999.00"),
      closedOn: CLOSED,
    });
    const emi = generateSchedule({
      scheduleType: "installments",
      params: { installments: 12, intervalMonths: 1, firstDueOffsetDays: 30 },
      totalMinor: toMinor("49999.00"),
      closedOn: CLOSED,
    });
    expect(sumMinor(oneTime.map((r) => r.amountMinor))).toBe(toMinor("49999.00"));
    expect(sumMinor(emi.map((r) => r.amountMinor))).toBe(toMinor("49999.00"));
    expect(emi).toHaveLength(12);
  });
});

describe("validateScheduleParams", () => {
  it("names what is missing, per shape", () => {
    expect(validateScheduleParams("installments", {})).toEqual({
      ok: false,
      problems: ["Say how many instalments.", "Say how far apart the instalments are."],
    });
    expect(validateScheduleParams("recurring", {}).ok).toBe(false);
    expect(validateScheduleParams("commission", {}).ok).toBe(false);
    expect(validateScheduleParams("custom", { customItems: [] }).ok).toBe(false);
  });

  it("refuses both days and months, which would be two different schedules", () => {
    const result = validateScheduleParams("installments", {
      installments: 3,
      intervalDays: 30,
      intervalMonths: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("asks a one-time template for nothing", () => {
    expect(validateScheduleParams("one_time", {}).ok).toBe(true);
  });
});

describe("validateCustomFieldValues", () => {
  const fields = [
    { key: "unit_no", label: "Unit number", type: "text" as const, required: true },
    { key: "carpet_area", label: "Carpet area", type: "number" as const, required: false },
    { key: "handover", label: "Handover", type: "date" as const, required: false },
    {
      key: "financing",
      label: "Financing",
      type: "select" as const,
      required: false,
      options: ["cash", "loan"],
    },
    { key: "is_nri", label: "NRI buyer", type: "boolean" as const, required: false },
  ];

  it("accepts a well-formed set", () => {
    expect(
      validateCustomFieldValues(fields, {
        unit_no: "A-1203",
        carpet_area: 985.5,
        handover: "2027-06-30",
        financing: "loan",
        is_nri: false,
      }),
    ).toEqual({ ok: true });
  });

  it("requires what the template marked required", () => {
    const result = validateCustomFieldValues(fields, { carpet_area: 100 });
    expect(result).toEqual({ ok: false, problems: ["Unit number is required."] });
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // An ignored key is how a typo becomes a value nobody can find again.
    const result = validateCustomFieldValues(fields, { unit_no: "A-1", unti_no: "A-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain("Unknown field: unti_no");
  });

  it("checks each type, including a select's own option list", () => {
    const result = validateCustomFieldValues(fields, {
      unit_no: 12,
      carpet_area: "big",
      handover: "30-06-2027",
      financing: "emi",
      is_nri: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(5);
  });
});

describe("scheduleItemStatus", () => {
  const item = { amountMinor: 10_000, paidMinor: 0, dueDate: "2026-02-01" };

  it("is open before anything is paid and before it is due", () => {
    expect(scheduleItemStatus(item, "2026-01-20")).toBe("open");
  });

  it("is not late on the day it is due", () => {
    expect(scheduleItemStatus(item, "2026-02-01")).toBe("open");
    expect(scheduleItemStatus(item, "2026-02-02")).toBe("overdue");
  });

  it("calls a half-paid late item overdue, not partial", () => {
    // 'Half paid and three weeks late' is a collections problem; `partial` is
    // not a colour anybody chases.
    expect(scheduleItemStatus({ ...item, paidMinor: 5_000 }, "2026-02-22")).toBe("overdue");
    expect(scheduleItemStatus({ ...item, paidMinor: 5_000 }, "2026-01-20")).toBe("partial");
  });

  it("is paid once it is covered, even late, and cancelled beats everything", () => {
    expect(scheduleItemStatus({ ...item, paidMinor: 10_000 }, "2026-03-01")).toBe("paid");
    expect(scheduleItemStatus({ ...item, paidMinor: 12_000 }, "2026-03-01")).toBe("paid");
    expect(scheduleItemStatus({ ...item, cancelled: true }, "2026-03-01")).toBe("cancelled");
  });
});

describe("agingBucket", () => {
  it("keeps not-yet-due money out of the past-due buckets", () => {
    expect(agingBucket("2026-03-01", "2026-02-01")).toBe("current");
    expect(agingBucket("2026-02-01", "2026-02-01")).toBe("current");
  });

  it("walks the four buckets at their boundaries", () => {
    // Counted in real days, so the boundary dates are not round: 1 Jan to
    // 2 Mar is 60 days (31 + 28 + 1), which is the last day of the 31-60
    // bucket rather than the first of the next one.
    expect(agingBucket("2026-01-01", "2026-01-02")).toBe("0_30");
    expect(agingBucket("2026-01-01", "2026-01-31")).toBe("0_30");
    expect(agingBucket("2026-01-01", "2026-02-01")).toBe("31_60");
    expect(agingBucket("2026-01-01", "2026-03-02")).toBe("31_60");
    expect(agingBucket("2026-01-01", "2026-03-03")).toBe("61_90");
    expect(agingBucket("2026-01-01", "2026-04-01")).toBe("61_90");
    expect(agingBucket("2026-01-01", "2026-04-02")).toBe("90_plus");
  });

  it("counts days across a month and a leap year", () => {
    expect(daysBetween("2026-01-31", "2026-02-01")).toBe(1);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });
});

describe("isCollected", () => {
  it("counts only money that is actually in", () => {
    expect(isCollected("received")).toBe(true);
    expect(isCollected("cheque_cleared")).toBe(true);
    // The receipt happened; the refund is a separate negative row.
    expect(isCollected("partially_refunded")).toBe(true);
  });

  it("excludes a hold, an unverified claim and a bounce", () => {
    // §10 is a MUST: incentives come from collected payments only. These four
    // are the difference between a correct payout and paying on a bounced cheque.
    expect(isCollected("authorized")).toBe(false);
    expect(isCollected("pending_verification")).toBe(false);
    expect(isCollected("cheque_bounced")).toBe(false);
    expect(isCollected("reversed")).toBe(false);
    expect(isCollected("failed")).toBe(false);
    expect(isCollected("refunded")).toBe(false);
  });
});

describe("paymentStatusMovable", () => {
  it("allows the cheque clearing step §6.2 requires", () => {
    expect(paymentStatusMovable("pending_verification", "cheque_cleared")).toBe(true);
    expect(paymentStatusMovable("pending_verification", "cheque_bounced")).toBe(true);
  });

  it("refuses a status only a mechanism may set", () => {
    // A refund writes a refunds row AND a reversing ledger entry. A PATCH that
    // could assert `refunded` is how the ledger stops balancing.
    expect(paymentStatusMovable("received", "refunded")).toBe(false);
    expect(paymentStatusMovable("received", "disputed")).toBe(false);
    expect(paymentStatusMovable("received", "partially_refunded")).toBe(false);
  });

  it("refuses to walk backwards out of a terminal state", () => {
    expect(paymentStatusMovable("cheque_bounced", "received")).toBe(false);
    expect(paymentStatusMovable("failed", "received")).toBe(false);
    expect(paymentStatusMovable("reversed", "received")).toBe(false);
  });
});

describe("matchStatusFor", () => {
  const t = FINANCE_DEFAULTS.autoMatchConfidence;

  it("auto-applies at or above the threshold", () => {
    expect(matchStatusFor(1, t)).toBe("matched");
    expect(matchStatusFor(0.9, t)).toBe("matched");
    expect(matchStatusFor(0.85, t)).toBe("matched");
  });

  it("offers a weaker match as a suggestion instead of applying it", () => {
    expect(matchStatusFor(0.6, t)).toBe("suggested");
    expect(matchStatusFor(0.84, t)).toBe("suggested");
  });

  it("is unmatched when no rule produced a candidate at all", () => {
    expect(matchStatusFor(null, t)).toBe("unmatched");
  });

  it("still counts the identity rule when an org tightens to exactly 0.9", () => {
    expect(matchStatusFor(0.9, 0.9)).toBe("matched");
  });
});

describe("applyToSchedule", () => {
  const items = [
    { id: "b", dueDate: "2026-02-01", amountMinor: 10_000, paidMinor: 0 },
    { id: "a", dueDate: "2026-01-01", amountMinor: 10_000, paidMinor: 0 },
    { id: "c", dueDate: "2026-03-01", amountMinor: 10_000, paidMinor: 0 },
  ];

  it("pays the oldest open item first (§15)", () => {
    const { applications, creditMinor } = applyToSchedule(items, 10_000);
    expect(applications).toEqual([{ id: "a", appliedMinor: 10_000 }]);
    expect(creditMinor).toBe(0);
  });

  it("spills across items in order", () => {
    const { applications } = applyToSchedule(items, 15_000);
    expect(applications).toEqual([
      { id: "a", appliedMinor: 10_000 },
      { id: "b", appliedMinor: 5_000 },
    ]);
  });

  it("tops up an already-part-paid item before moving on", () => {
    const partial = [{ ...items[1], paidMinor: 6_000 }, items[0]];
    const { applications } = applyToSchedule(partial, 5_000);
    expect(applications).toEqual([
      { id: "a", appliedMinor: 4_000 },
      { id: "b", appliedMinor: 1_000 },
    ]);
  });

  it("turns an overpayment into a credit rather than dropping it", () => {
    const { applications, creditMinor } = applyToSchedule(items, 35_000);
    expect(sumMinor(applications.map((a) => a.appliedMinor))).toBe(30_000);
    expect(creditMinor).toBe(5_000);
  });

  it("is the whole receipt as credit when nothing is open", () => {
    const paid = items.map((i) => ({ ...i, paidMinor: i.amountMinor }));
    expect(applyToSchedule(paid, 10_000)).toEqual({ applications: [], creditMinor: 10_000 });
  });

  it("breaks a same-day tie by id, so the order is stable across queries", () => {
    const sameDay = [
      { id: "z", dueDate: "2026-01-01", amountMinor: 1_000, paidMinor: 0 },
      { id: "y", dueDate: "2026-01-01", amountMinor: 1_000, paidMinor: 0 },
    ];
    expect(applyToSchedule(sameDay, 1_000).applications).toEqual([
      { id: "y", appliedMinor: 1_000 },
    ]);
  });
});

describe("balances", () => {
  it("accepts a balanced posting and refuses an unbalanced one", () => {
    expect(
      balances([
        { account: "cash", debitMinor: 10_000, creditMinor: 0 },
        { account: "receivable", debitMinor: 0, creditMinor: 10_000 },
      ]),
    ).toBe(true);
    expect(
      balances([
        { account: "cash", debitMinor: 10_000, creditMinor: 0 },
        { account: "receivable", debitMinor: 0, creditMinor: 9_999 },
      ]),
    ).toBe(false);
  });

  it("accepts a three-line posting that splits a fee off a receipt", () => {
    expect(
      balances([
        { account: "cash", debitMinor: 9_764, creditMinor: 0 },
        { account: "gateway_fees", debitMinor: 236, creditMinor: 0 },
        { account: "receivable", debitMinor: 0, creditMinor: 10_000 },
      ]),
    ).toBe(true);
  });
});

describe("incentiveFor", () => {
  it("pays a flat percentage of what was collected", () => {
    expect(
      incentiveFor(
        { type: "percent_of_collected", rules: { percent: 2 } },
        { collectedMinor: toMinor("100000.00") },
      ),
    ).toBe(toMinor("2000.00"));
  });

  it("applies slabs marginally, so one more rupee is not a cliff", () => {
    // 0% to ₹1L, 5% above. ₹1,50,000 earns 5% of ₹50,000 = ₹2,500 - not 5% of
    // the whole ₹1,50,000, which would pay ₹5,000 more for one extra rupee.
    const plan = {
      type: "slab" as const,
      rules: { slabs: [{ fromMinor: 0, percent: 0 }, { fromMinor: 10_000_000, percent: 5 }] },
    };
    expect(incentiveFor(plan, { collectedMinor: toMinor("150000.00") })).toBe(toMinor("2500.00"));
    expect(incentiveFor(plan, { collectedMinor: toMinor("100000.00") })).toBe(0);
    expect(incentiveFor(plan, { collectedMinor: toMinor("100000.01") })).toBe(0);
  });

  it("sorts slabs given out of order", () => {
    const plan = {
      type: "slab" as const,
      rules: { slabs: [{ fromMinor: 10_000, percent: 10 }, { fromMinor: 0, percent: 1 }] },
    };
    expect(incentiveFor(plan, { collectedMinor: 20_000 })).toBe(100 + 1_000);
  });

  it("scales by the KPI step a score falls in", () => {
    const plan = {
      type: "kpi_linked" as const,
      rules: { percent: 2, kpiMultipliers: { "60": 0.5, "80": 1, "95": 1.25 } },
    };
    const collected = { collectedMinor: toMinor("100000.00") };
    expect(incentiveFor(plan, { ...collected, kpiScore: 70 })).toBe(toMinor("1000.00"));
    expect(incentiveFor(plan, { ...collected, kpiScore: 85 })).toBe(toMinor("2000.00"));
    expect(incentiveFor(plan, { ...collected, kpiScore: 96 })).toBe(toMinor("2500.00"));
  });

  it("pays 1x when the KPI score is missing, not 0x", () => {
    // A rep whose calls were never analysed has a null score. Paying nothing
    // because a pipeline was misconfigured is the wrong failure direction for
    // somebody's wages.
    const plan = {
      type: "kpi_linked" as const,
      rules: { percent: 2, kpiMultipliers: { "80": 1 } },
    };
    expect(incentiveFor(plan, { collectedMinor: 100_000, kpiScore: null })).toBe(2_000);
    expect(incentiveFor(plan, { collectedMinor: 100_000 })).toBe(2_000);
  });

  it("respects a floor and a cap", () => {
    expect(
      incentiveFor(
        { type: "percent_of_collected", rules: { percent: 10, maxPayoutMinor: 500_000 } },
        { collectedMinor: toMinor("1000000.00") },
      ),
    ).toBe(500_000);
    expect(
      incentiveFor(
        { type: "percent_of_collected", rules: { percent: 1, minPayoutMinor: 100_000 } },
        { collectedMinor: 1_000 },
      ),
    ).toBe(100_000);
  });

  it("mirrors exactly for a clawback, so a refund cancels its earn", () => {
    // §10's clawback is a NEGATIVE line computed by the same function on the
    // refunded amount. If the two did not cancel, a refunded sale would leave
    // a residue in somebody's payout forever.
    const plan = { type: "percent_of_collected" as const, rules: { percent: 2.5 } };
    const earn = incentiveFor(plan, { collectedMinor: toMinor("123456.78") });
    const claw = incentiveFor(plan, { collectedMinor: -toMinor("123456.78") });
    expect(earn + claw).toBe(0);
  });
});
