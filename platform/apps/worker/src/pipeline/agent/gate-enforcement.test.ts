import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentCapability,
  type GateDecision,
  type GateSubject,
  TOOL_CATALOG,
  gateAllows,
  resolveGate,
} from "@aura/shared";
import { GateClosedError, assertGate, executeAction, isImplemented } from "./tools";
import type { ToolContext } from "./tools";
import type { PolicySideContext } from "./context";

/**
 * §19's GATE TESTS, the ones that need no database.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE FOUR THE SPEC CALLS OUT BY NAME
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §19: "Gate bypass attempts: direct API calls, DIRECT TOOL INVOCATIONS,
 * replayed jobs, and stale queued jobs for a disabled user must all be refused
 * and logged." / "Fail-closed: simulate gate service and cache outages and
 * verify denial." / "No-cost proof: for a disabled user, assert ZERO model
 * calls, zero calendar and messaging calls, and zero metered usage."
 *
 * The API's half lives in `agent-gate-coverage.spec.ts` (it reflects over Nest
 * metadata). This is the worker's half, and it is about the two doors the
 * endpoint tests cannot see: a tool called directly, and an action row that
 * reaches the executor without a recorded decision behind it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY A FAKE CLIENT AND NOT A DATABASE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every assertion here is about REFUSAL, and a refusal is proved by what did
 * NOT happen - no query, no write, no provider call. A fake client makes that
 * observable: the test can state "exactly zero statements were issued", which
 * is the actual no-cost claim and is not something a real database can tell
 * you afterwards.
 *
 * The paths that must WORK against real SQL are covered elsewhere: every
 * statement in this directory is prepared against a live schema, and
 * `golden-replay.test.ts` runs the planner end to end.
 */

const SUBJECT: GateSubject = {
  userId: "11111111-1111-4111-8111-111111111111",
  telecallerId: "22222222-2222-4222-8222-222222222222",
  teamId: null,
  ownerRole: null,
};

function decision(over: Partial<GateDecision> = {}): GateDecision {
  return {
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
    subject: SUBJECT,
    ...over,
  };
}

const CLOSED = decision({
  enabled: false,
  mode: "off",
  capabilities: [],
  reason: "scope_off",
});

/** A client that records every statement and answers nothing useful. */
function recordingClient(rows: Record<string, unknown>[] = []) {
  const statements: string[] = [];
  return {
    statements,
    query: vi.fn(async (sql: string) => {
      statements.push(sql.trim().split("\n")[0]!.trim());
      return { rows, rowCount: rows.length };
    }),
  };
}

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    orgId: "33333333-3333-4333-8333-333333333333",
    callId: "44444444-4444-4444-8444-444444444444",
    runId: "55555555-5555-4555-8555-555555555555",
    transcriptId: "66666666-6666-4666-8666-666666666666",
    gate: decision(),
    subject: SUBJECT,
    policy: { paused: false, disabledTools: [] } as unknown as PolicySideContext,
    actionId: "77777777-7777-4777-8777-777777777777",
    idempotencyKey: "call:tool:part",
    ...over,
  };
}

