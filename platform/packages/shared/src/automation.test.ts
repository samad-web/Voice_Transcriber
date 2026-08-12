import { describe, expect, it } from "vitest";

import {
  AutomationRuleInput,
  dueDate,
  matchesConditions,
  resolveTarget,
  type AutomationSubject,
} from "./automation";

/**
 * A rule that fires when it shouldn't creates work for people who don't need
 * it; a rule that silently never fires looks configured and isn't, which is
 * worse because nobody investigates it. Both directions are pinned here.
 */

const DEAL: AutomationSubject = {
  dealId: "11111111-1111-4111-8111-111111111111",
  contactId: "22222222-2222-4222-8222-222222222222",
  stage: "negotiation",
  fromStage: "qualified",
  toStage: "negotiation",
  status: "open",
  amount: 50_000,
  dealOwnerUserId: "33333333-3333-4333-8333-333333333333",
};

describe("matchesConditions", () => {
  it("matches everything when nothing is configured", () => {
    expect(matchesConditions({}, DEAL)).toBe(true);
    expect(matchesConditions({}, {})).toBe(true);
  });

  it("ANDs every condition", () => {
    expect(matchesConditions({ stage: ["negotiation"], status: ["open"] }, DEAL)).toBe(true);
    expect(matchesConditions({ stage: ["negotiation"], status: ["won"] }, DEAL)).toBe(false);
  });

  it("treats an EMPTY list as 'no condition', not 'match nothing'", () => {
    // The UI produces [] for a filter somebody opened and cleared. Reading
    // that as "match nothing" would silently disable the rule.
    expect(matchesConditions({ stage: [] }, DEAL)).toBe(true);
  });

  it("distinguishes moved-from and moved-to", () => {
    expect(matchesConditions({ fromStage: ["qualified"] }, DEAL)).toBe(true);
    expect(matchesConditions({ fromStage: ["negotiation"] }, DEAL)).toBe(false);
    expect(matchesConditions({ toStage: ["negotiation"] }, DEAL)).toBe(true);
  });

  it("applies amount bounds inclusively", () => {
    expect(matchesConditions({ amountGte: 50_000 }, DEAL)).toBe(true);
    expect(matchesConditions({ amountLte: 50_000 }, DEAL)).toBe(true);
    expect(matchesConditions({ amountGte: 50_001 }, DEAL)).toBe(false);
    expect(matchesConditions({ amountGte: 10_000, amountLte: 20_000 }, DEAL)).toBe(false);
  });

  it("does NOT match an amount condition when the deal has no amount", () => {
    // "at least 10,000" must not fire on a deal worth nobody-knows. Somebody
    // writing that rule meant a number, not "or unknown".
    const noAmount = { ...DEAL, amount: null };
    expect(matchesConditions({ amountGte: 10_000 }, noAmount)).toBe(false);
    expect(matchesConditions({ amountLte: 10_000 }, noAmount)).toBe(false);
  });

  it("treats amount 0 as a real value, not a missing one", () => {
    expect(matchesConditions({ amountLte: 100 }, { ...DEAL, amount: 0 })).toBe(true);
  });

  it("does not match a condition the subject has no field for", () => {
    // A stage condition on a contact event. The rule is misconfigured, and
    // not firing is the right answer — firing on everything would be worse.
    expect(matchesConditions({ stage: ["negotiation"] }, { contactId: "x" })).toBe(false);
  });

  it("compares idleDays as a floor, not an equality", () => {
    expect(matchesConditions({ idleDays: 14 }, { ...DEAL, idleDays: 30 })).toBe(true);
    expect(matchesConditions({ idleDays: 14 }, { ...DEAL, idleDays: 13 })).toBe(false);
    expect(matchesConditions({ idleDays: 14 }, { ...DEAL, idleDays: 14 })).toBe(true);
  });
});

describe("resolveTarget", () => {
  it("resolves each role against the subject", () => {
    expect(resolveTarget("deal_owner", DEAL)).toBe(DEAL.dealOwnerUserId);
    expect(resolveTarget("contact_owner", DEAL)).toBeNull();
    expect(resolveTarget("task_assignee", { taskAssigneeUserId: "u" })).toBe("u");
  });

  it("passes a literal user id straight through", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(resolveTarget(id, DEAL)).toBe(id);
  });

  it("returns null rather than guessing when the role is empty", () => {
    // An unowned deal is a normal state. The executor reports "nobody to
    // notify" rather than picking somebody.
    expect(resolveTarget("deal_owner", { ...DEAL, dealOwnerUserId: null })).toBeNull();
  });
});

describe("dueDate", () => {
  const now = new Date("2026-08-12T18:30:00Z");

  it("adds whole days", () => {
    expect(dueDate(0, now)).toBe("2026-08-12");
    expect(dueDate(1, now)).toBe("2026-08-13");
    expect(dueDate(30, now)).toBe("2026-09-11");
  });

  it("crosses a month and a year boundary", () => {
    expect(dueDate(1, new Date("2026-12-31T00:00:00Z"))).toBe("2027-01-01");
    expect(dueDate(1, new Date("2028-02-28T00:00:00Z"))).toBe("2028-02-29");
  });
});

describe("AutomationRuleInput validation", () => {
  const base = {
    name: "Chase big deals",
    trigger: "deal.stage_changed" as const,
    actions: [{ type: "create_task" as const, title: "Call them" }],
  };

  it("accepts a minimal rule and fills in the defaults", () => {
    const parsed = AutomationRuleInput.parse(base);
    expect(parsed.status).toBe("active");
    expect(parsed.conditions).toEqual({});
    expect(parsed.actions[0]).toMatchObject({ dueInDays: 1, priority: "normal", assignTo: "deal_owner" });
  });

  it("requires at least one action — a rule that does nothing is a bug", () => {
    expect(AutomationRuleInput.safeParse({ ...base, actions: [] }).success).toBe(false);
  });

  it("rejects a stage condition on a trigger that has no stage change", () => {
    const bad = AutomationRuleInput.safeParse({
      ...base,
      trigger: "contact.created",
      conditions: { toStage: ["won"] },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an interactionType condition on a non-interaction trigger", () => {
    const bad = AutomationRuleInput.safeParse({
      ...base,
      conditions: { interactionType: ["call"] },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects moving a deal from a trigger that has no deal", () => {
    const bad = AutomationRuleInput.safeParse({
      ...base,
      trigger: "contact.created",
      actions: [{ type: "move_stage", stage: "won" }],
    });
    expect(bad.success).toBe(false);
  });

  it("has no send-an-email action at all", () => {
    // The property this test exists to protect: everything the engine can do
    // is reversible and stays inside the console. Adding a sender here would
    // be a change of risk class, not a feature.
    const bad = AutomationRuleInput.safeParse({
      ...base,
      actions: [{ type: "send_email", to: "anyone@example.com", subject: "hi", body: "hi" }],
    });
    expect(bad.success).toBe(false);
  });
});
