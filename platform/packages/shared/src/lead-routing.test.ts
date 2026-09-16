import { describe, expect, it } from "vitest";
import {
  firstMatchingRule,
  formatPct,
  LeadRoutingRuleInput,
  LeadRoutingRulePatch,
  pickRoutingTarget,
  ruleMatchesLead,
  shareReality,
  sharesProblem,
  simulateRouting,
  type LeadRoutingStrategy,
  type RoutableLead,
  type RoutingCandidate,
} from "./lead-routing";

function target(
  name: string,
  overrides: Partial<RoutingCandidate> = {},
  position = 0,
): RoutingCandidate {
  return {
    id: `t-${name}`,
    telecallerId: `tc-${name}`,
    name,
    position,
    sharePct: 0,
    delivered: 0,
    paused: false,
    dailyCap: null,
    assignedToday: 0,
    ...overrides,
  };
}

/**
 * Run `count` leads through the engine the way the database does: pick, then
 * write back the cursor and the delivered count. Every sequence assertion in
 * this file goes through here, so a bug in the state hand-off shows up as a
 * wrong split rather than hiding behind a hand-maintained expectation.
 */
function distribute(
  strategy: LeadRoutingStrategy,
  candidates: RoutingCandidate[],
  count: number,
  startCursor = 0,
): { names: string[]; unassigned: number; cursor: number } {
  const scratch = candidates.map((c) => ({ ...c }));
  const names: string[] = [];
  let cursor = startCursor;
  let unassigned = 0;

  for (let i = 0; i < count; i += 1) {
    const decision = pickRoutingTarget(strategy, scratch, cursor);
    cursor = decision.nextCursor;
    if (!decision.picked) {
      unassigned += 1;
      continue;
    }
    names.push(decision.picked.name);
    const row = scratch.find((c) => c.id === decision.picked?.id)!;
    row.delivered += 1;
    row.assignedToday += 1;
  }
  return { names, unassigned, cursor };
}

function tally(names: string[]): Record<string, number> {
  return names.reduce<Record<string, number>>((acc, n) => {
    acc[n] = (acc[n] ?? 0) + 1;
    return acc;
  }, {});
}

