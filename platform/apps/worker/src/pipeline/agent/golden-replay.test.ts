import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ActualRun,
  DEFAULT_CALLBACK_POLICY,
  DEFAULT_BOOKING_RULES,
  DEFAULT_DAYPARTS,
  type GateDecision,
  GoldenFixture,
  type GoldenFixture as Fixture,
  aggregate,
  isAmountActionable,
  checkGates,
  bestInstant,
  compareCase,
  TOOL_CATALOG,
  planActions,
} from "@aura/shared";
import { buildCandidates, requiredGrant, resolveIntents } from "./resolvers";
import type { PolicySideContext } from "./context";

/**
 * §13.2's RELEASE GATE, OVER THE REPOSITORY'S GOLDEN SET.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS IS THE ONE THAT RUNS THE REAL SEQUENCE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The shared package's `golden-set.test.ts` gates the resolvers in isolation.
 * This one replays what the worker actually does with a model answer:
 *
 *   verifyIntents -> resolveIntents -> buildCandidates -> planActions
 *
 * and then scores the resulting plan against each case with the same
 * `compareCase` / `aggregate` / `checkGates` the running measurement uses. So a
 * change to the planner's ordering, a tier, a threshold, a policy check or a
 * resolver fails HERE, with the case named, on every run - which is §13.2's
 * "any change to prompts, models, resolvers, schema or policy runs the full
 * eval and blocks release on regression" for the four of those five that do
 * not need a provider.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE CONTEXT IS THE DEFAULTS, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * One `PolicySideContext` built from §18's defaults, shared by every case, with
 * the gate fully open at `auto`. Two reasons:
 *
 *   A case that only behaves correctly under one tenant's calling hours or one
 *   tenant's thresholds is that tenant's case, and belongs in their
 *   `agent_eval_cases` rather than in this folder.
 *
 *   The gate is open so the PLAN is what is measured. A closed gate would make
 *   every case produce an empty plan and the suite would pass, measuring
 *   nothing - which is the failure mode §13.2's "an unmeasured gate FAILS"
 *   exists to prevent, and `checkGates` enforces for the aggregate.
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

const FIXTURES: { file: string; fixture: Fixture }[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    fixture: GoldenFixture.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))),
  }));

/** The gate fully open. See the header for why. */
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
    // Every grant the tools ask for, DERIVED from the map the planner uses.
    // Listed by hand it would drift: two grants were wrong here before this
    // was derived, and the symptom was a policy case reading `not_permitted`,
    // which looks exactly like the planner refusing on purpose.
    grants: TOOL_CATALOG.map((tool) => requiredGrant(tool.name)).filter(
      (grant): grant is string => grant !== null,
    ),
    // What the workspace already holds, where the case declares it. Empty
    // otherwise, which is the common case: most fixtures are about reading a
    // call, not about colliding with a diary.
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

