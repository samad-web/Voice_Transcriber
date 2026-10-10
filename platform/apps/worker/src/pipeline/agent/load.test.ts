import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKING_RULES,
  DEFAULT_CALLBACK_POLICY,
  DEFAULT_DAYPARTS,
  type GateDecision,
  GoldenFixture,
  type GoldenFixture as Fixture,
  TOOL_CATALOG,
  planActions,
  prepareTranscript,
} from "@aura/shared";
import { buildCandidates, requiredGrant, resolveIntents } from "./resolvers";
import type { PolicySideContext } from "./context";

/**
 * §19'S LOAD TEST AND M11'S p95, FOR THE HALF THIS CODE CONTROLS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS MEASURES, AND WHAT IT HONESTLY CANNOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §13.3's latency target is "post-call transcript to action, under 30 s p95".
 * That number is almost entirely one model call: the provider's time to first
 * token plus its generation, which on a long transcript is seconds and is not
 * something a test can make true or false.
 *
 * What IS in this code's hands is everything either side of that call -
 * redaction, injection detection, evidence verification, both resolvers, the
 * cross-checks, scoring, candidate building and the planner - and that budget
 * is TENS OF MILLISECONDS. So this test measures exactly that, over a seeded
 * batch, and asserts a budget with room in it.
 *
 * It is a real regression gate despite the modest claim: the realistic latency
 * failure in this code is an accidental O(n²) in the planner or a regex that
 * backtracks on a long transcript, and both show up here as a p95 that has
 * moved by an order of magnitude. Neither shows up anywhere else until a floor
 * with long calls notices.
 *
 * The model call's own latency and cost are measured in production, per run,
 * and reported per model tier (`estimateCostMinor` on the run row). §13.3's
 * table is a production dashboard, not a CI assertion, and pretending
 * otherwise with a mocked provider would be measuring the mock.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE BATCH IS SEEDED FROM THE GOLDEN SET, GROWN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §19 asks for "a seeded batch of thousands of transcripts". Rather than
 * generate noise, each golden fixture is repeated with its transcript padded
 * by filler turns - so the batch has the same intent mix, the same languages
 * and the same phrase shapes as the cases the gate already measures, at
 * transcript lengths a long call actually reaches.
 */

const FIXTURE_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "shared",
  "src",
  "fixtures",
  "transcript-agent",
);

const FIXTURES: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((file) => GoldenFixture.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))));

/**
 * How many transcripts the batch holds, and how long each one is.
 *
 * `AGENT_LOAD_RUNS` raises it for a real soak - `AGENT_LOAD_RUNS=20000` is
 * about a large tenant's month. The default is sized to finish inside a normal
 * test run, because a load test nobody runs measures nothing.
 */
const RUNS = Number(process.env.AGENT_LOAD_RUNS ?? 2_000);

/** Filler turns, so a padded transcript reads like a long call and not like noise. */
const FILLER = [
  "Agent: Ji sir, main samajh gaya. Aur koi sawaal?",
  "Customer: nahi, bas yahi tha.",
  "Agent: Theek hai sir, main note kar leta hoon.",
  "Customer: haan theek hai.",
  "Agent: Aapka time dene ke liye dhanyavaad.",
];

/**
 * The per-transcript budget, in milliseconds, for everything except the model.
 *
 * Deliberately loose - twenty times a healthy run on this machine - because
 * this test runs on whatever CI gives it, beside other suites, and a tight
 * budget here would be a flake that teaches people to ignore a red build. What
 * it catches is a regression of an ORDER OF MAGNITUDE, which is what an
 * accidental quadratic looks like.
 */
const P95_BUDGET_MS = Number(process.env.AGENT_LOAD_P95_MS ?? 60);

const OPEN_GATE: GateDecision = {
  feature: "transcript_agent",
  enabled: true,
  mode: "auto",
  capabilities: [
    "record",
    "tasks",
    "callbacks",
    "booking",
    "messaging",
    "payments",
    "sensitive_flows",
  ],
  lockedByPlan: false,
  reason: "enabled",
  scopes: [],
  subject: { userId: "u1", telecallerId: "t1", teamId: null, ownerRole: null },
};

const GRANTS = TOOL_CATALOG.map((tool) => requiredGrant(tool.name)).filter(
  (grant): grant is string => grant !== null,
);

