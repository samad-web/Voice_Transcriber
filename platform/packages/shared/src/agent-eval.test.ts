import { describe, expect, it } from "vitest";

import {
  AUTONOMY_DEMOTE_BELOW,
  AUTONOMY_MIN_CASES,
  AUTONOMY_PRECISION_GATE,
  type ActualRun,
  DRIFT_MIN_RUNS,
  EVAL_VERSION,
  EvalCase,
  RELEASE_GATES,
  aggregate,
  autonomyDecision,
  caseFromCorrection,
  checkGates,
  compareCase,
  driftReport,
} from "./agent-eval";

const BASE = {
  id: "c1",
  tags: ["hindi"],
  transcript: "Customer: kal shaam 5 baje call karna",
  language: "hi-en",
  reference: "2026-10-09T06:30:00.000Z",
  timeZone: "Asia/Kolkata",
};

function testCase(expected: EvalCase["expected"], overrides: Partial<EvalCase> = {}): EvalCase {
  return EvalCase.parse({ ...BASE, expected, ...overrides });
}

function run(partial: Partial<ActualRun> = {}): ActualRun {
  return {
    intents: [],
    disposition: null,
    actions: [],
    needsHuman: false,
    latencyMs: 5_000,
    costMinor: 40,
    ...partial,
  };
}

const CALLBACK_AT_5 = {
  type: "callback_request",
  dueAt: "2026-10-10T11:30:00.000Z",
  amountMinor: null,
  resolution: "exact" as const,
};

describe("compareCase - intents", () => {
  it("scores a correct single intent as one true positive", () => {
    const result = compareCase(
      testCase({ intents: [{ type: "callback_request" }] }),
      run({ intents: [CALLBACK_AT_5] }),
    );
    expect(result.intentTruePositives).toEqual({ callback_request: 1 });
    expect(result.intentFalsePositives).toEqual({});
    expect(result.intentFalseNegatives).toEqual({});
  });

  it("scores a missing intent as a false negative", () => {
    const result = compareCase(
      testCase({ intents: [{ type: "callback_request" }] }),
      run({ intents: [] }),
    );
    expect(result.intentFalseNegatives).toEqual({ callback_request: 1 });
  });

  it("scores an invented intent as a false positive", () => {
    const result = compareCase(
      testCase({ intents: [] }),
      run({ intents: [CALLBACK_AT_5] }),
    );
    expect(result.intentFalsePositives).toEqual({ callback_request: 1 });
  });

  it("MATCHES ONE TO ONE, so a model that repeats itself does not score better", () => {
    // Two expected, three produced: two true positives and ONE false positive.
    const result = compareCase(
      testCase({ intents: [{ type: "follow_up" }, { type: "follow_up" }] }),
      run({
        intents: [
          { type: "follow_up", dueAt: null, amountMinor: null, resolution: null },
          { type: "follow_up", dueAt: null, amountMinor: null, resolution: null },
          { type: "follow_up", dueAt: null, amountMinor: null, resolution: null },
        ],
      }),
    );
    expect(result.intentTruePositives).toEqual({ follow_up: 2 });
    expect(result.intentFalsePositives).toEqual({ follow_up: 1 });
  });
});

