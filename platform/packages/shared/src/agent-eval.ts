import { z } from "zod";
import {
  type AgentTier,
  type AgentToolName,
  UnderstandingOutput,
  toolSpec,
} from "./transcript-agent";

/**
 * EVALUATION, RELEASE GATES AND AUTONOMY
 * (Build docs/transcript-agent-build-plan §13).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  §13's OPENING LINE IS THE DESIGN BRIEF
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "Evaluation is the core differentiator. Build it with the feature, not
 * afterwards."
 *
 * So this file ships with the first milestone that can produce a decision, and
 * §17 M8's acceptance criterion is a test in this package: "a deliberately
 * degraded prompt fails the gate and blocks release."
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  A FALSE ACTION AND A MISSED ACTION ARE NOT THE SAME MISTAKE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §13.2: "false-action rate and missed-action rate, reported separately and
 * weighted differently (a wrong booking costs more than a missed one)."
 *
 * This is the single most important asymmetry in the module and it is easy to
 * lose by reporting one accuracy number. A missed booking is a telecaller
 * reading a transcript and booking it by hand - a cost measured in minutes. A
 * FALSE booking is a customer told to be somewhere, who turns up, and nobody is
 * expecting them. One is friction; the other is the relationship.
 *
 * So the two rates are separate fields, separate gates, and the false-action
 * gate is an order of magnitude tighter.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  EVERY RATE RETURNS NULL WHEN ITS DENOMINATOR IS EMPTY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A golden set with no bookings in it has no booking F1. Reporting 0 would fail
 * every gate and reporting 1 would pass every gate, and both are claims about
 * evidence that does not exist. `null` is the honest answer and `checkGates`
 * treats it as "not measured" rather than as a pass - which is the fail-closed
 * direction for a release gate.
 */

export const EVAL_VERSION = "1.0.0";

// ════════════════════════════════════════════════════════════════════════════
//  §13.1 - the golden set
// ════════════════════════════════════════════════════════════════════════════

/**
 * What a hand-labelled case asserts.
 *
 * §13.1: "include expected outputs for each pipeline stage (extraction,
 * resolution, plan)." Three levels, and a case may assert any subset - most
 * cases care about one stage, and a case forced to spell out all three is a
 * case nobody writes.
 */
export const ExpectedIntent = z.object({
  type: z.string().min(1).max(60),
  /** The RESOLVED values, which is the resolver's half of §13.2's slot accuracy. */
  dueAt: z.string().datetime({ offset: true }).nullish(),
  amountMinor: z.number().int().nullish(),
  /** `exact` | `window` | `ambiguous` | `unresolved` - the resolver's shape. */
  resolution: z.enum(["exact", "window", "ambiguous", "unresolved"]).nullish(),
});
export type ExpectedIntent = z.infer<typeof ExpectedIntent>;

export const ExpectedAction = z.object({
  tool: z.string().min(1).max(60),
  /** Whether the plan should have run it, proposed it, or refused it. */
  state: z.enum(["planned", "pending_review", "blocked", "recorded"]).nullish(),
});
export type ExpectedAction = z.infer<typeof ExpectedAction>;

export const EvalCase = z.object({
  id: z.string().min(1).max(120),
  /** Free-form tags: `hindi`, `noisy`, `changed-mind`, `injection`, `multi-intent`. */
  tags: z.array(z.string().max(40)).max(20),
  transcript: z.string().min(1),
  /** The language label, for the per-language breakdown §13.1 asks for. */
  language: z.string().max(20).nullish(),
  /** The call's end, so the date resolver has its reference instant. */
  reference: z.string().datetime({ offset: true }),
  timeZone: z.string().max(60),
  expected: z.object({
    intents: z.array(ExpectedIntent).max(20),
    disposition: z.string().max(80).nullish(),
    actions: z.array(ExpectedAction).max(20).nullish(),
    /** The run should have asked for a person. */
    needsHuman: z.boolean().nullish(),
  }),
});
export type EvalCase = z.infer<typeof EvalCase>;

// ════════════════════════════════════════════════════════════════════════════
//  §13.1's GOLDEN SET, AS FILES IN THE REPOSITORY
// ════════════════════════════════════════════════════════════════════════════

