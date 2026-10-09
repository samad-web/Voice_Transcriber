import { describe, expect, it } from "vitest";

import {
  ADVISOR_RULES,
  AdvisorRuleCode,
  STATISTICAL_RULES,
  advisorRule,
  alertDedupeKey,
  alertMovable,
  dueRemindersOwing,
  escalationTarget,
  inQuietHours,
  rankLeaks,
  renderMessage,
  shouldReopen,
  suggestThreshold,
} from "./finance-advisor";

describe("the catalogue", () => {
  it("holds all seventeen of §12.4's rules, once each", () => {
    expect(ADVISOR_RULES).toHaveLength(17);
    const codes = ADVISOR_RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(17);
    // And the enum and the catalogue cannot drift apart - a rule added to one
    // and not the other is the shape of bug that makes a rule unseedable.
    expect([...codes].sort()).toEqual([...AdvisorRuleCode.options].sort());
  });

  it("routes each rule to the person closest to the money", () => {
    expect(advisorRule("slipped_promise").routeTo).toBe("telecaller");
    expect(advisorRule("unmatched_money").routeTo).toBe("finance_handler");
    expect(advisorRule("settlement_mismatch").routeTo).toBe("finance_handler");
    expect(advisorRule("cash_runway_low").routeTo).toBe("owner");
    expect(advisorRule("refund_spike").routeTo).toBe("manager");
  });

  it("starts every escalation path at the rule's own route", () => {
    // Otherwise the first escalation would move an alert sideways to somebody
    // who never had it.
    for (const rule of ADVISOR_RULES) {
      expect(rule.escalationPath[0]).toBe(rule.routeTo);
    }
  });

  it("gives every rule a template, an action and at least one editable param", () => {
    for (const rule of ADVISOR_RULES) {
      expect(rule.messageTemplate.length).toBeGreaterThan(0);
      expect(rule.recommendedAction.length).toBeGreaterThan(0);
      expect(Object.keys(rule.params).length).toBeGreaterThan(0);
    }
  });

  it("marks exactly the statistical rules as statistical", () => {
    // These are the four that compare against a baseline and must therefore
    // stay silent below the minimum sample.
    expect([...STATISTICAL_RULES].sort()).toEqual([
      "call_cost_no_results",
      "expense_outlier",
      "fee_drift",
      "refund_spike",
    ]);
  });

  it("throws on an unknown code rather than returning a blank rule", () => {
    expect(() => advisorRule("nope" as AdvisorRuleCode)).toThrow();
  });
});

describe("alert lifecycle", () => {
  it("allows §12.5's moves and refuses the rest", () => {
    expect(alertMovable("open", "acknowledged")).toBe(true);
    expect(alertMovable("open", "resolved")).toBe(true);
    expect(alertMovable("acknowledged", "dismissed")).toBe(true);
    expect(alertMovable("resolved", "open")).toBe(true);
    expect(alertMovable("acknowledged", "open")).toBe(false);
    expect(alertMovable("resolved", "acknowledged")).toBe(false);
  });

  it("de-duplicates on rule plus subject", () => {
    expect(alertDedupeKey("slipped_promise", "abc")).toBe("slipped_promise:abc");
    expect(alertDedupeKey("slipped_promise", "abc")).not.toBe(
      alertDedupeKey("aging_breach", "abc"),
    );
  });

  it("reopens a resolved alert whose condition came back", () => {
    const now = new Date("2026-03-01T10:00:00Z");
    expect(
      shouldReopen({ status: "resolved", lastEventAt: new Date("2026-02-28"), dismissCount: 0 }, now),
    ).toBe(true);
  });

  it("does not reopen what a person dismissed yesterday", () => {
    // A detector reopening a dismissal the same night makes the dismiss button
    // a lie and teaches everybody to ignore the inbox.
    const now = new Date("2026-03-01T10:00:00Z");
    expect(
      shouldReopen(
        { status: "dismissed", lastEventAt: new Date("2026-02-28"), dismissCount: 1 },
        now,
      ),
    ).toBe(false);
  });

  it("lets a long-dismissed alert come back eventually", () => {
    const now = new Date("2026-05-01T10:00:00Z");
    expect(
      shouldReopen(
        { status: "dismissed", lastEventAt: new Date("2026-02-01"), dismissCount: 1 },
        now,
      ),
    ).toBe(true);
  });

  it("never reopens something already open", () => {
    const now = new Date("2026-03-01T10:00:00Z");
    expect(
      shouldReopen({ status: "open", lastEventAt: new Date("2026-02-01"), dismissCount: 0 }, now),
    ).toBe(false);
  });
});