describe("compareCase - slots (§13.2)", () => {
  it("compares a due instant as a MOMENT, not as a string", () => {
    // "2026-10-10T11:30:00.000Z" and "2026-10-10T17:00:00+05:30" are the same
    // moment, and a string compare would report a serialisation difference as
    // a slot failure.
    const result = compareCase(
      testCase({ intents: [{ type: "callback_request", dueAt: "2026-10-10T17:00:00+05:30" }] }),
      run({ intents: [CALLBACK_AT_5] }),
    );
    expect(result.slotsChecked).toBe(1);
    expect(result.slotsExact).toBe(1);
    expect(result.slotFailures).toEqual([]);
  });

  it("reports a wrong instant with both values", () => {
    const result = compareCase(
      testCase({ intents: [{ type: "callback_request", dueAt: "2026-10-09T11:30:00.000Z" }] }),
      run({ intents: [CALLBACK_AT_5] }),
    );
    expect(result.slotsExact).toBe(0);
    expect(result.slotFailures[0]).toMatchObject({ intent: "callback_request", field: "dueAt" });
  });

  it("compares an amount exactly, in minor units", () => {
    const result = compareCase(
      testCase({ intents: [{ type: "payment_promise", amountMinor: 50_000_00 }] }),
      run({
        intents: [
          { type: "payment_promise", dueAt: null, amountMinor: 50_000_00, resolution: null },
        ],
      }),
    );
    expect(result.slotsExact).toBe(1);
  });

  it("compares the resolver's SHAPE, so an ambiguous reading can be asserted", () => {
    const result = compareCase(
      testCase({ intents: [{ type: "callback_request", resolution: "ambiguous" }] }),
      run({ intents: [CALLBACK_AT_5] }),
    );
    expect(result.slotsExact).toBe(0);
    expect(result.slotFailures[0]!.field).toBe("resolution");
  });

  it("DOES NOT count the slots of an intent that was missed entirely", () => {
    // Counting them would double-penalise one mistake and make slot accuracy a
    // second recall figure.
    const result = compareCase(
      testCase({ intents: [{ type: "callback_request", dueAt: "2026-10-10T11:30:00.000Z" }] }),
      run({ intents: [] }),
    );
    expect(result.slotsChecked).toBe(0);
    expect(result.slotFailures).toEqual([]);
  });

  it("checks nothing the case did not assert", () => {
    const result = compareCase(
      testCase({ intents: [{ type: "callback_request" }] }),
      run({ intents: [CALLBACK_AT_5] }),
    );
    expect(result.slotsChecked).toBe(0);
  });
});

describe("compareCase - actions (§13.2's asymmetry)", () => {
  it("counts an action that executed and should not have as a FALSE ACTION", () => {
    const result = compareCase(
      testCase({ intents: [], actions: [] }),
      run({ actions: [{ tool: "book_slot", state: "planned" }] }),
    );
    expect(result.falseActions).toEqual([{ tool: "book_slot", tier: "T2" }]);
    expect(result.missedActions).toEqual([]);
  });

  it("counts an action that should have happened and did not as a MISSED ACTION", () => {
    const result = compareCase(
      testCase({ intents: [], actions: [{ tool: "schedule_callback" }] }),
      run({ actions: [] }),
    );
    expect(result.missedActions).toEqual([{ tool: "schedule_callback", tier: "T1" }]);
    expect(result.falseActions).toEqual([]);
  });

  it("counts an action that EXECUTED where review was expected as a false action", () => {
    // It would have reached the customer without a person, which is the whole
    // failure the tier system exists to prevent.
    const result = compareCase(
      testCase({ intents: [], actions: [{ tool: "book_slot", state: "pending_review" }] }),
      run({ actions: [{ tool: "book_slot", state: "planned" }] }),
    );
    expect(result.falseActions).toEqual([{ tool: "book_slot", tier: "T2" }]);
  });

  it("does NOT count a mere suggestion as a false action", () => {
    // A person rejecting a suggestion is the system working.
    const result = compareCase(
      testCase({ intents: [], actions: [] }),
      run({ actions: [{ tool: "book_slot", state: "pending_review" }] }),
    );
    expect(result.falseActions).toEqual([]);
  });

  it("ignores actions entirely when a case does not assert any", () => {
    const result = compareCase(
      testCase({ intents: [] }),
      run({ actions: [{ tool: "book_slot", state: "planned" }] }),
    );
    expect(result.falseActions).toEqual([]);
    expect(result.missedActions).toEqual([]);
  });

  it("treats an unknown tool in a fixture as the most severe tier", () => {
    // A typo in an expectation must not pass a gate quietly.
    const result = compareCase(
      testCase({ intents: [], actions: [{ tool: "book_slotz" }] }),
      run({ actions: [] }),
    );
    expect(result.missedActions[0]!.tier).toBe("T3");
  });
});

