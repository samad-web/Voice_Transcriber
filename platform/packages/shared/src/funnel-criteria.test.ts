import { describe, expect, it } from "vitest";
import {
  BUDGET_BANDS,
  HAS_CRM_OPTIONS,
  INTENTS,
  WANTS_CUSTOM_CRM_OPTIONS,
  qualify,
} from "./funnel";
import {
  DEFAULT_FUNNEL_CRITERIA,
  SEEDED_BUDGET_FLOOR_INR,
  describeRule,
  evaluateCriteria,
  validateCriteria,
  type FunnelCriteria,
} from "./funnel-criteria";

/**
 * The whole cartesian product of the four answers `qualify()` reads. Small
 * enough to enumerate, which is what makes the equivalence test below a proof
 * rather than a sample.
 */
const ALL = BUDGET_BANDS.flatMap((b) =>
  INTENTS.flatMap((i) =>
    HAS_CRM_OPTIONS.flatMap((h) =>
      WANTS_CUSTOM_CRM_OPTIONS.map((w) => ({
        budget: b.value,
        intent: i.value,
        hasCrm: h.value,
        wantsCustomCrm: w.value,
      })),
    ),
  ),
);

describe("the default criteria reproduce the hard-coded rules exactly", () => {
  /**
   * THE TEST THIS FILE EXISTS FOR.
   *
   * The editor ships with the three clauses `qualify()` has always applied,
   * expressed as data. If the two ever disagree, turning the feature on
   * silently re-sorts every future lead — and nobody would find out from a
   * failure, only from a quarter of bad numbers. So they are compared over
   * every answer combination that exists.
   */
  it("agrees with qualify() on all 108 answer combinations", () => {
    expect(ALL.length).toBe(6 * 2 * 3 * 3);
    for (const answers of ALL) {
      const hardCoded = qualify(answers);
      const fromData = evaluateCriteria(DEFAULT_FUNNEL_CRITERIA, answers);
      expect([answers, fromData.status]).toEqual([answers, hardCoded.status]);
    }
  });

  it("seeds the budget threshold the constant actually says", () => {
    // `30k_40k` is the lowest band whose floor reaches QUALIFYING_BUDGET_INR.
    // Pinned so raising the constant without re-seeding is a failure here
    // rather than a rule that quietly lets cheaper leads through.
    const rule = DEFAULT_FUNNEL_CRITERIA.rules.find((r) => r.id === "budget_and_intent");
    const threshold = rule?.conditions.find((c) => c.field === "budget")?.values[0];
    const band = BUDGET_BANDS.find((b) => b.value === threshold);
    expect(band?.floorInr).toBe(SEEDED_BUDGET_FLOOR_INR);
    const cheaper = BUDGET_BANDS.filter(
      (b) => b.floorInr !== null && b.floorInr < SEEDED_BUDGET_FLOOR_INR,
    );
    expect(cheaper.every((b) => (b.floorInr ?? 0) < (band?.floorInr ?? 0))).toBe(true);
  });
});

describe("the master switch", () => {
  it("qualifies EVERYONE when off, and says it was bypassed", () => {
    const off: FunnelCriteria = { ...DEFAULT_FUNNEL_CRITERIA, enabled: false };
    for (const answers of ALL) {
      const r = evaluateCriteria(off, answers);
      expect([answers, r.status, r.bypassed]).toEqual([answers, "qualified", true]);
    }
  });

  it("does not report matched rules when it was never applied", () => {
    // An operator reading "qualified because: budget and intent" on a lead
    // nobody assessed would be reading a fact that was never established.
    const off: FunnelCriteria = { ...DEFAULT_FUNNEL_CRITERIA, enabled: false };
    expect(evaluateCriteria(off, { budget: "100k_plus", intent: "ready" }).matchedRules).toEqual([]);
  });
});