function policyFor(fixture: Fixture): PolicySideContext {
  return {
    timeZone: fixture.timeZone,
    dayparts: DEFAULT_DAYPARTS,
    bookingRules: { ...DEFAULT_BOOKING_RULES, timeZone: fixture.timeZone },
    callbackPolicy: DEFAULT_CALLBACK_POLICY,
    paused: false,
    disabledTools: [],
    intentConfig: new Map(),
    customIntents: [],
    contactPolicy: { doNotContact: false, suppressed: false, consent: {} },
    amountTotalsMinor: fixture.context?.amountTotalsMinor ?? [],
    authorityLimitMinor: null,
    grants: GRANTS,
    existing: (fixture.context?.existing ?? []).map((entry) => ({
      tool: entry.tool as never,
      idempotencyKey: entry.key,
      active: entry.active,
      subject: entry.subject ?? null,
      at: entry.at ? new Date(entry.at) : null,
    })),
    busy: (fixture.context?.busy ?? []).map((span) => ({
      start: new Date(span.start),
      end: new Date(span.end),
    })),
    bookingsToday: 0,
    leadId: "11111111-1111-4111-8111-111111111111",
    contactId: "22222222-2222-4222-8222-222222222222",
    reviewSlaHours: 4,
  };
}

/** Everything the worker does to one transcript, except the model call. */
function processOne(fixture: Fixture, transcript: string, callId: string): number {
  const policy = policyFor(fixture);
  const reference = new Date(fixture.reference);

  const prepared = prepareTranscript(transcript);
  const { resolved } = resolveIntents({
    intents: fixture.understanding.intents,
    transcript: prepared.redacted,
    reference,
    policy,
    rolesInferred: false,
    sttConfidence: 0.93,
    chunked: false,
    injectionDetected: prepared.injection.length > 0,
    modelTense: fixture.understanding.tense ?? null,
  });
  const candidates = buildCandidates({
    callId,
    resolved,
    policy,
    gate: OPEN_GATE,
    identity: { userId: "u1", telecallerId: "t1", grants: GRANTS, authorityLimitMinor: null },
    reference,
    disposition: fixture.understanding.disposition ?? null,
    summary: fixture.understanding.summary,
    qualitySignals: fixture.understanding.quality_signals ?? null,
  });
  const plan = planActions({
    callId,
    gate: OPEN_GATE,
    mode: OPEN_GATE.mode,
    candidates,
    existing: [],
    rolesInferred: false,
  });
  return plan.actions.length;
}

function pad(transcript: string, turns: number): string {
  const extra: string[] = [];
  for (let i = 0; i < turns; i += 1) extra.push(FILLER[i % FILLER.length]!);
  // Padding goes AFTER, so the committed statement stays where a long call
  // puts it: the request is usually made and then chatted past.
  return `${transcript}\n${extra.join("\n")}`;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, at)]!;
}

describe(`§19's load test: ${RUNS} transcripts through the deterministic pipeline`, () => {
  it("has a batch to run", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15);
    expect(RUNS).toBeGreaterThanOrEqual(100);
  });

  it("meets the per-transcript budget at p95, and reports the numbers", () => {
    const durations: number[] = [];
    let actions = 0;
    let longest = 0;

    for (let i = 0; i < RUNS; i += 1) {
      const fixture = FIXTURES[i % FIXTURES.length]!;
      // 0 to 60 extra turns, so the batch spans a short call and a long one.
      const transcript = pad(fixture.transcript, (i * 7) % 61);
      longest = Math.max(longest, transcript.length);
      const started = performance.now();
      actions += processOne(fixture, transcript, `call-${i}`);
      durations.push(performance.now() - started);
    }

    durations.sort((a, b) => a - b);
    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);
    const total = durations.reduce((sum, ms) => sum + ms, 0);

    // Printed, not just asserted. The budget below only catches an order of
    // magnitude; the actual numbers are what somebody tuning this needs, and
    // they go in the run output so a CI log carries them.
    console.log(
      `[agent load] ${RUNS} transcripts, longest ${longest} chars, ${actions} actions planned\n` +
        `             p50 ${p50.toFixed(2)}ms  p95 ${p95.toFixed(2)}ms  p99 ${p99.toFixed(2)}ms  ` +
        `total ${(total / 1000).toFixed(2)}s  throughput ${Math.round(RUNS / (total / 1000))}/s`,
    );

    expect(p95).toBeLessThan(P95_BUDGET_MS);
    // And the batch did real work: a run that planned nothing would be fast
    // and meaningless.
    expect(actions).toBeGreaterThan(RUNS);
  });

  it("does not degrade with transcript length beyond linear", () => {
    // The specific regression this file exists to catch. A quadratic in the
    // planner or a backtracking regex makes the ratio explode; linear work
    // keeps it near the length ratio, and 8x length is allowed up to 20x time
    // because the short end is dominated by fixed costs.
    const fixture = FIXTURES.find((f) => f.understanding.intents.length > 0)!;
    const measure = (turns: number) => {
      const transcript = pad(fixture.transcript, turns);
      const started = performance.now();
      // Several passes: one pass at this size is within clock noise.
      for (let i = 0; i < 200; i += 1) processOne(fixture, transcript, `len-${turns}-${i}`);
      return performance.now() - started;
    };

    const short = measure(5);
    const long = measure(40);
    const ratio = long / Math.max(short, 0.001);
    console.log(`[agent load] 8x transcript length cost ${ratio.toFixed(2)}x time`);
    expect(ratio).toBeLessThan(20);
  });
});