/**
 * One golden case, with the model output a correct build produces for it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THE RECORDED UNDERSTANDING IS PART OF THE FIXTURE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §13.2 says a change to "prompts, models, RESOLVERS, SCHEMA or POLICY" must
 * run the full eval and block release on regression. Three of those five can
 * be gated with no provider at all, and that is what this shape is for: the
 * fixture carries the understanding a good model returns, so CI can replay
 * everything AFTER the model - evidence verification, the date and amount
 * resolvers, the cross-checks, the scoring, the tier rules and the planner -
 * deterministically, on every pull request, for nothing.
 *
 * It is a SHADOW REPLAY, and its limit is worth stating plainly: it cannot
 * catch a prompt change that makes the model read the call differently, only
 * everything the platform does with what it read. §13.3's running measurement
 * over each tenant's own reviewed decisions is the half that catches the
 * model, and it needs real traffic rather than fixtures.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE TRANSCRIPTS ARE WRITTEN, NOT COLLECTED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §13.1 asks for "real, anonymized transcripts" and "300+". Every fixture here
 * is invented: no customer's words are in this repository, and a set assembled
 * from real calls cannot be, because the repository is public (and because
 * anonymising a phone conversation well is harder than it sounds - the names
 * come out and the circumstances stay in).
 *
 * So the repo set is a REGRESSION set, chosen to cover each category §19 lists
 * once, and the 300-case accuracy set is `agent_eval_cases` - per tenant, on
 * their own data, grown from their own corrections (§13.4). The two have
 * different jobs and the schema is deliberately the same one, so a tenant's
 * corrected case can be exported into this folder when it turns out to be
 * general rather than theirs.
 */
export const GoldenFixture = EvalCase.extend({
  /**
   * What a correct build's model call returns. Validated against
   * `UnderstandingOutput` by the loader, so a fixture cannot describe an
   * output the schema would reject - which would make the fixture a test of
   * nothing.
   */
  understanding: UnderstandingOutput,
  /**
   * What `prepareTranscript` must do to this transcript, where the case is
   * about privacy rather than about reading. Null for the ordinary cases.
   */
  /**
   * What the workspace already holds, where the case is about colliding with
   * it rather than about reading the call.
   *
   * §19 asks for "a booking conflict" fixture, and a conflict needs something
   * to conflict WITH. Without this the booking-conflict case was a plain
   * booking with a misleading name - which is worse than no case at all,
   * because the category looked covered.
   */
  context: z
    .object({
      /** Free/busy for the assignee. A booking inside one of these is refused. */
      busy: z
        .array(
          z.object({
            start: z.string().datetime({ offset: true }),
            end: z.string().datetime({ offset: true }),
          }),
        )
        .max(10)
        .optional(),
      /**
       * Open appointments and call-backs, as the duplicate check sees them.
       * `key` is the row's own id - which is how a reschedule finds the
       * appointment it should move (see `openAppointment` in the worker).
       */
      existing: z
        .array(
          z.object({
            tool: z.string().max(40),
            key: z.string().max(80),
            active: z.boolean(),
            subject: z.string().max(120).nullish(),
            at: z.string().datetime({ offset: true }).nullish(),
          }),
        )
        .max(10)
        .optional(),
      /** Totals on the lead, for §7.2's share-of-a-total resolution. */
      amountTotalsMinor: z.array(z.number().int()).max(5).optional(),
    })
    .nullish(),
  privacy: z
    .object({
      /** The `redactTranscript` categories that must fire. */
      masked: z.array(z.string().max(30)).max(10),
      /** Literal strings that must NOT survive into the model's input. */
      mustNotLeak: z.array(z.string().max(60)).max(10),
      /** §14: the transcript carries an instruction aimed at the model. */
      injection: z.boolean(),
    })
    .nullish(),
});
export type GoldenFixture = z.infer<typeof GoldenFixture>;

/**
 * The categories §19's fixture line and §13.1 between them require.
 *
 * Asserted by `golden-set.test.ts` against the tags actually present, so a set
 * that loses a category fails rather than passing with a hole in it. Adding a
 * category here without a fixture for it turns the suite red, which is the
 * intended direction: the list is the specification, the folder is the
 * implementation.
 */
export const REQUIRED_FIXTURE_TAGS: readonly string[] = [
  "hindi",
  "hinglish",
  "english",
  "noisy",
  "ambiguous-time",
  "multi-intent",
  "changed-mind",
  "hypothetical",
  "booking-conflict",
  "payment-promise",
  "opt-out",
  "complaint",
  "speaker-mixup",
  "duplicate-delivery",
  "injection",
  "pii",
  "no-intent",
];