describe("compareCase - disposition and needs_human", () => {
  it("compares the disposition case-insensitively", () => {
    const result = compareCase(
      testCase({ intents: [], disposition: "Interested" }),
      run({ disposition: "interested" }),
    );
    expect(result.dispositionChecked).toBe(true);
    expect(result.dispositionCorrect).toBe(true);
  });

  it("marks a wrong disposition", () => {
    const result = compareCase(
      testCase({ intents: [], disposition: "interested" }),
      run({ disposition: "not_interested" }),
    );
    expect(result.dispositionCorrect).toBe(false);
  });

  it("checks needs_human only where the case asserts it", () => {
    expect(
      compareCase(testCase({ intents: [] }), run()).needsHumanChecked,
    ).toBe(false);
    const asserted = compareCase(
      testCase({ intents: [], needsHuman: true }),
      run({ needsHuman: false }),
    );
    expect(asserted.needsHumanChecked).toBe(true);
    expect(asserted.needsHumanCorrect).toBe(false);
  });
});

describe("aggregate (§13.2)", () => {
  const correct = compareCase(
    testCase({ intents: [{ type: "callback_request", dueAt: "2026-10-10T11:30:00.000Z" }], disposition: "interested" }),
    run({ intents: [CALLBACK_AT_5], disposition: "interested", latencyMs: 4_000, costMinor: 30 }),
  );
  const wrongSlot = compareCase(
    testCase({ intents: [{ type: "callback_request", dueAt: "2026-10-11T11:30:00.000Z" }], disposition: "interested" }),
    run({ intents: [CALLBACK_AT_5], disposition: "cold", latencyMs: 20_000, costMinor: 50 }),
  );

  it("computes per-intent precision, recall and F1", () => {
    const metrics = aggregate([correct, wrongSlot]);
    const callback = metrics.perIntent.find((m) => m.type === "callback_request")!;
    expect(callback.truePositives).toBe(2);
    expect(callback.precision).toBe(1);
    expect(callback.recall).toBe(1);
    expect(callback.f1).toBe(1);
  });

  it("computes slot accuracy across cases", () => {
    expect(aggregate([correct, wrongSlot]).slotAccuracy).toBe(0.5);
  });

  it("computes disposition accuracy", () => {
    expect(aggregate([correct, wrongSlot]).dispositionAccuracy).toBe(0.5);
  });

  it("reports the false-action and missed-action rates SEPARATELY", () => {
    const falseAction = compareCase(
      testCase({ intents: [], actions: [] }),
      run({ actions: [{ tool: "book_slot", state: "planned" }] }),
    );
    const missed = compareCase(
      testCase({ intents: [], actions: [{ tool: "schedule_callback" }] }),
      run({ actions: [] }),
    );
    const metrics = aggregate([correct, falseAction, missed]);
    expect(metrics.falseActionRate).toBeCloseTo(1 / 3);
    expect(metrics.missedActionRate).toBeCloseTo(1 / 3);
    expect(metrics.falseCustomerVisibleActions).toBe(1);
  });

  it("counts the false-action rate PER CASE, not per action", () => {
    // Otherwise a run producing many correct actions dilutes one wrong one.
    const twoWrong = compareCase(
      testCase({ intents: [], actions: [] }),
      run({
        actions: [
          { tool: "book_slot", state: "planned" },
          { tool: "send_message", state: "planned" },
        ],
      }),
    );
    expect(aggregate([twoWrong]).falseActionRate).toBe(1);
  });

  it("computes latency percentiles from observed values only", () => {
    const metrics = aggregate([correct, wrongSlot]);
    expect([4_000, 20_000]).toContain(metrics.latencyP50Ms);
    expect(metrics.latencyP95Ms).toBe(20_000);
  });

  it("computes cost per call", () => {
    expect(aggregate([correct, wrongSlot]).costPerCallMinor).toBe(40);
  });

  it("breaks results down per language (§13.1)", () => {
    const english = compareCase(
      testCase({ intents: [{ type: "follow_up" }] }, { language: "en" }),
      run({ intents: [{ type: "follow_up", dueAt: null, amountMinor: null, resolution: null }] }),
    );
    const metrics = aggregate([correct, english]);
    expect(metrics.perLanguage["hi-en"]!.cases).toBe(1);
    expect(metrics.perLanguage.en!.cases).toBe(1);
    expect(metrics.perLanguage.en!.intentF1).toBe(1);
  });

  it("returns NULL for a rate with no denominator, not zero and not one", () => {
    const metrics = aggregate([]);
    expect(metrics.intentF1).toBeNull();
    expect(metrics.slotAccuracy).toBeNull();
    expect(metrics.dispositionAccuracy).toBeNull();
    expect(metrics.falseActionRate).toBeNull();
    expect(metrics.latencyP95Ms).toBeNull();
    expect(metrics.cases).toBe(0);
  });
});