describe("§19: a tool invoked directly is refused, not run", () => {
  it("throws from assertGate for a capability the gate does not carry", () => {
    // The whole protection for a direct call. It THROWS rather than returning
    // false, because the one correct response to a closed gate is to stop and
    // a boolean is a boolean somebody forgets to read.
    expect(() => assertGate(CLOSED, "record")).toThrow(GateClosedError);
    expect(() => assertGate(decision({ capabilities: ["record"] }), "messaging")).toThrow(
      GateClosedError,
    );
  });

  it("names the capability and the reason in the error", () => {
    // What ends up on the action row and in the log. "Permission denied" with
    // no capability named is an alert nobody can act on.
    try {
      assertGate(CLOSED, "messaging");
      expect.unreachable("assertGate should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GateClosedError);
      const closed = error as GateClosedError;
      expect(closed.capability).toBe("messaging");
      expect(closed.reason).toBe("scope_off");
      expect(closed.message).toContain("messaging");
    }
  });

  it("allows a capability the gate does carry, so the check is not vacuous", () => {
    // The guard on the guard. An `assertGate` that threw for everything would
    // pass every assertion above and break the product.
    expect(() => assertGate(decision(), "booking")).not.toThrow();
    expect(gateAllows(decision(), "booking")).toBe(true);
  });

  it("refuses every capability in the catalogue when the gate is closed", () => {
    const capabilities = [...new Set(TOOL_CATALOG.map((tool) => tool.capability))];
    expect(capabilities.length).toBeGreaterThan(3);
    for (const capability of capabilities) {
      expect(() => assertGate(CLOSED, capability as AgentCapability)).toThrow(GateClosedError);
    }
  });
});

describe("§3A.4: an action with no recorded decision is refused before anything runs", () => {
  it("refuses when the row's gate_decision_id is null", async () => {
    // §3A.4: "the executor refuses any action lacking a valid
    // `gate_decision_id`." Checked against the ROW, so an action inserted by
    // anything other than the planner - a replayed job, a hand-written row -
    // is refused too.
    const client = recordingClient([{ gate_decision_id: null }]);
    const result = await executeAction(
      client as never,
      context(),
      "set_disposition",
      { disposition: "interested" },
    );
    expect(result).toEqual({
      ok: false,
      code: "blocked_by_gate",
      error: "this action has no recorded permission behind it, so it was refused",
    });
    // ONE statement: the guard read. Nothing was written, which is the claim.
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]).toMatch(/SELECT gate_decision_id/);
  });

  it("refuses when the action row does not exist at all", async () => {
    const client = recordingClient([]);
    const result = await executeAction(client as never, context(), "set_disposition", {});
    expect(result.ok).toBe(false);
    expect(client.statements).toHaveLength(1);
  });

  it("refuses while the assistant is paused, before the tool is reached", async () => {
    // §10's panic button. Read per ACTION rather than per run: "instantly"
    // means the action after the one already running.
    const client = recordingClient([{ gate_decision_id: "d1" }]);
    const result = await executeAction(
      client as never,
      context({ policy: { paused: true, disabledTools: [] } as unknown as PolicySideContext }),
      "set_disposition",
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_gate" });
    expect(client.statements).toHaveLength(1);
  });

  it("refuses a tool the owner switched off, by name", async () => {
    const client = recordingClient([{ gate_decision_id: "d1" }]);
    const result = await executeAction(
      client as never,
      context({
        policy: {
          paused: false,
          disabledTools: ["send_message"],
        } as unknown as PolicySideContext,
      }),
      "send_message",
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_gate" });
    expect((result as { error: string }).error).toContain("send_message");
    expect(client.statements).toHaveLength(1);
  });

  it("has a tool to refuse - every catalogue entry is either implemented or knowably not", () => {
    // Non-vacuity for the four cases above: if `TOOLS` were empty they would
    // all pass on the `not_implemented` branch instead of the gate branch.
    const implemented = TOOL_CATALOG.filter((tool) => isImplemented(tool.name));
    expect(implemented).toHaveLength(TOOL_CATALOG.length);
  });
});

describe("§19: fail closed when the gate cannot be resolved", () => {
  const original = process.env.FEATURE_GATE_KILL_SWITCH;

  beforeEach(() => {
    delete process.env.FEATURE_GATE_KILL_SWITCH;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_GATE_KILL_SWITCH;
    else process.env.FEATURE_GATE_KILL_SWITCH = original;
  });

  it("denies when the platform kill switch names the feature", () => {
    const gate = resolveGate({
      feature: "transcript_agent",
      subject: SUBJECT,
      enabledModules: ["call_intel"],
      settings: [
        {
          scopeType: "org",
          scopeId: null,
          state: "on",
          mode: "auto",
          capabilities: ["record"],
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          effectiveTo: null,
        },
      ],
      platformKillSwitch: true,
      now: new Date("2026-10-06T13:00:00.000Z"),
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("platform_kill_switch");
    expect(gate.capabilities).toEqual([]);
  });

  it("denies when the plan does not include the module, whatever the rows say", () => {
    const gate = resolveGate({
      feature: "transcript_agent",
      subject: SUBJECT,
      enabledModules: [],
      settings: [
        {
          scopeType: "user",
          scopeId: SUBJECT.userId,
          state: "on",
          mode: "auto",
          capabilities: ["record", "messaging"],
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          effectiveTo: null,
        },
      ],
      platformKillSwitch: false,
      now: new Date("2026-10-06T13:00:00.000Z"),
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("plan_missing");
  });

  it("denies a subject with no row of its own, because an org row is a ceiling", () => {
    // The single most important asymmetry in §3A.1: an org-level ON does not
    // GRANT anything. It sets the maximum. A floor whose owner switched the
    // workspace on but nobody in particular gets nothing, which is what
    // "OFF for the org and for every user until the owner enables it" means.
    const gate = resolveGate({
      feature: "transcript_agent",
      subject: SUBJECT,
      enabledModules: ["call_intel"],
      settings: [
        {
          scopeType: "org",
          scopeId: null,
          state: "on",
          mode: "auto",
          capabilities: ["record", "callbacks"],
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          effectiveTo: null,
        },
      ],
      platformKillSwitch: false,
      now: new Date("2026-10-06T13:00:00.000Z"),
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("no_decision");
  });
});

describe("§19's no-cost proof, as a property of the executor", () => {
  it("issues no statement past the guard read for any refusal", async () => {
    // The claim is "zero". Counting statements is how it is checked: a refusal
    // that still wrote an audit row, metered usage or touched a lead would
    // show up here as a second statement.
    for (const policy of [
      { paused: true, disabledTools: [] },
      { paused: false, disabledTools: ["set_disposition"] },
    ]) {
      const client = recordingClient([{ gate_decision_id: "d1" }]);
      const result = await executeAction(
        client as never,
        context({ policy: policy as unknown as PolicySideContext }),
        "set_disposition",
        { disposition: "interested" },
      );
      expect(result.ok).toBe(false);
      expect(client.statements).toHaveLength(1);
    }
  });

  it("marks a gate closed DURING execution as blocked, not failed", async () => {
    // A toggle race (§19's "switching off during ... execution"). The tool
    // throws `GateClosedError`, and the row has to say `blocked_by_gate` -
    // not `failed`, which is the bucket the retry sweep and the reliability
    // numbers read.
    const client = recordingClient([{ gate_decision_id: "d1" }]);
    const result = await executeAction(
      client as never,
      context({ gate: decision({ capabilities: ["tasks"] }) }),
      "set_disposition",
      { disposition: "interested" },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_by_gate" });
    const update = client.statements.find((sql) => sql.startsWith("UPDATE agent_actions"));
    expect(update).toBeDefined();
  });
});