describe("round robin", () => {
  const team = [target("A", {}, 0), target("B", {}, 1), target("C", {}, 2)];

  it("rotates strictly and wraps", () => {
    expect(distribute("round_robin", team, 7).names).toEqual([
      "A",
      "B",
      "C",
      "A",
      "B",
      "C",
      "A",
    ]);
  });

  it("resumes from a stored cursor rather than restarting", () => {
    expect(distribute("round_robin", team, 3, 1).names).toEqual(["B", "C", "A"]);
  });

  it("splits an exact multiple perfectly evenly", () => {
    expect(tally(distribute("round_robin", team, 300).names)).toEqual({ A: 100, B: 100, C: 100 });
  });

  it("never differs by more than one lead at any point in the stream", () => {
    const scratch = team.map((c) => ({ ...c }));
    let cursor = 0;
    for (let i = 0; i < 100; i += 1) {
      const decision = pickRoutingTarget("round_robin", scratch, cursor);
      cursor = decision.nextCursor;
      scratch.find((c) => c.id === decision.picked!.id)!.delivered += 1;

      const counts = scratch.map((c) => c.delivered);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
  });

  it("steps over a paused telecaller without losing their place in the order", () => {
    const withPause = [target("A", {}, 0), target("B", { paused: true }, 1), target("C", {}, 2)];
    expect(distribute("round_robin", withPause, 4).names).toEqual(["A", "C", "A", "C"]);
  });

  it("does not let somebody who returns from a pause jump the queue", () => {
    // The cursor advanced PAST B while they were paused. When B comes back the
    // rotation continues from where it is; B does not immediately collect the
    // turn they missed.
    const back = [target("A", {}, 0), target("B", {}, 1), target("C", {}, 2)];
    expect(distribute("round_robin", back, 2, 2).names).toEqual(["C", "A"]);
  });

  it("stops handing leads to somebody at their daily cap", () => {
    const capped = [
      target("A", { dailyCap: 2 }, 0),
      target("B", {}, 1),
    ];
    expect(distribute("round_robin", capped, 6).names).toEqual(["A", "B", "A", "B", "B", "B"]);
  });

  it("leaves the lead unassigned when everyone is capped, and says so", () => {
    const full = [target("A", { dailyCap: 1, assignedToday: 1 }, 0)];
    const decision = pickRoutingTarget("round_robin", full, 0);
    expect(decision.picked).toBeNull();
    expect(decision.refusal).toBe("all_capped");
  });

  it("distinguishes an empty rule from a fully paused one", () => {
    expect(pickRoutingTarget("round_robin", [], 0).refusal).toBe("no_targets");
    expect(pickRoutingTarget("round_robin", [target("A", { paused: true })], 0).refusal).toBe(
      "all_paused",
    );
  });

  it("survives a cursor no writer produces", () => {
    // A hand-edited row, or a target list that shrank. Must land in range
    // rather than throwing - this runs inside the intake transaction.
    expect(pickRoutingTarget("round_robin", team, -7).picked?.name).toBe("C");
    expect(pickRoutingTarget("round_robin", team, 1_000_000).picked).not.toBeNull();
  });
});

describe("percentage split", () => {
  const fiftyThirtyTwenty = [
    target("A", { sharePct: 50 }, 0),
    target("B", { sharePct: 30 }, 1),
    target("C", { sharePct: 20 }, 2),
  ];

  it("holds the ratio exactly over a round number of leads", () => {
    expect(tally(distribute("percentage", fiftyThirtyTwenty, 100).names)).toEqual({
      A: 50,
      B: 30,
      C: 20,
    });
  });

  it("holds it over a thousand", () => {
    expect(tally(distribute("percentage", fiftyThirtyTwenty, 1000).names)).toEqual({
      A: 500,
      B: 300,
      C: 200,
    });
  });

  it("is never more than one lead away from the exact share, at any point", () => {
    // The property that makes this different from a dice roll: it is not just
    // right in the limit, it is right on lead nine.
    const scratch = fiftyThirtyTwenty.map((c) => ({ ...c }));
    let cursor = 0;
    for (let n = 1; n <= 200; n += 1) {
      const decision = pickRoutingTarget("percentage", scratch, cursor);
      cursor = decision.nextCursor;
      scratch.find((c) => c.id === decision.picked!.id)!.delivered += 1;

      for (const c of scratch) {
        expect(Math.abs(c.delivered - (c.sharePct / 100) * n)).toBeLessThan(1);
      }
    }
  });

  it("never gives the same person three in a row on a 50/30/20 desk", () => {
    // The failure mode a random implementation has and this one does not.
    const { names } = distribute("percentage", fiftyThirtyTwenty, 300);
    for (let i = 2; i < names.length; i += 1) {
      expect([names[i - 2], names[i - 1], names[i]]).not.toEqual([names[i], names[i], names[i]]);
    }
  });

  it("degenerates to strict rotation when the shares are equal", () => {
    const even = [
      target("A", { sharePct: 25 }, 0),
      target("B", { sharePct: 25 }, 1),
      target("C", { sharePct: 25 }, 2),
      target("D", { sharePct: 25 }, 3),
    ];
    expect(distribute("percentage", even, 8).names).toEqual([
      "A",
      "B",
      "C",
      "D",
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  it("handles thirds without drifting", () => {
    const thirds = [
      target("A", { sharePct: 33.333 }, 0),
      target("B", { sharePct: 33.333 }, 1),
      target("C", { sharePct: 33.334 }, 2),
    ];
    expect(tally(distribute("percentage", thirds, 99).names)).toEqual({ A: 33, B: 33, C: 33 });
  });

  it("re-normalises over whoever is available when somebody is paused", () => {
    // 50/30/20 with C on leave becomes 62.5/37.5 between A and B - the desk
    // does not silently drop a fifth of its leads.
    const withLeave = [
      target("A", { sharePct: 50 }, 0),
      target("B", { sharePct: 30 }, 1),
      target("C", { sharePct: 20, paused: true }, 2),
    ];
    const counts = tally(distribute("percentage", withLeave, 80).names);
    expect(counts.C).toBeUndefined();
    expect(counts.A).toBe(50);
    expect(counts.B).toBe(30);
  });

  it("carries the rest of the split when one person hits their cap", () => {
    const capped = [
      target("A", { sharePct: 50, dailyCap: 10 }, 0),
      target("B", { sharePct: 50 }, 1),
    ];
    const counts = tally(distribute("percentage", capped, 40).names);
    expect(counts.A).toBe(10);
    expect(counts.B).toBe(30);
  });

  it("treats a zero share as on-the-list-but-not-receiving", () => {
    const benched = [
      target("A", { sharePct: 100 }, 0),
      target("B", { sharePct: 0 }, 1),
    ];
    expect(tally(distribute("percentage", benched, 10).names)).toEqual({ A: 10 });
  });

  it("calls out an all-zero rule rather than blaming staffing", () => {
    const decision = pickRoutingTarget("percentage", [target("A", { sharePct: 0 })], 0);
    expect(decision.picked).toBeNull();
    expect(decision.refusal).toBe("no_share");
  });

  it("picks up mid-window from stored delivered counts", () => {
    // A restarted process, or a rule edited without resetting: the state is on
    // the rows, so the split continues rather than starting over.
    const midway = [
      target("A", { sharePct: 50, delivered: 40 }, 0),
      target("B", { sharePct: 50, delivered: 10 }, 1),
    ];
    // B is 15 leads behind and collects until they are level.
    expect(distribute("percentage", midway, 30).names.filter((n) => n === "B")).toHaveLength(30);
  });

  it("explains every decision in words a manager can check", () => {
    const decision = pickRoutingTarget("percentage", fiftyThirtyTwenty, 0);
    expect(decision.reason).toContain("A");
    expect(decision.reason).toContain("50%");
  });
});

describe("simulateRouting", () => {
  it("previews the same sequence the engine will actually produce", () => {
    const team = [target("A", {}, 0), target("B", {}, 1), target("C", {}, 2)];
    const preview = simulateRouting("round_robin", team, 0, 5).map((d) => d.picked?.name);
    expect(preview).toEqual(distribute("round_robin", team, 5).names);
  });

  it("shows the rotation stepping over somebody who fills up partway through", () => {
    const team = [target("A", { dailyCap: 1 }, 0), target("B", {}, 1)];
    expect(simulateRouting("round_robin", team, 0, 4).map((d) => d.picked?.name)).toEqual([
      "A",
      "B",
      "B",
      "B",
    ]);
  });

  it("stops early instead of repeating an identical refusal", () => {
    expect(simulateRouting("round_robin", [], 0, 5)).toHaveLength(1);
  });

  it("mutates nothing", () => {
    const team = [target("A", {}, 0), target("B", {}, 1)];
    simulateRouting("round_robin", team, 0, 10);
    expect(team.map((c) => c.delivered)).toEqual([0, 0]);
  });
});

describe("ruleMatchesLead", () => {
  const lead: RoutableLead = {
    sourceChannel: "web_form",
    leadSourceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    value: 50000,
  };

  it("matches everything when no criteria are set", () => {
    expect(ruleMatchesLead({}, lead)).toBe(true);
  });

  it("ANDs across criteria and ORs within one", () => {
    expect(ruleMatchesLead({ sourceChannels: ["web_form", "meta_ads"] }, lead)).toBe(true);
    expect(
      ruleMatchesLead({ sourceChannels: ["web_form"], projectIds: [lead.projectId!] }, lead),
    ).toBe(true);
    expect(
      ruleMatchesLead(
        { sourceChannels: ["web_form"], projectIds: ["33333333-3333-4333-8333-333333333333"] },
        lead,
      ),
    ).toBe(false);
  });

  it("treats an empty list as no criterion, not as match-nothing", () => {
    // A rule that silently stops matching everything is the worst failure an
    // automation has: it looks configured and it is not.
    expect(ruleMatchesLead({ sourceChannels: [] }, lead)).toBe(true);
  });

  it("does not match a null field against a list", () => {
    expect(ruleMatchesLead({ projectIds: ["22222222-2222-4222-8222-222222222222"] }, {
      ...lead,
      projectId: null,
    })).toBe(false);
  });

  it("never treats an absent value as zero", () => {
    // Otherwise every unvalued enquiry falls into the "small deals" rule
    // instead of dropping through to the catch-all.
    expect(ruleMatchesLead({ minValue: 0 }, { ...lead, value: null })).toBe(false);
    expect(ruleMatchesLead({ minValue: 100000 }, lead)).toBe(false);
    expect(ruleMatchesLead({ minValue: 50000 }, lead)).toBe(true);
  });
});

describe("firstMatchingRule", () => {
  const lead: RoutableLead = {
    sourceChannel: "meta_ads",
    leadSourceId: null,
    projectId: null,
    value: null,
  };

  it("takes the first match in the order it was given", () => {
    const rules = [
      { id: "specific", match: { sourceChannels: ["meta_ads" as const] } },
      { id: "catch-all", match: {} },
    ];
    expect(firstMatchingRule(rules, lead)?.id).toBe("specific");
  });

  it("falls through to a catch-all", () => {
    const rules = [
      { id: "forms", match: { sourceChannels: ["web_form" as const] } },
      { id: "catch-all", match: {} },
    ];
    expect(firstMatchingRule(rules, lead)?.id).toBe("catch-all");
  });

  it("returns null when nothing matches", () => {
    expect(firstMatchingRule([{ id: "forms", match: { sourceChannels: ["web_form" as const] } }], lead))
      .toBeNull();
  });
});

describe("sharesProblem", () => {
  it("ignores the round-robin strategy entirely", () => {
    expect(sharesProblem("round_robin", [{ sharePct: 10 }, { sharePct: 10 }])).toBeNull();
  });

  it("accepts an exact 100", () => {
    expect(sharesProblem("percentage", [{ sharePct: 50 }, { sharePct: 30 }, { sharePct: 20 }]))
      .toBeNull();
  });

  it("accepts thirds", () => {
    expect(
      sharesProblem("percentage", [
        { sharePct: 33.333 },
        { sharePct: 33.333 },
        { sharePct: 33.334 },
      ]),
    ).toBeNull();
  });

  it("rejects a split that does not add up, and says what it adds up to", () => {
    const problem = sharesProblem("percentage", [{ sharePct: 50 }, { sharePct: 30 }]);
    expect(problem).toContain("80%");
  });

  it("counts a paused target's share - they are still on the split", () => {
    // Re-normalisation happens at PICK time over who is available. Excluding
    // them here would mean the total silently changed the moment somebody was
    // paused, and the form would start rejecting a split it had accepted.
    expect(
      sharesProblem("percentage", [{ sharePct: 60, paused: true }, { sharePct: 40 }]),
    ).toBeNull();
  });

  it("allows an empty rule", () => {
    expect(sharesProblem("percentage", [])).toBeNull();
  });
});

describe("shareReality", () => {
  it("reports an even split as round robin's target", () => {
    const reality = shareReality("round_robin", [
      target("A", { delivered: 6 }, 0),
      target("B", { delivered: 4 }, 1),
    ]);
    expect(reality.map((r) => r.targetPct)).toEqual([50, 50]);
    expect(reality.map((r) => r.actualPct)).toEqual([60, 40]);
    expect(reality[0].driftPct).toBe(10);
  });

  it("shows the drift a paused telecaller causes", () => {
    const reality = shareReality("percentage", [
      target("A", { sharePct: 50, delivered: 80 }, 0),
      target("B", { sharePct: 30, delivered: 20 }, 1),
      target("C", { sharePct: 20, delivered: 0, paused: true }, 2),
    ]);
    expect(reality[2].targetPct).toBe(20);
    expect(reality[2].actualPct).toBe(0);
    expect(reality[2].driftPct).toBe(-20);
  });

  it("reports zeroes rather than NaN before the first lead", () => {
    const reality = shareReality("percentage", [target("A", { sharePct: 100 }, 0)]);
    expect(reality[0].actualPct).toBe(0);
  });
});

describe("formatPct", () => {
  it("does not print float noise", () => {
    expect(formatPct(33.333 + 33.333 + 33.334)).toBe("100%");
    expect(formatPct(33.333)).toBe("33.3%");
    expect(formatPct(50)).toBe("50%");
  });
});

describe("the rule schemas", () => {
  it("fills defaults on CREATE, where unspecified means give me the default", () => {
    const parsed = LeadRoutingRuleInput.parse({ name: "Web forms", strategy: "round_robin" });
    expect(parsed.match).toEqual({});
    expect(parsed.priority).toBe(100);
    expect(parsed.status).toBe("active");
  });

  it("fills NOTHING on PATCH, where unspecified means leave it alone", () => {
    // The regression this guards. `LeadRoutingRuleInput.partial()` looks like
    // the obvious patch schema and is not: `.partial()` does not strip
    // `.default()`, so an absent key still materialises its default. The Pause
    // button sends `{ status }` alone - under the partial schema that arrived
    // at the API carrying `match: {}` and `priority: 100`, and pausing a rule
    // silently erased the channel criteria it was written with.
    const parsed = LeadRoutingRulePatch.parse({ status: "paused" });
    expect(parsed).toEqual({ status: "paused" });
    expect("match" in parsed).toBe(false);
    expect("priority" in parsed).toBe(false);
  });

  it("still validates the fields it is given", () => {
    expect(LeadRoutingRulePatch.safeParse({ priority: -1 }).success).toBe(false);
    expect(LeadRoutingRulePatch.safeParse({ strategy: "random" }).success).toBe(false);
    expect(LeadRoutingRulePatch.safeParse({ name: "" }).success).toBe(false);
  });

  it("lets an empty patch through, so the controller can reject it by name", () => {
    // `{}` is a valid patch shape and a meaningless request. The controller
    // answers "no fields to update"; the schema should not pretend it is
    // malformed.
    expect(LeadRoutingRulePatch.parse({})).toEqual({});
  });
});