describe("M8 ACCEPTANCE: a degraded build fails the gate and blocks release", () => {
  /** A golden set of four cases a good build gets right. */
  const goldenCases: EvalCase[] = [
    testCase(
      {
        intents: [{ type: "book_appointment", dueAt: "2026-10-10T11:30:00.000Z" }],
        disposition: "interested",
        actions: [{ tool: "book_slot", state: "planned" }],
      },
      { id: "g1" },
    ),
    testCase(
      {
        intents: [{ type: "book_appointment", dueAt: "2026-10-12T04:30:00.000Z" }],
        disposition: "interested",
        actions: [{ tool: "book_slot", state: "planned" }],
      },
      { id: "g2" },
    ),
    testCase(
      {
        intents: [{ type: "callback_request", dueAt: "2026-10-10T11:30:00.000Z" }],
        disposition: "interested",
        actions: [{ tool: "schedule_callback", state: "planned" }],
      },
      { id: "g3" },
    ),
    testCase(
      { intents: [], disposition: "not_interested", actions: [] },
      { id: "g4" },
    ),
  ];

  const goodRuns: ActualRun[] = [
    run({
      intents: [
        { type: "book_appointment", dueAt: "2026-10-10T11:30:00.000Z", amountMinor: null, resolution: null },
      ],
      disposition: "interested",
      actions: [{ tool: "book_slot", state: "planned" }],
      latencyMs: 8_000,
    }),
    run({
      intents: [
        { type: "book_appointment", dueAt: "2026-10-12T04:30:00.000Z", amountMinor: null, resolution: null },
      ],
      disposition: "interested",
      actions: [{ tool: "book_slot", state: "planned" }],
      latencyMs: 9_000,
    }),
    run({
      intents: [CALLBACK_AT_5],
      disposition: "interested",
      actions: [{ tool: "schedule_callback", state: "planned" }],
      latencyMs: 7_000,
    }),
    run({ intents: [], disposition: "not_interested", actions: [], latencyMs: 6_000 }),
  ];

  it("PASSES for a build that gets the golden set right", () => {
    const results = goldenCases.map((c, i) => compareCase(c, goodRuns[i]!));
    const report = checkGates(aggregate(results));
    expect(report.failures.map((f) => f.key)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("FAILS when a degraded prompt resolves the date to the wrong day", () => {
    // The exact regression §13.2 is built to catch: the intent is still read
    // correctly and the TIME is a day out, so an intent-F1-only gate stays green.
    const degraded = [...goodRuns];
    degraded[0] = run({
      ...goodRuns[0]!,
      intents: [
        { type: "book_appointment", dueAt: "2026-10-11T11:30:00.000Z", amountMinor: null, resolution: null },
      ],
    });
    const report = checkGates(aggregate(goldenCases.map((c, i) => compareCase(c, degraded[i]!))));
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.key)).toContain("slot_accuracy");
    expect(report.failures[0]!.message).toMatch(/below/);
  });

  it("FAILS when a degraded build books something nobody asked for", () => {
    const degraded = [...goodRuns];
    degraded[3] = run({
      ...goodRuns[3]!,
      actions: [{ tool: "book_slot", state: "planned" }],
    });
    const report = checkGates(aggregate(goldenCases.map((c, i) => compareCase(c, degraded[i]!))));
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.key)).toContain("false_action_rate");
    expect(report.failures.map((f) => f.key)).toContain("false_customer_visible");
  });

  it("FAILS when a degraded build stops reading bookings", () => {
    const degraded = goodRuns.map((r) => run({ ...r, intents: [], actions: [] }));
    const report = checkGates(aggregate(goldenCases.map((c, i) => compareCase(c, degraded[i]!))));
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.key)).toContain("booking_f1");
  });

  it("FAILS when a degraded build becomes too slow", () => {
    const slow = goodRuns.map((r) => run({ ...r, latencyMs: 45_000 }));
    const report = checkGates(aggregate(goldenCases.map((c, i) => compareCase(c, slow[i]!))));
    expect(report.failures.map((f) => f.key)).toContain("latency_p95");
  });

  it("AN UNMEASURED GATE FAILS - removing the only booking fixture does not turn it green", () => {
    const withoutBookings = goldenCases.slice(2);
    const report = checkGates(
      aggregate(withoutBookings.map((c, i) => compareCase(c, goodRuns.slice(2)[i]!))),
    );
    expect(report.passed).toBe(false);
    const bookingGate = report.failures.find((f) => f.key === "booking_f1")!;
    expect(bookingGate.value).toBeNull();
    expect(bookingGate.message).toMatch(/was not measured/);
  });

  it("holds the false-action gate an order of magnitude tighter than the F1 gate", () => {
    const falseAction = RELEASE_GATES.find((g) => g.key === "false_action_rate")!;
    const f1 = RELEASE_GATES.find((g) => g.key === "intent_f1")!;
    expect(falseAction.direction).toBe("max");
    expect(falseAction.threshold).toBeLessThanOrEqual(0.01);
    expect(1 - f1.threshold).toBeGreaterThan(falseAction.threshold * 5);
  });

  it("holds false customer-visible actions at exactly zero", () => {
    const gate = RELEASE_GATES.find((g) => g.key === "false_customer_visible")!;
    expect(gate.threshold).toBe(0);
  });
});