/** The worker's own sequence, over one fixture. */
function replay(fixture: Fixture): ActualRun {
  const policy = policyFor(fixture);
  const reference = new Date(fixture.reference);

  const { resolved } = resolveIntents({
    intents: fixture.understanding.intents,
    transcript: fixture.transcript,
    reference,
    policy,
    // Fixtures all carry speaker labels, so roles were NOT inferred - which
    // matters: `roles_inferred` caps the whole run at `suggest` and would make
    // every action on every case `pending_review`.
    rolesInferred: false,
    sttConfidence: fixture.tags.includes("noisy") ? 0.62 : 0.93,
    chunked: false,
    injectionDetected: fixture.privacy?.injection ?? false,
    modelTense: fixture.understanding.tense ?? null,
  });

  const candidates = buildCandidates({
    callId: "33333333-3333-4333-8333-333333333333",
    resolved,
    policy,
    gate: OPEN_GATE,
    identity: {
      userId: "u1",
      telecallerId: "t1",
      grants: policy.grants,
      authorityLimitMinor: null,
    },
    reference,
    disposition: fixture.understanding.disposition ?? null,
    summary: fixture.understanding.summary,
    qualitySignals: fixture.understanding.quality_signals ?? null,
  });

  const plan = planActions({
    callId: "33333333-3333-4333-8333-333333333333",
    gate: OPEN_GATE,
    mode: OPEN_GATE.mode,
    candidates,
    rolesInferred: false,
  });

  // §6: "the last confirmed statement wins; earlier ones are recorded as
  // superseded." The eval measures the intents the run ACTED on, so a
  // superseded reading is excluded here - `compareCase` matches by type, and
  // keeping both would score the earlier time the customer took back as a
  // false positive against the later one they actually gave.
  //
  // The superseded reading is still asserted: `expected.actions` pins it as
  // `schedule_callback:recorded`, which is where §6 says it belongs.
  const acted = resolved.filter((item) => item.intent.superseded !== true);

  return {
    intents: acted.map((item) => ({
      type: item.type,
      // `bestInstant` rather than reaching into the resolution: it is the one
      // definition of "which moment a window means" (its start, not its
      // midpoint), and a second one here would make the gate measure a
      // different number from the one the planner acts on.
      dueAt: item.time ? (bestInstant(item.time)?.toISOString() ?? null) : null,
      amountMinor:
        item.amount && isAmountActionable(item.amount) ? item.amount.amountMinor : null,
      resolution: item.time ? item.time.kind : null,
    })),
    disposition: fixture.understanding.disposition ?? null,
    actions: plan.actions.map((action) => ({ tool: action.tool, state: action.state })),
    needsHuman: fixture.understanding.needs_human,
    // Latency and cost are not replayable - there is no model call here - so
    // they are set inside §13.3's targets. The gate still MEASURES them, which
    // is the point: a real run that blows the budget fails the running
    // measurement, and this suite does not pretend to check that.
    latencyMs: 8_000,
    costMinor: 40,
  };
}

describe("§13.2: the golden set replays through the real planner", () => {
  it("found the fixtures - a missing folder would pass every assertion below", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15);
  });


  it("plans exactly the actions each case expects", () => {
    // Per case rather than only in aggregate: the aggregate gate tolerates a
    // small failure rate by design, so a single case silently flipping from
    // `planned` to `pending_review` would not move it. This is the assertion
    // that names the case.
    for (const { file, fixture } of FIXTURES) {
      const actual = replay(fixture);
      const expectedActions = (fixture.expected.actions ?? [])
        .map((action) => `${action.tool}:${action.state ?? "planned"}`)
        .sort();
      const actualActions = actual.actions
        .map((action) => `${action.tool}:${action.state}`)
        .sort();
      expect({ file, actions: actualActions }).toEqual({ file, actions: expectedActions });
    }
  });

  it("reads exactly the intents each case expects", () => {
    for (const { file, fixture } of FIXTURES) {
      const actual = replay(fixture);
      expect({ file, types: actual.intents.map((i) => i.type).sort() }).toEqual({
        file,
        types: fixture.expected.intents.map((i) => i.type).sort(),
      });
    }
  });

  it("PASSES every §13.2 release gate", () => {
    const results = FIXTURES.map(({ fixture }) => compareCase(fixture, replay(fixture)));
    const report = checkGates(aggregate(results));
    // The failures are printed with their measured values, so a red CI run
    // says WHICH gate moved and by how much rather than "the eval failed".
    expect(report.failures.map((f) => `${f.key}=${f.value ?? "unmeasured"}`)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("FAILS when the planner starts proposing a customer-visible action nobody asked for", () => {
    // The guard on the guard. §13.2's `false_customer_visible` gate is zero
    // tolerance, and a suite that could not go red would protect nothing.
    const results = FIXTURES.map(({ fixture }) => compareCase(fixture, replay(fixture)));
    const sabotaged = FIXTURES.map(({ fixture }) => {
      const actual = replay(fixture);
      return compareCase(fixture, {
        ...actual,
        actions: [...actual.actions, { tool: "send_message" as const, state: "planned" }],
      });
    });
    expect(checkGates(aggregate(results)).passed).toBe(true);
    expect(checkGates(aggregate(sabotaged)).passed).toBe(false);
  });
});