describe("suggestThreshold", () => {
  it("says nothing until the dismissals pile up", () => {
    expect(suggestThreshold("expense_outlier", { modifiedZ: 3.5 }, 3)).toBeNull();
  });

  it("proposes a looser threshold for a human to approve", () => {
    const suggestion = suggestThreshold("slipped_promise", { graceDays: 1 }, 8);
    expect(suggestion).toMatchObject({ code: "slipped_promise", param: "graceDays", from: 1, to: 1.5 });
    expect(suggestion?.reason).toContain("Dismissed 8 times");
  });

  it("falls back to the catalogue default when the org has no override stored", () => {
    const suggestion = suggestThreshold("duplicate_expense", {}, 10);
    expect(suggestion).toMatchObject({ param: "withinDays", from: 7, to: 10.5 });
  });
});

describe("escalationTarget", () => {
  const slipped = advisorRule("slipped_promise"); // telecaller -> manager -> owner

  it("does not escalate before the first threshold", () => {
    expect(escalationTarget(slipped, 1)).toBeNull();
    expect(escalationTarget(slipped, 23.9)).toBeNull();
  });

  it("climbs to the manager at 24 h and the owner at 48 h (§15)", () => {
    expect(escalationTarget(slipped, 24)).toBe("manager");
    expect(escalationTarget(slipped, 47)).toBe("manager");
    expect(escalationTarget(slipped, 48)).toBe("owner");
    expect(escalationTarget(slipped, 500)).toBe("owner");
  });

  it("stops at the top of a short path instead of re-notifying the same person", () => {
    // `cash_runway_low` routes to the owner and has nowhere above them.
    const runway = advisorRule("cash_runway_low");
    expect(escalationTarget(runway, 72)).toBeNull();
  });

  it("honours an org's own ladder", () => {
    expect(escalationTarget(slipped, 5, [4, 8])).toBe("manager");
    expect(escalationTarget(slipped, 9, [4, 8])).toBe("owner");
  });
});

describe("inQuietHours", () => {
  it("covers the window that wraps midnight", () => {
    // 21:00-08:00. An AND-based range check here matches nothing, which is the
    // classic way quiet hours silently stop working.
    expect(inQuietHours(21)).toBe(true);
    expect(inQuietHours(23)).toBe(true);
    expect(inQuietHours(0)).toBe(true);
    expect(inQuietHours(7)).toBe(true);
    expect(inQuietHours(8)).toBe(false);
    expect(inQuietHours(12)).toBe(false);
    expect(inQuietHours(20)).toBe(false);
  });

  it("handles a same-day window too", () => {
    expect(inQuietHours(13, { from: 12, to: 14 })).toBe(true);
    expect(inQuietHours(15, { from: 12, to: 14 })).toBe(false);
  });

  it("treats a zero-length window as no quiet hours", () => {
    expect(inQuietHours(3, { from: 9, to: 9 })).toBe(false);
  });
});

describe("dueRemindersOwing", () => {
  it("owes T-3 three days before, and nothing earlier", () => {
    expect(dueRemindersOwing("2026-02-10", "2026-02-07", [])).toEqual([-3]);
    expect(dueRemindersOwing("2026-02-10", "2026-02-06", [])).toEqual([]);
  });

  it("owes the whole ladder once it is all behind us", () => {
    expect(dueRemindersOwing("2026-02-10", "2026-02-20", [])).toEqual([-3, 0, 3, 7]);
  });

  it("catches up in one tick after the worker was down, without skipping rungs", () => {
    // Down for two days: T0 and T+3 both come out now, not just the latest.
    expect(dueRemindersOwing("2026-02-10", "2026-02-13", [-3])).toEqual([0, 3]);
  });

  it("does not repeat what was already sent", () => {
    expect(dueRemindersOwing("2026-02-10", "2026-02-20", [-3, 0, 3, 7])).toEqual([]);
  });
});

describe("renderMessage", () => {
  it("fills the placeholders the detector supplied", () => {
    expect(
      renderMessage(advisorRule("slipped_promise").messageTemplate, {
        amount: "₹25,000.00",
        customer: "Sharma Textiles",
        date: "12 Feb",
      }),
    ).toBe("Payment of ₹25,000.00 from Sharma Textiles promised for 12 Feb not received.");
  });

  it("leaves a missing placeholder visible rather than printing 'undefined'", () => {
    // A template drifting from its detector should read as an obvious bug in
    // the inbox, not as a sentence that looks finished and is wrong.
    expect(renderMessage("Payment of {amount} from {customer}", { amount: "₹1" })).toBe(
      "Payment of ₹1 from {customer}",
    );
  });
});

describe("rankLeaks", () => {
  it("ranks by money first, severity second", () => {
    const ranked = rankLeaks([
      { id: "small-critical", amountAtRiskMinor: 200_000, severity: "critical" as const },
      { id: "big-high", amountAtRiskMinor: 40_000_000, severity: "high" as const },
      { id: "tie-low", amountAtRiskMinor: 200_000, severity: "low" as const },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["big-high", "small-critical", "tie-low"]);
  });

  it("puts an amountless alert last rather than crashing on null", () => {
    const ranked = rankLeaks([
      { id: "connector", amountAtRiskMinor: null, severity: "high" as const },
      { id: "dues", amountAtRiskMinor: 1, severity: "low" as const },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["dues", "connector"]);
  });
});