describe("autonomyDecision (§13.3)", () => {
  const base = {
    precision: 0.99,
    reviewedCases: 300,
    currentlyAuto: false,
    orgWantsAuto: true,
    eligible: true,
  };

  it("promotes when the owner asked AND the gate is met", () => {
    const decision = autonomyDecision(base);
    expect(decision.action).toBe("promote");
    expect(decision.alert).toBe(true);
    expect(decision.reason).toMatch(/300 reviewed examples/);
  });

  it("NEVER promotes without the owner having asked", () => {
    expect(autonomyDecision({ ...base, orgWantsAuto: false }).action).toBe("hold");
  });

  it("holds below the minimum number of reviewed cases", () => {
    const decision = autonomyDecision({ ...base, reviewedCases: AUTONOMY_MIN_CASES - 1 });
    expect(decision.action).toBe("hold");
    expect(decision.reason).toMatch(new RegExp(`${AUTONOMY_MIN_CASES}`));
  });

  it("holds below the precision gate", () => {
    expect(
      autonomyDecision({ ...base, precision: AUTONOMY_PRECISION_GATE - 0.001 }).action,
    ).toBe("hold");
  });

  it("DEMOTES AUTOMATICALLY when accuracy falls, and alerts", () => {
    const decision = autonomyDecision({
      ...base,
      currentlyAuto: true,
      precision: AUTONOMY_DEMOTE_BELOW - 0.01,
    });
    expect(decision.action).toBe("demote");
    expect(decision.alert).toBe(true);
    expect(decision.reason).toMatch(/fallen to/);
  });

  it("DEMOTES when the accuracy signal stops arriving", () => {
    // A live autonomous action with no accuracy measurement is exactly what
    // §13.3's gate exists to prevent.
    const decision = autonomyDecision({ ...base, currentlyAuto: true, precision: null });
    expect(decision.action).toBe("demote");
    expect(decision.alert).toBe(true);
  });

  it("HAS HYSTERESIS, so an intent sitting on the gate does not flap", () => {
    // Promote at 98 %, demote below 96 %: a two-point band where the
    // measurement can wobble without the product's behaviour changing.
    expect(AUTONOMY_DEMOTE_BELOW).toBeLessThan(AUTONOMY_PRECISION_GATE);
    const onTheLine = autonomyDecision({ ...base, currentlyAuto: true, precision: 0.97 });
    expect(onTheLine.action).toBe("hold");
  });

  it("demotes quietly when the owner switched it back themselves", () => {
    const decision = autonomyDecision({ ...base, currentlyAuto: true, orgWantsAuto: false });
    expect(decision.action).toBe("demote");
    expect(decision.alert).toBe(false);
  });

  it("demotes an ineligible intent that somehow became automatic, and alerts", () => {
    const decision = autonomyDecision({ ...base, currentlyAuto: true, eligible: false });
    expect(decision.action).toBe("demote");
    expect(decision.alert).toBe(true);
  });

  it("holds an ineligible intent that is not automatic, without alerting", () => {
    expect(autonomyDecision({ ...base, eligible: false }).alert).toBe(false);
  });

  it("is asymmetric: nothing here raises autonomy on its own", () => {
    // Every `promote` path requires `orgWantsAuto`; every `demote` path can
    // fire without it.
    const promotions = [
      autonomyDecision({ ...base, orgWantsAuto: false }),
      autonomyDecision({ ...base, orgWantsAuto: false, precision: 1, reviewedCases: 10_000 }),
    ];
    for (const decision of promotions) expect(decision.action).not.toBe("promote");
  });
});