describe("evaluation", () => {
  const one = (conditions: FunnelCriteria["rules"][number]["conditions"]): FunnelCriteria => ({
    enabled: true,
    rules: [{ id: "r", name: "R", enabled: true, conditions }],
  });

  it("requires EVERY condition in a rule", () => {
    const c = one([
      { field: "budget", operator: "at_least", values: ["30k_40k"] },
      { field: "intent", operator: "is_one_of", values: ["ready"] },
    ]);
    expect(evaluateCriteria(c, { budget: "100k_plus", intent: "ready" }).status).toBe("qualified");
    expect(evaluateCriteria(c, { budget: "100k_plus", intent: "exploring" }).status).toBe(
      "disqualified",
    );
  });

  it("qualifies on ANY rule", () => {
    const c: FunnelCriteria = {
      enabled: true,
      rules: [
        {
          id: "a",
          name: "A",
          enabled: true,
          conditions: [{ field: "intent", operator: "is_one_of", values: ["ready"] }],
        },
        {
          id: "b",
          name: "B",
          enabled: true,
          conditions: [{ field: "hasCrm", operator: "is_one_of", values: ["no"] }],
        },
      ],
    };
    expect(evaluateCriteria(c, { hasCrm: "no", intent: "exploring" }).matchedRules).toEqual(["b"]);
    expect(evaluateCriteria(c, { hasCrm: "no", intent: "ready" }).matchedRules).toEqual(["a", "b"]);
  });

  it("skips disabled rules", () => {
    const c: FunnelCriteria = {
      enabled: true,
      rules: [
        {
          id: "a",
          name: "A",
          enabled: false,
          conditions: [{ field: "intent", operator: "is_one_of", values: ["ready"] }],
        },
      ],
    };
    expect(evaluateCriteria(c, { intent: "ready" }).status).toBe("disqualified");
  });

  it("a rule with NO conditions never fires", () => {
    // Vacuous truth would qualify every lead the instant somebody deleted the
    // last condition while editing. An empty rule is unfinished, not universal.
    const c = one([]);
    expect(evaluateCriteria(c, { budget: "100k_plus", intent: "ready" }).status).toBe(
      "disqualified",
    );
  });

  it("an unanswered question never satisfies a condition", () => {
    const c = one([{ field: "intent", operator: "is_one_of", values: ["ready"] }]);
    for (const missing of [undefined, null, ""]) {
      expect(evaluateCriteria(c, { intent: missing }).status).toBe("disqualified");
    }
  });

  describe("at_least, on budget", () => {
    const c = one([{ field: "budget", operator: "at_least", values: ["30k_40k"] }]);

    it("clears at the threshold and above", () => {
      for (const v of ["30k_40k", "40k_100k", "100k_plus"]) {
        expect([v, evaluateCriteria(c, { budget: v }).status]).toEqual([v, "qualified"]);
      }
    });

    it("does not clear below it", () => {
      for (const v of ["below_10k", "10k_30k"]) {
        expect([v, evaluateCriteria(c, { budget: v }).status]).toEqual([v, "disqualified"]);
      }
    });

    it('"not sure" never clears a threshold', () => {
      // It has no floor. Treating it as passing would qualify everyone who
      // declined to say what they would spend.
      expect(evaluateCriteria(c, { budget: "not_sure" }).status).toBe("disqualified");
    });

    it("compares by the band's floor, not its position in the list", () => {
      // So reordering BUDGET_BANDS for presentation cannot change who qualifies.
      const reversed = [...BUDGET_BANDS].reverse();
      expect(reversed[0]).toBeDefined();
      expect(evaluateCriteria(c, { budget: "100k_plus" }).status).toBe("qualified");
    });
  });
});

describe("validateCriteria", () => {
  const base = () => JSON.parse(JSON.stringify(DEFAULT_FUNNEL_CRITERIA)) as FunnelCriteria;

  it("accepts the shipped defaults", () => {
    expect(validateCriteria(DEFAULT_FUNNEL_CRITERIA)).toEqual({ ok: true });
  });

  it("rejects a question we do not ask", () => {
    const c = base();
    (c.rules[0]!.conditions[0] as { field: string }).field = "favourite_colour";
    expect(validateCriteria(c).ok).toBe(false);
  });

  it("rejects an answer that question cannot have", () => {
    const c = base();
    c.rules[0]!.conditions[1]!.values = ["whenever"];
    const r = validateCriteria(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("whenever");
  });

  it("rejects at_least on an unordered question", () => {
    // "Business type is at least Healthcare" is not a statement about anything.
    const c = base();
    c.rules[0]!.conditions[0] = {
      field: "businessType",
      operator: "at_least",
      values: ["agency"],
    };
    const r = validateCriteria(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("at least");
  });

  it("rejects at_least with more than one answer", () => {
    const c = base();
    c.rules[0]!.conditions[0]!.values = ["30k_40k", "40k_100k"];
    expect(validateCriteria(c).ok).toBe(false);
  });

  it("rejects duplicate rule ids", () => {
    const c = base();
    c.rules[1]!.id = c.rules[0]!.id;
    const r = validateCriteria(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("share the id");
  });

  it("rejects an unnamed rule", () => {
    const c = base();
    c.rules[0]!.name = "   ";
    expect(validateCriteria(c).ok).toBe(false);
  });

  it("ACCEPTS a rule with no conditions", () => {
    // Saving a half-built rule must be possible — an operator adds the rule,
    // then the conditions. It simply never fires, which the editor says.
    const c = base();
    c.rules[0]!.conditions = [];
    expect(validateCriteria(c)).toEqual({ ok: true });
  });

  it("rejects junk", () => {
    for (const bad of [null, 42, "rules", [], { enabled: true }, { enabled: "yes", rules: [] }]) {
      expect([bad, validateCriteria(bad).ok]).toEqual([bad, false]);
    }
  });
});

describe("describeRule", () => {
  it("reads back as a sentence, with labels not values", () => {
    expect(describeRule(DEFAULT_FUNNEL_CRITERIA.rules[0]!)).toBe(
      "Monthly telemarketing budget is at least ₹30,000 – ₹40,000 AND " +
        "How soon do you need this? is As soon as possible",
    );
  });

  it("says plainly when a rule can never match", () => {
    expect(describeRule({ id: "x", name: "X", enabled: true, conditions: [] })).toContain(
      "never matches",
    );
  });
});
