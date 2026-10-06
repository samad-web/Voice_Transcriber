import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { HandsetState } from "./attendance";
import {
  firstMatchingRule,
  formatPct,
  LeadRoutingRuleInput,
  LeadRoutingRulePatch,
  LeadRoutingStickyFallback,
  LeadRoutingStrategy,
  pickRoutingTarget,
  resolveStickyConfig,
  ruleMatchesLead,
  shareReality,
  sharesProblem,
  simulateRouting,
  STICKY_DEFAULT_FALLBACK,
  STICKY_DEFAULT_WINDOW_DAYS,
  STICKY_OFF_SHIFT_STATES,
  stickyOwnerOnShift,
  type RoutableLead,
  type RoutingCandidate,
  type StickyContext,
  type StickyPriorOwner,
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

// ── sticky ownership (0160, Build docs/39 §14) ──────────────────────────────

function owner(
  telecallerId: string,
  overrides: Partial<StickyPriorOwner> = {},
): StickyPriorOwner {
  return { telecallerId, name: telecallerId.replace(/^tc-/, ""), leadCount: 1, ...overrides };
}

function stickyCtx(overrides: Partial<StickyContext> = {}): StickyContext {
  return {
    windowDays: 90,
    fallback: "round_robin",
    priorOwners: [],
    // The common tenant: attendance has never been switched on, so the shift
    // gate has nothing to read. Each test that is ABOUT attendance says so.
    attendanceTracked: false,
    ...overrides,
  };
}

describe("sticky: a returning caller reaches their previous owner", () => {
  const team = [target("A", {}, 0), target("B", {}, 1), target("C", {}, 2)];

  it("gives the lead to the one person who already owns the number", () => {
    const decision = pickRoutingTarget(
      "sticky",
      team,
      0,
      stickyCtx({ priorOwners: [owner("tc-B", { leadCount: 3 })] }),
    );
    expect(decision.picked?.name).toBe("B");
    expect(decision.sticky?.resolution).toBe("matched");
    expect(decision.refusal).toBeNull();
    expect(decision.reason).toContain("B already owns this number");
    expect(decision.reason).toContain("3 earlier leads in the last 90 days");
  });

  it("does not advance the rotation cursor when it matches", () => {
    // A repeat caller returning to their own person did not consume anybody's
    // turn. The next genuinely new lead must still go to whoever was next, or
    // stickiness quietly reorders the rotation for everybody else.
    const sticky = stickyCtx({ priorOwners: [owner("tc-C")] });
    expect(pickRoutingTarget("sticky", team, 1, sticky).nextCursor).toBe(1);

    const fellThrough = pickRoutingTarget("sticky", team, 1, stickyCtx());
    expect(fellThrough.picked?.name).toBe("B");
    expect(fellThrough.nextCursor).toBe(2);
  });

  it("falls through to the fallback when nobody here has spoken to the number", () => {
    const decision = pickRoutingTarget("sticky", team, 0, stickyCtx());
    expect(decision.sticky?.resolution).toBe("no_history");
    expect(decision.sticky?.fellBackTo).toBe("round_robin");
    expect(decision.picked?.name).toBe("A");
    expect(decision.reason).toContain("nobody here has spoken to this number in 90 days");
    expect(decision.reason).toContain("next in the rotation");
  });
});

/**
 * THE SINGLE MOST IMPORTANT BEHAVIOUR IN THIS PHASE.
 *
 * Two different people owned earlier leads from this number. Recency is a
 * tempting tie-break and it is wrong: it is right about half the time, and the
 * wrong half is INVISIBLE - the prospect reaches the wrong person, and the
 * right person never learns the call happened. 0146 made the same call for
 * `lead_for_unlinked_call` and its header is the argument.
 */
describe("sticky: two owners is ambiguous, never a guess", () => {
  const team = [target("A", {}, 0), target("B", {}, 1)];

  const collision = stickyCtx({
    priorOwners: [
      // Deliberately ordered and counted so that EVERY plausible tie-break
      // disagrees with the fallback: B is the most recent and has the most
      // leads, A is the first mention. Round robin from cursor 0 picks A.
      owner("tc-A", { leadCount: 1, lastLeadAt: "2026-01-01T00:00:00.000Z" }),
      owner("tc-B", { leadCount: 9, lastLeadAt: "2026-10-05T00:00:00.000Z" }),
    ],
  });

  it("does not pick the most recent owner", () => {
    const decision = pickRoutingTarget("sticky", team, 0, collision);
    expect(decision.sticky?.resolution).toBe("ambiguous");
    // A, because round robin said so - not B, who spoke to them last week.
    expect(decision.picked?.name).toBe("A");
  });

  it("does not pick the owner with the most history either", () => {
    // Same collision, cursor moved on: the answer tracks the FALLBACK, not any
    // property of the two owners. If a tie-break ever creeps in, exactly one
    // of these two tests still passes, which is why both are here.
    const decision = pickRoutingTarget("sticky", team, 1, collision);
    expect(decision.picked?.name).toBe("B");
    expect(decision.sticky?.resolution).toBe("ambiguous");
  });

  it("is visible rather than silent - it names both people in the ledger", () => {
    // §14: "a two-owner collision goes to the fallback and is visible". One
    // decision row per lead, so the one sentence has to carry both halves.
    const decision = pickRoutingTarget("sticky", team, 0, collision);
    expect(decision.reason).toContain("belong to different people");
    expect(decision.reason).toContain("A and B");
    expect(decision.reason).toContain("so the fallback ran");
    // And structured, so the console can badge it without parsing prose.
    expect(decision.sticky?.priorOwners.map((o) => o.telecallerId)).toEqual(["tc-A", "tc-B"]);
  });

  it("is still ambiguous when the collision would have been resolvable", () => {
    // B is off shift and A is free, so "pick the one who can take it" would
    // land on A. That is a guess wearing a justification: the number belongs
    // to whichever of them the customer thinks they are calling, and nobody
    // here knows which.
    const withShifts = [
      target("A", {}, 0),
      target("B", { handsetState: "OFF_SHIFT" }, 1),
    ];
    const decision = pickRoutingTarget(
      "sticky",
      withShifts,
      0,
      stickyCtx({ attendanceTracked: true, priorOwners: collision.priorOwners }),
    );
    expect(decision.sticky?.resolution).toBe("ambiguous");
  });

  it("does not mistake one owner's several leads for two owners", () => {
    // A caller that returned a row per lead instead of grouping. Counting that
    // person twice would send every single repeat caller to the fallback, and
    // the feature would look configured and do nothing.
    const decision = pickRoutingTarget(
      "sticky",
      team,
      0,
      stickyCtx({ priorOwners: [owner("tc-B", { leadCount: 1 }), owner("tc-B", { leadCount: 2 })] }),
    );
    expect(decision.sticky?.resolution).toBe("matched");
    expect(decision.picked?.name).toBe("B");
    expect(decision.reason).toContain("3 earlier leads");
  });
});

describe("sticky: an owner who cannot take it", () => {
  const team = [target("A", {}, 0), target("B", {}, 1)];
  const sticky = (candidates: RoutingCandidate[], extra: Partial<StickyContext> = {}) =>
    pickRoutingTarget("sticky", candidates, 0, stickyCtx({ priorOwners: [owner("tc-B")], ...extra }));

  it("falls back when the owner is paused", () => {
    const decision = sticky([target("A", {}, 0), target("B", { paused: true }, 1)]);
    expect(decision.sticky?.resolution).toBe("owner_unavailable");
    expect(decision.sticky?.unavailable).toBe("paused");
    expect(decision.picked?.name).toBe("A");
    expect(decision.reason).toContain("B owns this number");
    expect(decision.reason).toContain("paused");
  });

  it("falls back when the owner is at their daily cap", () => {
    const decision = sticky([
      target("A", {}, 0),
      target("B", { dailyCap: 5, assignedToday: 5 }, 1),
    ]);
    expect(decision.sticky?.unavailable).toBe("capped");
    expect(decision.picked?.name).toBe("A");
    expect(decision.reason).toContain("daily cap of 5");
  });

  it("falls back when the owner is not on this rule at all", () => {
    // They left, were archived, or work another desk. Routing may only hand a
    // lead to somebody the rule names - that list is also where the daily cap
    // lives, so assigning off it would be an assignment with no ceiling.
    const decision = pickRoutingTarget(
      "sticky",
      team,
      0,
      stickyCtx({ priorOwners: [owner("tc-Z", { name: "Zoya" })] }),
    );
    expect(decision.sticky?.unavailable).toBe("not_on_rule");
    expect(decision.reason).toContain("Zoya owns this number");
    expect(decision.reason).toContain("not on this rule");
    expect(decision.picked?.name).toBe("A");
  });

  it("names an archived owner it can no longer identify, rather than going quiet", () => {
    const decision = pickRoutingTarget(
      "sticky",
      team,
      0,
      stickyCtx({ priorOwners: [owner("tc-Z", { name: null })] }),
    );
    expect(decision.reason).toContain("somebody no longer on the roster");
  });
});

/**
 * §14: "Attendance is a real coupling, not a nicety: a sticky owner who is
 * absent must not accumulate leads all day."
 *
 * It is also the coupling most likely to turn the feature off by accident:
 * `organizations.attendance_enabled` defaults FALSE and most tenants have
 * never touched it, so a gate that fired on missing presence would send every
 * sticky lead to the fallback forever, for a reason nobody would connect to a
 * switch on another page.
 */
describe("sticky: the attendance gate", () => {
  const team = () => [target("A", {}, 0), target("B", {}, 1)];
  const withState = (state: HandsetState | null) => [
    target("A", {}, 0),
    target("B", { handsetState: state }, 1),
  ];
  const tracked = (priorOwners: StickyPriorOwner[]) =>
    stickyCtx({ attendanceTracked: true, priorOwners });

  for (const state of STICKY_OFF_SHIFT_STATES) {
    it(`sends the lead to the fallback when the owner is ${state}`, () => {
      const decision = pickRoutingTarget("sticky", withState(state), 0, tracked([owner("tc-B")]));
      expect(decision.sticky?.unavailable).toBe("off_shift");
      expect(decision.picked?.name).toBe("A");
      expect(decision.reason).toContain(state === "AWAY" ? "away" : "off shift");
    });
  }

  const AT_WORK = HandsetState.options.filter(
    (s) => !(STICKY_OFF_SHIFT_STATES as readonly string[]).includes(s),
  );

  for (const state of AT_WORK) {
    it(`keeps the lead with the owner when they are ${state}`, () => {
      const decision = pickRoutingTarget("sticky", withState(state), 0, tracked([owner("tc-B")]));
      expect(decision.sticky?.resolution).toBe("matched");
      expect(decision.picked?.name).toBe("B");
    });
  }

  /**
   * The pin. A ninth `HandsetState` must not silently join one side: whichever
   * side it lands on is a decision about whether somebody in that state keeps
   * collecting repeat callers all day.
   */
  it("classifies every HandsetState, so a new one cannot slip in unclassified", () => {
    expect([...STICKY_OFF_SHIFT_STATES].sort()).toEqual(["AWAY", "OFF_SHIFT"]);
    expect([...AT_WORK].sort()).toEqual([
      "ACTIVE",
      "BREAK_DUE",
      "IN_CALL",
      "ON_BREAK",
      "PROMPTING",
      "TECHNICAL",
    ]);
    expect(AT_WORK.length + STICKY_OFF_SHIFT_STATES.length).toBe(HandsetState.options.length);
  });

  it("ignores presence entirely when the workspace does not collect it", () => {
    // Including a stale state left over from a trial of attendance. If the
    // switch is off, the data is not evidence of anything.
    const decision = pickRoutingTarget(
      "sticky",
      withState("OFF_SHIFT"),
      0,
      stickyCtx({ attendanceTracked: false, priorOwners: [owner("tc-B")] }),
    );
    expect(decision.picked?.name).toBe("B");
    expect(decision.reason).toContain("attendance is off for this workspace");
  });

  it("treats a telecaller who has never reported presence as available, and says so", () => {
    // A console-only person with no handset. Silence is not absence, and
    // reading it as absence would quietly bar exactly those people from ever
    // owning a repeat caller.
    for (const absentRow of [null, undefined]) {
      const decision = pickRoutingTarget(
        "sticky",
        absentRow === null ? withState(null) : team(),
        0,
        tracked([owner("tc-B")]),
      );
      expect(decision.picked?.name).toBe("B");
      expect(decision.reason).toContain("never reported from a handset");
    }
  });

  it("states the on-shift evidence in the ledger rather than just asserting it", () => {
    const decision = pickRoutingTarget("sticky", withState("IN_CALL"), 0, tracked([owner("tc-B")]));
    expect(decision.reason).toContain("on shift (IN_CALL)");
  });

  it("is the same predicate the engine uses, exposed for callers", () => {
    expect(stickyOwnerOnShift({ handsetState: "ACTIVE" }, true)).toBe(true);
    expect(stickyOwnerOnShift({ handsetState: "AWAY" }, true)).toBe(false);
    expect(stickyOwnerOnShift({ handsetState: "AWAY" }, false)).toBe(true);
    expect(stickyOwnerOnShift({ handsetState: null }, true)).toBe(true);
    expect(stickyOwnerOnShift({}, true)).toBe(true);
  });

  it("never gates round robin or percentage on presence", () => {
    // Stickiness is the one strategy that can bury one person under a whole
    // day's leads, which is why it is the one that asks. A rotation that
    // silently skipped whoever had not opened the app would be unpredictable.
    const asleep = [
      target("A", { handsetState: "OFF_SHIFT" }, 0),
      target("B", { handsetState: "OFF_SHIFT", sharePct: 100 }, 1),
    ];
    expect(pickRoutingTarget("round_robin", asleep, 0).picked?.name).toBe("A");
    expect(pickRoutingTarget("percentage", asleep, 0).picked?.name).toBe("B");
  });
});

describe("sticky: the fallback is a choice, not a default", () => {
  const team = [target("A", { sharePct: 20 }, 0), target("B", { sharePct: 80 }, 1)];

  it("leaves the lead on the board when that is what the tenant picked", () => {
    const decision = pickRoutingTarget(
      "sticky",
      team,
      0,
      stickyCtx({ fallback: "unassigned" }),
    );
    expect(decision.picked).toBeNull();
    expect(decision.refusal).toBe("sticky_unassigned");
    expect(decision.sticky?.fellBackTo).toBe("unassigned");
    expect(decision.reason).toContain("leaves those on the board");
  });

  it("runs the percentage split when that is the fallback", () => {
    const decision = pickRoutingTarget("sticky", team, 0, stickyCtx({ fallback: "percentage" }));
    expect(decision.picked?.name).toBe("B");
    expect(decision.reason).toContain("80%");
  });

  it("passes the fallback's own refusal through rather than inventing one", () => {
    // Everybody capped under a sticky rule is a staffing problem, and it has
    // to read as one - not as "stickiness failed".
    const full = [target("A", { dailyCap: 1, assignedToday: 1 }, 0)];
    const decision = pickRoutingTarget("sticky", full, 0, stickyCtx());
    expect(decision.refusal).toBe("all_capped");
    expect(decision.sticky?.resolution).toBe("no_history");
  });
});

describe("sticky: a rule that cannot decide refuses loudly", () => {
  const team = [target("A", {}, 0), target("B", {}, 1)];

  it("refuses rather than silently rotating when no history was loaded", () => {
    // The three-argument call. A caller that has not been taught to load the
    // number's history must NOT get a rotation that looks like stickiness
    // working - that is the failure nobody ever finds.
    const decision = pickRoutingTarget("sticky", team, 0);
    expect(decision.picked).toBeNull();
    expect(decision.refusal).toBe("sticky_unresolved");
    expect(decision.sticky?.resolution).toBe("unresolvable");
    expect(decision.nextCursor).toBe(0);
  });

  it("refuses a half-configured rule, naming the missing half", () => {
    // 0160's lead_routing_rules_sticky_configured CHECK makes this unreachable
    // through the API. A hand-edited row is not unreachable.
    const noWindow = pickRoutingTarget("sticky", team, 0, stickyCtx({ windowDays: null }));
    expect(noWindow.refusal).toBe("sticky_unconfigured");
    expect(noWindow.reason).toContain("no window");

    const noFallback = pickRoutingTarget("sticky", team, 0, stickyCtx({ fallback: null }));
    expect(noFallback.refusal).toBe("sticky_unconfigured");
    expect(noFallback.reason).toContain("no fallback");
  });

  it("leaves the other two strategies untouched by the new parameter", () => {
    // Every existing three-argument call site keeps behaving identically, and
    // a context handed to the wrong strategy changes nothing.
    const ctx = stickyCtx({ priorOwners: [owner("tc-B")] });
    expect(pickRoutingTarget("round_robin", team, 0, ctx).picked?.name).toBe("A");
    expect(pickRoutingTarget("round_robin", team, 0).picked?.name).toBe("A");
  });
});

describe("sticky: the preview", () => {
  const team = [target("A", {}, 0), target("B", {}, 1), target("C", {}, 2)];

  it("shows the fallback sequence for a number nobody has called", () => {
    // What the rules page actually asks: most leads have no history, so the
    // honest preview of a sticky rule is its fallback's rotation.
    const preview = simulateRouting("sticky", team, 0, 4, stickyCtx()).map((d) => d.picked?.name);
    expect(preview).toEqual(["A", "B", "C", "A"]);
  });

  it("shows one returning caller going to the same person until their cap", () => {
    // Two to B, and then the cap bites: every later lead from that number
    // takes the fallback, which is round robin stepping over the person who
    // is full. That is the engine's own answer, run forward on a copy.
    const withCap = [target("A", {}, 0), target("B", { dailyCap: 2 }, 1)];
    const preview = simulateRouting(
      "sticky",
      withCap,
      0,
      4,
      stickyCtx({ priorOwners: [owner("tc-B")] }),
    );
    expect(preview.map((d) => d.picked?.name)).toEqual(["B", "B", "A", "A"]);
    expect(preview.map((d) => d.sticky?.resolution)).toEqual([
      "matched",
      "matched",
      "owner_unavailable",
      "owner_unavailable",
    ]);
  });

  it("stops early instead of repeating an identical refusal", () => {
    expect(simulateRouting("sticky", team, 0, 5)).toHaveLength(1);
  });
});

describe("resolveStickyConfig", () => {
  it("fills both columns when a rule becomes sticky with neither sent", () => {
    // What a strategy dropdown sends: PATCH { strategy: 'sticky' }, nothing
    // else. Without this the write hits 0160's CHECK and a form gets a 500.
    expect(resolveStickyConfig("sticky", {}, {})).toEqual({
      stickyWindowDays: STICKY_DEFAULT_WINDOW_DAYS,
      stickyFallback: STICKY_DEFAULT_FALLBACK,
    });
  });

  it("never defaults to 'unassigned'", () => {
    // The one fallback that silently kills leads must be chosen on purpose.
    expect(STICKY_DEFAULT_FALLBACK).not.toBe("unassigned");
  });

  it("prefers what the caller sent over what is stored", () => {
    expect(
      resolveStickyConfig(
        "sticky",
        { stickyWindowDays: 30, stickyFallback: "unassigned" },
        { stickyWindowDays: 90, stickyFallback: "round_robin" },
      ),
    ).toEqual({ stickyWindowDays: 30, stickyFallback: "unassigned" });
  });

  it("treats absent as leave-alone and keeps the stored value", () => {
    expect(
      resolveStickyConfig("sticky", {}, { stickyWindowDays: 365, stickyFallback: "percentage" }),
    ).toEqual({ stickyWindowDays: 365, stickyFallback: "percentage" });
  });

  it("refuses to clear a sticky rule's columns to null", () => {
    // `null` means "clear it" everywhere else, and here it would write a row
    // the CHECK rejects. The default takes over instead of the request failing.
    expect(
      resolveStickyConfig("sticky", { stickyWindowDays: null, stickyFallback: null }, {}),
    ).toEqual({
      stickyWindowDays: STICKY_DEFAULT_WINDOW_DAYS,
      stickyFallback: STICKY_DEFAULT_FALLBACK,
    });
  });

  it("invents nothing for a rule that is not sticky", () => {
    expect(resolveStickyConfig("round_robin", {}, {})).toEqual({
      stickyWindowDays: null,
      stickyFallback: null,
    });
  });

  it("keeps a window somebody typed when they switch the strategy away and back", () => {
    // The same kindness `share_pct` gets on a round-robin rule: trying another
    // strategy must not silently discard the configuration you had.
    const stored = { stickyWindowDays: 45, stickyFallback: "percentage" as const };
    const away = resolveStickyConfig("round_robin", {}, stored);
    expect(away).toEqual({ stickyWindowDays: 45, stickyFallback: "percentage" });
    expect(resolveStickyConfig("sticky", {}, away)).toEqual(stored);
  });
});

describe("the sticky rule schema", () => {
  it("accepts a sticky rule and leaves the columns to the resolver", () => {
    const parsed = LeadRoutingRuleInput.parse({ name: "Repeat callers", strategy: "sticky" });
    expect(parsed.strategy).toBe("sticky");
    // NOT defaulted by the schema: a default here would survive `.partial()`
    // and write a window onto every round-robin rule's PATCH.
    expect(parsed.stickyWindowDays).toBeUndefined();
    expect(LeadRoutingRulePatch.parse({ status: "paused" })).toEqual({ status: "paused" });
  });

  it("bounds the window rather than letting a typo reach the column", () => {
    expect(LeadRoutingRulePatch.safeParse({ stickyWindowDays: 0 }).success).toBe(false);
    expect(LeadRoutingRulePatch.safeParse({ stickyWindowDays: -1 }).success).toBe(false);
    expect(LeadRoutingRulePatch.safeParse({ stickyWindowDays: 36500 }).success).toBe(false);
    expect(LeadRoutingRulePatch.safeParse({ stickyWindowDays: 3650 }).success).toBe(true);
  });

  it("rejects a fallback the column would refuse", () => {
    expect(LeadRoutingRulePatch.safeParse({ stickyFallback: "sticky" }).success).toBe(false);
    expect(LeadRoutingRulePatch.safeParse({ stickyFallback: "nobody" }).success).toBe(false);
  });

  it("checks a sticky rule's shares when, and only when, its fallback is percentage", () => {
    const short = [{ sharePct: 50 }, { sharePct: 30 }];
    expect(sharesProblem("sticky", short)).toBeNull();
    expect(sharesProblem("sticky", short, "round_robin")).toBeNull();
    // Most leads have no history, so on this rule the split is what actually
    // runs. A form that saved 50/30 here would hand out a ratio nobody chose.
    expect(sharesProblem("sticky", short, "percentage")).toContain("80%");
  });

  it("measures a sticky rule against an even split", () => {
    // Sticky promises nothing about volume - it promises the customer reaches
    // their own person. "One owner is taking 80% of this desk" is still the
    // thing worth seeing, and on a sticky rule it is the warning that somebody
    // is being buried.
    const reality = shareReality("sticky", [
      target("A", { delivered: 8 }, 0),
      target("B", { delivered: 2 }, 1),
    ]);
    expect(reality.map((r) => r.targetPct)).toEqual([50, 50]);
    expect(reality[0].driftPct).toBe(30);
  });
});

/**
 * THE CHECK/ZOD DRIFT TRAP, PINNED - the same technique opt-out.test.ts uses
 * for `messaging_opt_outs.channel`, and for the same reason.
 *
 * `lead_routing_rules.strategy` has a CHECK in SQL and a zod enum here.
 * Widening one and not the other throws 23514 on the write and reads like a
 * bug in the caller. `notifications.kind` drifted in both directions at once
 * and broke lead routing while every type-check and lint stayed green.
 *
 * Pinned twice, because the two pins fail in different directions:
 *
 *   - the literals below, transcribed by hand from the migration, which fail
 *     when the ENUM is widened without the constraint;
 *   - the constraints' own values, read out of the .sql, which fail when a
 *     CONSTRAINT is widened without the enum.
 */
describe("the strategy enum and the database CHECKs are the same sets", () => {
  /**
   * Verbatim from `0160_sticky_lead_routing.sql`:
   *
   *     ALTER TABLE lead_routing_rules ADD CONSTRAINT lead_routing_rules_strategy_check
   *       CHECK (strategy IN ('round_robin', 'percentage', 'sticky'));
   *
   *     ALTER TABLE lead_routing_rules ADD CONSTRAINT lead_routing_rules_sticky_fallback_check
   *       CHECK (sticky_fallback IN ('round_robin', 'percentage', 'unassigned'));
   *
   * Change these lists ONLY while changing those statements, and vice versa.
   * 'sticky' joined the first in 0160, which 0105 had declared inline with
   * two values.
   */
  const STRATEGIES_IN_DB_CHECK = ["round_robin", "percentage", "sticky"];
  const FALLBACKS_IN_DB_CHECK = ["round_robin", "percentage", "unassigned"];

  /** Same walk-up as opt-out.test.ts - the package compiles as CommonJS. */
  const MIGRATIONS_DIR = (() => {
    let dir = resolve(process.cwd());
    for (let up = 0; up < 6; up++) {
      const candidate = join(dir, "packages", "db", "migrations");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error("packages/db/migrations not found above " + process.cwd());
  })();

  /**
   * Every migration, comments stripped, whitespace flattened, in APPLY order -
   * so the LAST named CHECK on a column is the one the live database holds.
   * 0105 declared the strategy constraint inline and 0160 replaced it with a
   * named one; taking the last match is what makes the next widening work the
   * same way.
   */
  const FLAT_SQL = (() => {
    return readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n")
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ");
  })();

  function lastCheckValues(constraint: string, column: string): string[] | null {
    const all = [
      ...FLAT_SQL.matchAll(
        new RegExp(`ADD CONSTRAINT ${constraint} CHECK \\(${column} IN \\(([^)]*)\\)`, "g"),
      ),
    ];
    if (all.length === 0) return null;
    return Array.from(all[all.length - 1][1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
  }

  it("matches the lead_routing_rules_strategy_check values exactly", () => {
    const inSql = lastCheckValues("lead_routing_rules_strategy_check", "strategy");
    // Null would mean the named constraint has vanished from the tree - a
    // renumbered or reverted 0160 - which must fail rather than quietly skip.
    // A skipped assertion is how the tenant-isolation suite rotted unseen.
    expect(inSql, "no ADD CONSTRAINT lead_routing_rules_strategy_check").not.toBeNull();
    expect(inSql).toEqual([...STRATEGIES_IN_DB_CHECK].sort());
    expect(inSql).toEqual([...LeadRoutingStrategy.options].sort());
  });

  it("matches the lead_routing_rules_sticky_fallback_check values exactly", () => {
    const inSql = lastCheckValues("lead_routing_rules_sticky_fallback_check", "sticky_fallback");
    expect(inSql, "no ADD CONSTRAINT lead_routing_rules_sticky_fallback_check").not.toBeNull();
    expect(inSql).toEqual([...FALLBACKS_IN_DB_CHECK].sort());
    expect(inSql).toEqual([...LeadRoutingStickyFallback.options].sort());
  });

  it("keeps the fallback set equal to the other strategies plus 'unassigned'", () => {
    // A fourth strategy would otherwise appear in one list and not the other
    // with nobody deciding whether it can be a fallback. 'sticky' is excluded
    // on purpose: a sticky rule falling back to itself is an infinite regress.
    const expected = [
      ...LeadRoutingStrategy.options.filter((s) => s !== "sticky"),
      "unassigned",
    ].sort();
    expect([...LeadRoutingStickyFallback.options].sort()).toEqual(expected);
  });

  it("rejects a strategy the column would refuse", () => {
    expect(LeadRoutingStrategy.safeParse("random").success).toBe(false);
    expect(LeadRoutingStrategy.safeParse("unassigned").success).toBe(false);
    expect(LeadRoutingStrategy.safeParse("").success).toBe(false);
  });

  it("forbids a half-configured sticky rule in the schema, not only in code", () => {
    // The state the engine answers with `sticky_unconfigured`. A rule that
    // looks configured on the page it was configured from and routes nothing
    // is the worst failure an automation has, so the database refuses it too.
    expect(FLAT_SQL).toContain("ADD CONSTRAINT lead_routing_rules_sticky_configured");
    expect(FLAT_SQL).toContain(
      "strategy <> 'sticky' OR (sticky_window_days IS NOT NULL AND sticky_fallback IS NOT NULL)",
    );
  });

  it("leaves lead_routing_assignments.strategy unconstrained, so history keeps 'sticky'", () => {
    // 0105 stores the strategy denormalised on every decision precisely so
    // editing or deleting a rule cannot rewrite what it decided. A CHECK on
    // that column would make this rollback-able migration destroy history.
    expect(lastCheckValues("lead_routing_assignments_strategy_check", "strategy")).toBeNull();
  });
});