describe("driftReport (§13.4)", () => {
  const sample = (partial: Partial<Parameters<typeof driftReport>[0]> = {}) => ({
    meanScore: 0.9,
    meanSttConfidence: 0.9,
    correctionRate: 0.05,
    intentMix: { callback_request: 0.4 },
    runs: 100,
    ...partial,
  });

  it("says nothing when there is not enough data to mean anything", () => {
    expect(driftReport(sample({ runs: DRIFT_MIN_RUNS - 1 }), sample())).toEqual([]);
    expect(driftReport(sample(), sample({ runs: 1 }))).toEqual([]);
  });

  it("says nothing when nothing moved", () => {
    expect(driftReport(sample(), sample())).toEqual([]);
  });

  it("flags a drop in confidence", () => {
    const findings = driftReport(sample(), sample({ meanScore: 0.7 }));
    expect(findings.map((f) => f.signal)).toContain("confidence");
    expect(findings.find((f) => f.signal === "confidence")!.severity).toBe("alert");
  });

  it("flags a drop in transcription quality", () => {
    const findings = driftReport(sample(), sample({ meanSttConfidence: 0.8 }));
    expect(findings.find((f) => f.signal === "stt_confidence")!.severity).toBe("warn");
  });

  it("flags a RISE in the correction rate", () => {
    const findings = driftReport(sample(), sample({ correctionRate: 0.3 }));
    const correction = findings.find((f) => f.signal === "correction_rate")!;
    expect(correction.severity).toBe("alert");
    expect(correction.message).toMatch(/correcting the assistant more often/);
  });

  it("does NOT flag an improvement", () => {
    const findings = driftReport(sample(), sample({ meanScore: 1, correctionRate: 0 }));
    expect(findings).toEqual([]);
  });

  it("compares against a baseline rather than a constant", () => {
    // A 20 % correction rate is fine for a floor that just switched on and
    // alarming for one that was at 4 % last week.
    expect(driftReport(sample({ correctionRate: 0.2 }), sample({ correctionRate: 0.2 }))).toEqual(
      [],
    );
  });

  it("flags an intent that has appeared or vanished, not small movements", () => {
    expect(driftReport(sample(), sample({ intentMix: { callback_request: 0.45 } }))).toEqual([]);
    const appeared = driftReport(
      sample(),
      sample({ intentMix: { callback_request: 0.4, complaint: 0.5 } }),
    );
    expect(appeared.map((f) => f.signal)).toContain("intent_mix:complaint");
    const vanished = driftReport(sample(), sample({ intentMix: {} }));
    expect(vanished.map((f) => f.signal)).toContain("intent_mix:callback_request");
  });
});

describe("caseFromCorrection (§12, §13.4)", () => {
  it("turns a rejection into a labelled, tagged golden case", () => {
    const made = caseFromCorrection("act-1", {
      transcript: "Customer: kal nahi, parso call karna",
      reference: "2026-10-09T06:30:00.000Z",
      timeZone: "Asia/Kolkata",
      language: "hi",
      tags: ["changed-mind"],
      expected: { intents: [{ type: "callback_request" }] },
    });
    expect(made.id).toBe("correction:act-1");
    expect(made.tags).toContain("correction");
    expect(made.tags).toContain("changed-mind");
    expect(EvalCase.safeParse(made).success).toBe(true);
  });

  it("does not duplicate the correction tag", () => {
    const made = caseFromCorrection("act-2", {
      transcript: "x",
      reference: "2026-10-09T06:30:00.000Z",
      timeZone: "Asia/Kolkata",
      language: null,
      tags: ["correction"],
      expected: { intents: [] },
    });
    expect(made.tags.filter((t) => t === "correction")).toHaveLength(1);
  });
});

describe("version", () => {
  it("is recorded with every stored eval run", () => {
    expect(EVAL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