export interface ActualIntent {
  type: string;
  dueAt: string | null;
  amountMinor: number | null;
  resolution: "exact" | "window" | "ambiguous" | "unresolved" | null;
}

export interface ActualRun {
  intents: readonly ActualIntent[];
  disposition: string | null;
  actions: readonly { tool: AgentToolName; state: string }[];
  needsHuman: boolean;
  latencyMs: number;
  costMinor: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  Comparing one case
// ════════════════════════════════════════════════════════════════════════════

export interface CaseResult {
  caseId: string;
  tags: readonly string[];
  language: string | null;
  /** Per-intent-type counts. */
  intentTruePositives: Readonly<Record<string, number>>;
  intentFalsePositives: Readonly<Record<string, number>>;
  intentFalseNegatives: Readonly<Record<string, number>>;
  /** Slots compared only where the case asserted one. */
  slotsChecked: number;
  slotsExact: number;
  /** Which slots were wrong, for the failure report. */
  slotFailures: readonly { intent: string; field: string; expected: string; actual: string }[];
  dispositionChecked: boolean;
  dispositionCorrect: boolean;
  /** §13.2: actions that should not have happened. */
  falseActions: readonly { tool: string; tier: AgentTier }[];
  /** §13.2: actions that should have happened and did not. */
  missedActions: readonly { tool: string; tier: AgentTier }[];
  needsHumanChecked: boolean;
  needsHumanCorrect: boolean;
  latencyMs: number;
  costMinor: number;
}

/**
 * ── MATCHING IS BY TYPE, GREEDILY, AND ONE EXPECTED INTENT MATCHES ONE ──────
 *
 * A call with two `follow_up` intents and a run that produced three is one
 * false positive, not three true positives. Greedy one-to-one matching on type
 * is what makes that come out right, and it is the behaviour a precision figure
 * has to have or a model that repeats itself scores better than one that does
 * not.
 */
export function compareCase(testCase: EvalCase, actual: ActualRun): CaseResult {
  const tp: Record<string, number> = {};
  const fp: Record<string, number> = {};
  const fn: Record<string, number> = {};

  const unmatchedActual = [...actual.intents];
  type SlotFailure = CaseResult["slotFailures"][number];
  const slotFailures: SlotFailure[] = [];
  let slotsChecked = 0;
  let slotsExact = 0;

  for (const expected of testCase.expected.intents) {
    const index = unmatchedActual.findIndex((a) => a.type === expected.type);
    if (index < 0) {
      fn[expected.type] = (fn[expected.type] ?? 0) + 1;
      // A missed intent's slots are not WRONG, they are absent. Counting them
      // as slot failures would double-penalise the same mistake and make the
      // slot-accuracy figure a second recall figure.
      continue;
    }
    const match = unmatchedActual.splice(index, 1)[0]!;
    tp[expected.type] = (tp[expected.type] ?? 0) + 1;

    if (expected.dueAt !== null && expected.dueAt !== undefined) {
      slotsChecked += 1;
      // Compared as INSTANTS, not as strings: "2026-10-10T17:00:00Z" and
      // "2026-10-10T22:30:00+05:30" are the same moment, and a string compare
      // would report a failure that is a serialisation difference.
      const same =
        match.dueAt !== null && new Date(match.dueAt).getTime() === new Date(expected.dueAt).getTime();
      if (same) slotsExact += 1;
      else {
        slotFailures.push({
          intent: expected.type,
          field: "dueAt",
          expected: expected.dueAt,
          actual: match.dueAt ?? "(none)",
        });
      }
    }

    if (expected.amountMinor !== null && expected.amountMinor !== undefined) {
      slotsChecked += 1;
      if (match.amountMinor === expected.amountMinor) slotsExact += 1;
      else {
        slotFailures.push({
          intent: expected.type,
          field: "amountMinor",
          expected: String(expected.amountMinor),
          actual: match.amountMinor === null ? "(none)" : String(match.amountMinor),
        });
      }
    }

    if (expected.resolution) {
      slotsChecked += 1;
      if (match.resolution === expected.resolution) slotsExact += 1;
      else {
        slotFailures.push({
          intent: expected.type,
          field: "resolution",
          expected: expected.resolution,
          actual: match.resolution ?? "(none)",
        });
      }
    }
  }

  for (const leftover of unmatchedActual) {
    fp[leftover.type] = (fp[leftover.type] ?? 0) + 1;
  }

  // ── actions ──────────────────────────────────────────────────────────────
  //
  // A FALSE ACTION is one that EXECUTED and should not have. A planned action
  // the expectation lists as `pending_review` is a false action too - it would
  // have reached the customer without a person - and an action the run merely
  // proposed where the expectation wanted nothing is NOT, because a person
  // rejecting a suggestion is the system working.
  const executed = new Set(
    actual.actions.filter((a) => a.state === "planned" || a.state === "done").map((a) => a.tool),
  );
  const proposed = new Set(actual.actions.map((a) => a.tool));
  const expectedActions = testCase.expected.actions ?? null;

  const falseActions: Array<{ tool: string; tier: AgentTier }> = [];
  const missedActions: Array<{ tool: string; tier: AgentTier }> = [];

  if (expectedActions) {
    const shouldExecute = new Set(
      expectedActions.filter((a) => (a.state ?? "planned") === "planned").map((a) => a.tool),
    );
    const shouldExistAtAll = new Set(expectedActions.map((a) => a.tool));

    for (const tool of executed) {
      if (shouldExecute.has(tool)) continue;
      falseActions.push({ tool, tier: tierOf(tool) });
    }
    for (const tool of shouldExistAtAll) {
      if (proposed.has(tool as AgentToolName)) continue;
      missedActions.push({ tool, tier: tierOf(tool) });
    }
  }

  const dispositionChecked =
    testCase.expected.disposition !== null && testCase.expected.disposition !== undefined;

  return {
    caseId: testCase.id,
    tags: testCase.tags,
    language: testCase.language ?? null,
    intentTruePositives: tp,
    intentFalsePositives: fp,
    intentFalseNegatives: fn,
    slotsChecked,
    slotsExact,
    slotFailures,
    dispositionChecked,
    dispositionCorrect:
      dispositionChecked &&
      (actual.disposition ?? "").trim().toLowerCase() ===
        testCase.expected.disposition!.trim().toLowerCase(),
    falseActions,
    missedActions,
    needsHumanChecked:
      testCase.expected.needsHuman !== null && testCase.expected.needsHuman !== undefined,
    needsHumanCorrect: actual.needsHuman === testCase.expected.needsHuman,
    latencyMs: actual.latencyMs,
    costMinor: actual.costMinor,
  };
}

function tierOf(tool: string): AgentTier {
  try {
    return toolSpec(tool as AgentToolName).tier;
  } catch {
    // An unknown tool in an expectation is a typo in the fixture. Treat it as
    // the most severe tier so it cannot pass a gate quietly.
    return "T3";
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  §13.2 - aggregation
// ════════════════════════════════════════════════════════════════════════════

export interface IntentMetrics {
  type: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface EvalMetrics {
  cases: number;
  perIntent: readonly IntentMetrics[];
  /** Micro-averaged over every intent. */
  intentPrecision: number | null;
  intentRecall: number | null;
  intentF1: number | null;
  slotAccuracy: number | null;
  dispositionAccuracy: number | null;
  needsHumanAccuracy: number | null;
  /** §13.2, weighted differently from the next field - see the header. */
  falseActionRate: number | null;
  missedActionRate: number | null;
  /** Broken out, because a false T2/T3 action is the one that costs. */
  falseCustomerVisibleActions: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  costPerCallMinor: number | null;
  /** §13.1's per-language breakdown. */
  perLanguage: Readonly<Record<string, { cases: number; intentF1: number | null }>>;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function f1Of(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Nearest-rank, which is what a p95 on a few hundred cases should be - linear
  // interpolation invents a latency nobody observed.
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function aggregate(results: readonly CaseResult[]): EvalMetrics {
  const types = new Set<string>();
  for (const result of results) {
    for (const key of Object.keys(result.intentTruePositives)) types.add(key);
    for (const key of Object.keys(result.intentFalsePositives)) types.add(key);
    for (const key of Object.keys(result.intentFalseNegatives)) types.add(key);
  }

  const perIntent: IntentMetrics[] = [...types].sort().map((type) => {
    const tp = sum(results, (r) => r.intentTruePositives[type] ?? 0);
    const fp = sum(results, (r) => r.intentFalsePositives[type] ?? 0);
    const fn = sum(results, (r) => r.intentFalseNegatives[type] ?? 0);
    const precision = ratio(tp, tp + fp);
    const recall = ratio(tp, tp + fn);
    return {
      type,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision,
      recall,
      f1: f1Of(precision, recall),
    };
  });

  const tpAll = sum(perIntent, (m) => m.truePositives);
  const fpAll = sum(perIntent, (m) => m.falsePositives);
  const fnAll = sum(perIntent, (m) => m.falseNegatives);
  const intentPrecision = ratio(tpAll, tpAll + fpAll);
  const intentRecall = ratio(tpAll, tpAll + fnAll);

  const slotsChecked = sum(results, (r) => r.slotsChecked);
  const dispositionChecked = results.filter((r) => r.dispositionChecked).length;
  const needsHumanChecked = results.filter((r) => r.needsHumanChecked).length;

  const falseActions = sum(results, (r) => r.falseActions.length);
  const missedActions = sum(results, (r) => r.missedActions.length);

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);

  const perLanguage: Record<string, { cases: number; intentF1: number | null }> = {};
  for (const language of new Set(results.map((r) => r.language ?? "unknown"))) {
    const subset = results.filter((r) => (r.language ?? "unknown") === language);
    const tp = sum(subset, (r) => sumValues(r.intentTruePositives));
    const fp = sum(subset, (r) => sumValues(r.intentFalsePositives));
    const fn = sum(subset, (r) => sumValues(r.intentFalseNegatives));
    perLanguage[language] = {
      cases: subset.length,
      intentF1: f1Of(ratio(tp, tp + fp), ratio(tp, tp + fn)),
    };
  }

  return {
    cases: results.length,
    perIntent,
    intentPrecision,
    intentRecall,
    intentF1: f1Of(intentPrecision, intentRecall),
    slotAccuracy: ratio(sum(results, (r) => r.slotsExact), slotsChecked),
    dispositionAccuracy: ratio(
      results.filter((r) => r.dispositionChecked && r.dispositionCorrect).length,
      dispositionChecked,
    ),
    needsHumanAccuracy: ratio(
      results.filter((r) => r.needsHumanChecked && r.needsHumanCorrect).length,
      needsHumanChecked,
    ),
    // Per CASE, not per action: "how often does a run do something it should
    // not" is the question an owner asks, and dividing by the action count
    // would let a run that produces many correct actions dilute one wrong one.
    falseActionRate: ratio(results.filter((r) => r.falseActions.length > 0).length, results.length),
    missedActionRate: ratio(
      results.filter((r) => r.missedActions.length > 0).length,
      results.length,
    ),
    falseCustomerVisibleActions: sum(
      results,
      (r) => r.falseActions.filter((a) => a.tier === "T2" || a.tier === "T3").length,
    ),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    costPerCallMinor: ratio(sum(results, (r) => r.costMinor), results.length),
    perLanguage,
  };
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((acc, item) => acc + of(item), 0);
}

function sumValues(record: Readonly<Record<string, number>>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}

// ════════════════════════════════════════════════════════════════════════════
//  §13.3 - the release gates
// ════════════════════════════════════════════════════════════════════════════

export interface ReleaseGate {
  key: string;
  /** What a reader sees in the CI failure. */
  label: string;
  /** Read off `EvalMetrics`. */
  metric: keyof EvalMetrics;
  /** `min` - the value must be at least `threshold`. `max` - at most. */
  direction: "min" | "max";
  threshold: number;
  /**
   * An intent type, when the gate is about one. `null` = the aggregate.
   * §13.3's first row is specifically about CONFIRMED BOOKINGS.
   */
  intentType?: string;
}

/**
 * §13.3's table, as data.
 *
 * ── THE NUMBERS ARE THE SPEC'S, AND THEY ARE STARTING POINTS ────────────────
 *
 * §13.3 calls them "starting points; tune with real data", and that is recorded
 * here rather than silently hard-coded: an org's own gate thresholds live in
 * `agent_config` and override these. What does NOT change is the SHAPE - that
 * the false-action gate is an order of magnitude tighter than the F1 gate, and
 * that double-bookings are zero rather than small.
 */
export const RELEASE_GATES: readonly ReleaseGate[] = [
  {
    key: "booking_f1",
    label: "Intent F1 on confirmed bookings",
    metric: "perIntent",
    direction: "min",
    threshold: 0.95,
    intentType: "book_appointment",
  },
  {
    key: "slot_accuracy",
    label: "Date/time slot exact match",
    metric: "slotAccuracy",
    direction: "min",
    threshold: 0.97,
  },
  {
    key: "false_action_rate",
    label: "False-action rate",
    metric: "falseActionRate",
    direction: "max",
    threshold: 0.01,
  },
  {
    key: "false_customer_visible",
    label: "False customer-visible actions",
    metric: "falseCustomerVisibleActions",
    direction: "max",
    threshold: 0,
  },
  {
    key: "intent_f1",
    label: "Intent F1 overall",
    metric: "intentF1",
    direction: "min",
    threshold: 0.9,
  },
  {
    key: "disposition_accuracy",
    label: "Disposition accuracy",
    metric: "dispositionAccuracy",
    direction: "min",
    threshold: 0.9,
  },
  {
    key: "latency_p95",
    label: "Transcript to action, p95",
    metric: "latencyP95Ms",
    direction: "max",
    threshold: 30_000,
  },
];

export interface GateOutcome {
  key: string;
  label: string;
  passed: boolean;
  /** Null when the metric was not measured - which does NOT pass. */
  value: number | null;
  threshold: number;
  direction: "min" | "max";
  message: string;
}

export interface GateReport {
  passed: boolean;
  outcomes: readonly GateOutcome[];
  /** The ones that failed, for the CI summary line. */
  failures: readonly GateOutcome[];
}

/**
 * §13.2: "any change to prompts, models, resolvers, schema or policy runs the
 * full eval and BLOCKS RELEASE on regression."
 *
 * ── AN UNMEASURED GATE FAILS ────────────────────────────────────────────────
 *
 * A `null` value means the golden set did not exercise it. That must not pass:
 * the whole purpose is that a change cannot ship without evidence, and "we
 * removed the only booking fixture" would otherwise turn the booking gate green.
 *
 * The one exception is a gate whose threshold is a COUNT with no denominator -
 * `falseCustomerVisibleActions` is 0 on an empty run and genuinely means zero.
 */
export function checkGates(
  metrics: EvalMetrics,
  gates: readonly ReleaseGate[] = RELEASE_GATES,
): GateReport {
  const outcomes = gates.map((gate): GateOutcome => {
    const value = readMetric(metrics, gate);
    if (value === null) {
      return {
        key: gate.key,
        label: gate.label,
        passed: false,
        value: null,
        threshold: gate.threshold,
        direction: gate.direction,
        message: `${gate.label} was not measured by this golden set, so the gate cannot pass.`,
      };
    }
    const passed = gate.direction === "min" ? value >= gate.threshold : value <= gate.threshold;
    return {
      key: gate.key,
      label: gate.label,
      passed,
      value,
      threshold: gate.threshold,
      direction: gate.direction,
      message: passed
        ? ""
        : `${gate.label}: ${format(value)} ${gate.direction === "min" ? "is below" : "is above"} the ${format(gate.threshold)} gate.`,
    };
  });

  const failures = outcomes.filter((o) => !o.passed);
  return { passed: failures.length === 0, outcomes, failures };
}

function readMetric(metrics: EvalMetrics, gate: ReleaseGate): number | null {
  if (gate.metric === "perIntent") {
    const entry = metrics.perIntent.find((m) => m.type === gate.intentType);
    return entry?.f1 ?? null;
  }
  const value = metrics[gate.metric];
  return typeof value === "number" ? value : null;
}

function format(value: number): string {
  if (value >= 1000) return `${Math.round(value)}`;
  return value % 1 === 0 ? String(value) : value.toFixed(4).replace(/0+$/, "");
}

// ════════════════════════════════════════════════════════════════════════════
//  §13.3 - autonomy gating
// ════════════════════════════════════════════════════════════════════════════

/** §18: precision at or above 98 % over 200 or more reviewed cases. */
export const AUTONOMY_PRECISION_GATE = 0.98;
export const AUTONOMY_MIN_CASES = 200;

/**
 * Hysteresis: demote below this, which is BELOW the promotion gate.
 *
 * ── WHY THE TWO NUMBERS DIFFER ──────────────────────────────────────────────
 *
 * A single threshold makes an intent sitting at exactly 98 % flap: it is
 * promoted, the next reviewed case is a correction, it is demoted, the case
 * after that is fine, it is promoted again - and each flip is an alert to the
 * owner and a change in what the product does. Demoting at 96 % instead gives a
 * two-point band where the measurement can wobble without the behaviour
 * changing.
 */
export const AUTONOMY_DEMOTE_BELOW = 0.96;

export interface AutonomyInput {
  /** Measured on RECENT REAL DATA, per §13.3 - not on the golden set. */
  precision: number | null;
  reviewedCases: number;
  /** Is this intent currently set to execute automatically? */
  currentlyAuto: boolean;
  /** The org has asked for it to be automatic. Without this nothing promotes. */
  orgWantsAuto: boolean;
  /** False for T3 and for the intents whose entry forbids it outright. */
  eligible: boolean;
}

export type AutonomyAction = "promote" | "demote" | "hold";

export interface AutonomyDecision {
  action: AutonomyAction;
  reason: string;
  /** True when the owner should be alerted - §13.3's "raises an alert". */
  alert: boolean;
}

/**
 * §13.3: "an intent may be promoted to auto-execute (T2) only when its measured
 * precision on recent real data meets the gate and the owner explicitly enables
 * it. Accuracy dropping below the gate automatically demotes the intent back to
 * review and raises an alert."
 *
 * ── DEMOTION IS AUTOMATIC; PROMOTION NEEDS A PERSON ─────────────────────────
 *
 * The asymmetry is the safety property. Nothing here ever makes the product
 * more autonomous without the owner having asked (`orgWantsAuto`), and
 * everything here can make it less autonomous on its own. A measurement that
 * stops arriving demotes too - `precision === null` while an intent is live
 * means the signal has gone, and a live autonomous action with no accuracy
 * signal is exactly what §13.3's gate exists to prevent.
 */
export function autonomyDecision(input: AutonomyInput): AutonomyDecision {
  if (!input.eligible) {
    return input.currentlyAuto
      ? {
          action: "demote",
          reason: "this kind of action is never automatic",
          alert: true,
        }
      : { action: "hold", reason: "this kind of action is never automatic", alert: false };
  }

  if (input.currentlyAuto) {
    if (input.precision === null) {
      return {
        action: "demote",
        reason:
          "there is no recent accuracy measurement for this, so it has gone back to waiting for a person",
        alert: true,
      };
    }
    if (input.precision < AUTONOMY_DEMOTE_BELOW) {
      return {
        action: "demote",
        reason: `accuracy has fallen to ${(input.precision * 100).toFixed(1)}%, below the ${(AUTONOMY_DEMOTE_BELOW * 100).toFixed(0)}% it needs to keep running on its own`,
        alert: true,
      };
    }
    if (!input.orgWantsAuto) {
      return {
        action: "demote",
        reason: "you switched this back to needing a person",
        alert: false,
      };
    }
    return { action: "hold", reason: "still accurate enough", alert: false };
  }

  if (!input.orgWantsAuto) {
    return { action: "hold", reason: "you have not asked for this to be automatic", alert: false };
  }
  if (input.reviewedCases < AUTONOMY_MIN_CASES) {
    return {
      action: "hold",
      reason: `${input.reviewedCases} of the ${AUTONOMY_MIN_CASES} reviewed examples needed before this can run on its own`,
      alert: false,
    };
  }
  if (input.precision === null || input.precision < AUTONOMY_PRECISION_GATE) {
    return {
      action: "hold",
      reason: `accuracy is ${input.precision === null ? "not measured" : `${(input.precision * 100).toFixed(1)}%`}, and it needs ${(AUTONOMY_PRECISION_GATE * 100).toFixed(0)}%`,
      alert: false,
    };
  }
  return {
    action: "promote",
    reason: `${(input.precision * 100).toFixed(1)}% accurate over ${input.reviewedCases} reviewed examples`,
    alert: true,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  §13.4 - drift
// ════════════════════════════════════════════════════════════════════════════

export interface DriftSample {
  /** Mean final score across runs in the window. */
  meanScore: number | null;
  /** Mean STT confidence. */
  meanSttConfidence: number | null;
  /** Share of reviewed items a person corrected or rejected. */
  correctionRate: number | null;
  /** Intent mix: share of runs containing each type. */
  intentMix: Readonly<Record<string, number>>;
  runs: number;
}

export interface DriftFinding {
  signal: string;
  /** Negative = got worse. */
  delta: number;
  message: string;
  severity: "info" | "warn" | "alert";
}

/**
 * §13.4: "track confidence distributions, STT confidence, intent mix and
 * correction rates over time; alert on shifts."
 *
 * ── RELATIVE SHIFTS, NOT ABSOLUTE THRESHOLDS ────────────────────────────────
 *
 * A correction rate of 20 % is fine for a floor that has just switched the
 * feature on and alarming for one that was at 4 % last week. So this compares
 * against a baseline window rather than against a constant - which is also the
 * only way to catch a provider silently changing a model under a pinned name.
 *
 * ── AND IT NEEDS ENOUGH RUNS TO MEAN ANYTHING ───────────────────────────────
 *
 * Twenty runs either side. Below that, one bad call moves every number and the
 * alert is noise - which is how a drift monitor gets muted and then ignored.
 */
export const DRIFT_MIN_RUNS = 20;

export function driftReport(
  baseline: DriftSample,
  current: DriftSample,
): readonly DriftFinding[] {
  if (baseline.runs < DRIFT_MIN_RUNS || current.runs < DRIFT_MIN_RUNS) return [];

  const findings: DriftFinding[] = [];

  const compare = (
    signal: string,
    before: number | null,
    after: number | null,
    worseWhen: "lower" | "higher",
    warnAt: number,
    alertAt: number,
    describe: (delta: number) => string,
  ) => {
    if (before === null || after === null) return;
    const delta = after - before;
    const worse = worseWhen === "lower" ? -delta : delta;
    if (worse < warnAt) return;
    findings.push({
      signal,
      delta,
      message: describe(delta),
      severity: worse >= alertAt ? "alert" : "warn",
    });
  };

  compare(
    "confidence",
    baseline.meanScore,
    current.meanScore,
    "lower",
    0.05,
    0.15,
    (d) => `The assistant is less sure of itself than it was (${(d * 100).toFixed(1)} points).`,
  );
  compare(
    "stt_confidence",
    baseline.meanSttConfidence,
    current.meanSttConfidence,
    "lower",
    0.05,
    0.15,
    (d) => `Transcription quality has dropped (${(d * 100).toFixed(1)} points).`,
  );
  compare(
    "correction_rate",
    baseline.correctionRate,
    current.correctionRate,
    "higher",
    0.05,
    0.15,
    (d) => `People are correcting the assistant more often (up ${(d * 100).toFixed(1)} points).`,
  );

  // Intent mix: a type that has appeared or vanished is the signal, not a few
  // points of movement - a floor's conversation genuinely shifts week to week.
  for (const type of new Set([
    ...Object.keys(baseline.intentMix),
    ...Object.keys(current.intentMix),
  ])) {
    const before = baseline.intentMix[type] ?? 0;
    const after = current.intentMix[type] ?? 0;
    const delta = after - before;
    if (Math.abs(delta) < 0.2) continue;
    findings.push({
      signal: `intent_mix:${type}`,
      delta,
      message:
        delta > 0
          ? `"${type}" is coming up on far more calls than before.`
          : `"${type}" has almost stopped appearing.`,
      severity: "info",
    });
  }

  return findings;
}

/**
 * §12 and §13.4: "every correction in the review queue becomes a labeled eval
 * case." The shape of that case, so the API and the console agree on it.
 */
export interface CorrectionToCase {
  transcript: string;
  reference: string;
  timeZone: string;
  language: string | null;
  /** What the person said it should have been. */
  expected: EvalCase["expected"];
  tags: readonly string[];
}

export function caseFromCorrection(
  actionId: string,
  input: CorrectionToCase,
): EvalCase {
  return EvalCase.parse({
    id: `correction:${actionId}`,
    // Tagged so the golden set can be filtered to real corrections, which are
    // the cases that matter most: they are, by construction, the ones the
    // current build gets wrong.
    tags: [...new Set(["correction", ...input.tags])],
    transcript: input.transcript,
    language: input.language,
    reference: input.reference,
    timeZone: input.timeZone,
    expected: input.expected,
  });
}
