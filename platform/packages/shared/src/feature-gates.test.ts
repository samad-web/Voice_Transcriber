import { describe, expect, it } from "vitest";

import {
  AgentCapability,
  AgentMode,
  CAPABILITY_MIN_MODE,
  GATED_FEATURES,
  GateSettingState,
  type GateInput,
  type GateSetting,
  type GateSubject,
  evaluateCaps,
  gateAllows,
  gateUnavailable,
  gatedFeatureSpec,
  lowerMode,
  modeAtLeast,
  modeRank,
  resolveGate,
  settingInForce,
} from "./feature-gates";

const NOW = new Date("2026-10-09T10:00:00.000Z");

const SUBJECT: GateSubject = {
  userId: "11111111-1111-1111-1111-111111111111",
  telecallerId: "22222222-2222-2222-2222-222222222222",
  teamId: "33333333-3333-3333-3333-333333333333",
  ownerRole: "telecaller",
};

function setting(partial: Partial<GateSetting> & Pick<GateSetting, "scopeType">): GateSetting {
  return {
    scopeId: null,
    state: "on",
    mode: null,
    capabilities: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...partial,
  };
}

function input(partial: Partial<GateInput> = {}): GateInput {
  return {
    feature: "transcript_agent",
    subject: SUBJECT,
    enabledModules: ["aura", "crm", "call_intel"],
    settings: [],
    platformKillSwitch: false,
    now: NOW,
    ...partial,
  };
}

/** The org switched on at `auto` with everything, plus a user row. */
function enabled(partial: Partial<GateInput> = {}, userMode: AgentMode = "auto"): GateInput {
  return input({
    settings: [
      setting({
        scopeType: "org",
        state: "on",
        mode: "auto",
        capabilities: AgentCapability.options,
      }),
      setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on", mode: userMode }),
    ],
    ...partial,
  });
}

describe("the catalogue", () => {
  it("has a spec for every key, and every spec names a module", () => {
    for (const spec of GATED_FEATURES) {
      expect(gatedFeatureSpec(spec.key)).toBe(spec);
      expect(spec.module.length).toBeGreaterThan(0);
      expect(spec.modes[0]).toBe("off");
    }
  });

  it("defaults a fresh enablement to suggest, and to capabilities that cannot reach a customer", () => {
    const spec = gatedFeatureSpec("transcript_agent");
    expect(spec.defaultModeOnEnable).toBe("suggest");
    // §18: feature default OFF, mode `suggest` on first enablement. The same
    // caution one level down: nothing that reaches a customer is on by default.
    for (const capability of spec.defaultCapabilitiesOnEnable) {
      expect(["record", "tasks", "callbacks"]).toContain(capability);
    }
    expect(spec.defaultCapabilitiesOnEnable).not.toContain("messaging");
    expect(spec.defaultCapabilitiesOnEnable).not.toContain("payments");
    expect(spec.defaultCapabilitiesOnEnable).not.toContain("booking");
  });

  it("throws on an unknown key rather than guessing", () => {
    // @ts-expect-error - deliberately outside the enum
    expect(() => gatedFeatureSpec("not_a_feature")).toThrow(/unknown gated feature/);
  });
});

describe("mode ordering", () => {
  it("ranks the five modes lowest to highest", () => {
    expect(AgentMode.options).toEqual(["off", "shadow", "suggest", "assisted", "auto"]);
    const ranks = AgentMode.options.map(modeRank);
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it("takes the lower of two modes, in either argument order", () => {
    expect(lowerMode("auto", "suggest")).toBe("suggest");
    expect(lowerMode("suggest", "auto")).toBe("suggest");
    expect(lowerMode("shadow", "shadow")).toBe("shadow");
    expect(lowerMode("off", "auto")).toBe("off");
  });

  it("compares against a floor inclusively", () => {
    expect(modeAtLeast("suggest", "suggest")).toBe(true);
    expect(modeAtLeast("shadow", "suggest")).toBe(false);
    expect(modeAtLeast("auto", "shadow")).toBe(true);
  });
});

describe("resolveGate - the five steps, in order", () => {
  it("1. the platform kill switch beats everything, including a fully enabled org", () => {
    const decision = resolveGate(enabled({ platformKillSwitch: true }));
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("platform_kill_switch");
    expect(decision.mode).toBe("off");
    expect(decision.capabilities).toEqual([]);
    // It stopped at the first scope - nothing else was even consulted.
    expect(decision.scopes.map((s) => s.scopeType)).toEqual(["platform"]);
  });

  it("2. a missing module is LOCKED, not off - the console shows an upgrade prompt", () => {
    const decision = resolveGate(enabled({ enabledModules: ["aura", "crm"] }));
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("plan_missing");
    expect(decision.lockedByPlan).toBe(true);
  });

  it("2. and the module it needs is call_intel, not aura", () => {
    expect(gatedFeatureSpec("transcript_agent").module).toBe("call_intel");
    expect(resolveGate(enabled({ enabledModules: ["aura", "crm", "finance"] })).enabled).toBe(false);
  });

  it("3. an org that has never been configured is OFF, exactly like one switched off", () => {
    const never = resolveGate(input());
    expect(never.enabled).toBe(false);
    expect(never.reason).toBe("org_off");
    expect(never.lockedByPlan).toBe(false);

    const switchedOff = resolveGate(
      input({ settings: [setting({ scopeType: "org", state: "off" })] }),
    );
    expect(switchedOff.reason).toBe("org_off");
  });

  it("3. the org master switch does NOT switch it on for everybody", () => {
    // Enabling the feature must not hand it to a hundred telecallers at once;
    // §3A.6's per-user table is the point. No narrower row = no decision.
    const decision = resolveGate(
      input({
        settings: [setting({ scopeType: "org", state: "on", mode: "auto" })],
      }),
    );
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("no_decision");
  });

  it("4. a user row switches it on", () => {
    const decision = resolveGate(enabled());
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toBe("enabled");
    expect(decision.mode).toBe("auto");
  });

  it("4. a role default switches it on when there is no user row", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "assisted" }),
          setting({ scopeType: "role", scopeId: "telecaller", state: "on" }),
        ],
      }),
    );
    expect(decision.enabled).toBe(true);
    expect(decision.mode).toBe("assisted");
  });

  it("4. a team default switches it on when there is no user or role row", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "suggest" }),
          setting({ scopeType: "team", scopeId: SUBJECT.teamId, state: "on" }),
        ],
      }),
    );
    expect(decision.enabled).toBe(true);
    expect(decision.mode).toBe("suggest");
  });

  it("4. the narrowest ON wins: a user row beats a role row beats a team row", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "auto" }),
          setting({ scopeType: "team", scopeId: SUBJECT.teamId, state: "on", mode: "shadow" }),
          setting({ scopeType: "role", scopeId: "telecaller", state: "on", mode: "suggest" }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on", mode: "assisted" }),
        ],
      }),
    );
    expect(decision.mode).toBe("assisted");
  });

  it("4. AN EXPLICIT OFF AT ANY HIGHER SCOPE WINS - a user cannot opt back in", () => {
    // The rule most likely to be built backwards, because "most specific wins"
    // is the reflex everywhere else. §3A.1's closing sentence.
    const teamOff = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "auto" }),
          setting({ scopeType: "team", scopeId: SUBJECT.teamId, state: "off" }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on", mode: "auto" }),
        ],
      }),
    );
    expect(teamOff.enabled).toBe(false);
    expect(teamOff.reason).toBe("scope_off");

    const roleOff = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "auto" }),
          setting({ scopeType: "role", scopeId: "telecaller", state: "off" }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on", mode: "auto" }),
        ],
      }),
    );
    expect(roleOff.reason).toBe("scope_off");
  });

  it("4. `inherit` is not `off` - it steps past, rather than refusing", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "assisted" }),
          setting({ scopeType: "team", scopeId: SUBJECT.teamId, state: "inherit" }),
          setting({ scopeType: "role", scopeId: "telecaller", state: "on" }),
        ],
      }),
    );
    expect(decision.enabled).toBe(true);
    expect(decision.mode).toBe("assisted");
  });

  it("5. A USER CAN NEVER EXCEED THE ORG MAXIMUM", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "suggest" }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on", mode: "auto" }),
        ],
      }),
    );
    expect(decision.mode).toBe("suggest");
  });

  it("5. and a user below the maximum keeps their own lower mode", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "auto" }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on", mode: "shadow" }),
        ],
      }),
    );
    expect(decision.mode).toBe("shadow");
  });

  it("5. a user row whose mode is `off` denies, however enabled the org is", () => {
    const decision = resolveGate(enabled({}, "off"));
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("mode_off");
  });
});

describe("resolveGate - capabilities", () => {
  it("6. grants only what is in BOTH the subject's set and the org's", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({
            scopeType: "org",
            state: "on",
            mode: "auto",
            capabilities: ["record", "tasks", "callbacks"],
          }),
          setting({
            scopeType: "user",
            scopeId: SUBJECT.userId,
            state: "on",
            mode: "auto",
            capabilities: ["record", "booking", "messaging"],
          }),
        ],
      }),
    );
    // `booking` and `messaging` are outside the org's set, so they are refused
    // however the per-user row is written. The ceiling is the ceiling.
    expect(decision.capabilities).toEqual(["record"]);
    expect(gateAllows(decision, "record")).toBe(true);
    expect(gateAllows(decision, "booking")).toBe(false);
  });

  it("6. shadow mode permits `record` and nothing else", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({
            scopeType: "org",
            state: "on",
            mode: "shadow",
            capabilities: AgentCapability.options,
          }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on" }),
        ],
      }),
    );
    expect(decision.mode).toBe("shadow");
    expect(decision.capabilities).toEqual(["record"]);
    // "analyze and log only, no actions, no UI to staff" - §3A.2.
    for (const capability of AgentCapability.options) {
      if (capability === "record") continue;
      expect(gateAllows(decision, capability)).toBe(false);
    }
  });

  it("6. live_assist needs `assisted` at least - a review queue cannot hold a whisper", () => {
    expect(CAPABILITY_MIN_MODE.live_assist).toBe("assisted");
    const suggesting = resolveGate(
      input({
        settings: [
          setting({
            scopeType: "org",
            state: "on",
            mode: "suggest",
            capabilities: AgentCapability.options,
          }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on" }),
        ],
      }),
    );
    expect(gateAllows(suggesting, "live_assist")).toBe(false);
  });

  it("6. capabilities come back in catalogue order, not in the order they were stored", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({
            scopeType: "org",
            state: "on",
            mode: "auto",
            capabilities: ["messaging", "record", "booking"],
          }),
          setting({
            scopeType: "user",
            scopeId: SUBJECT.userId,
            state: "on",
            capabilities: ["booking", "messaging", "record"],
          }),
        ],
      }),
    );
    expect(decision.capabilities).toEqual(["record", "booking", "messaging"]);
  });

  it("the org's capability set is inherited when the subject row names none", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({
            scopeType: "org",
            state: "on",
            mode: "assisted",
            capabilities: ["record", "callbacks"],
          }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on" }),
        ],
      }),
    );
    expect(decision.capabilities).toEqual(["record", "callbacks"]);
  });
});

describe("resolveGate - the subject", () => {
  it("resolves a telecaller with NO user login through its team", () => {
    // `telecallers.user_id` is nullable (0017). A gate keyed only on `users`
    // would silently refuse to process the calls of most of a floor.
    const handsetOnly: GateSubject = {
      userId: null,
      telecallerId: SUBJECT.telecallerId,
      teamId: SUBJECT.teamId,
      ownerRole: null,
    };
    const decision = resolveGate(
      input({
        subject: handsetOnly,
        settings: [
          setting({ scopeType: "org", state: "on", mode: "assisted" }),
          setting({ scopeType: "team", scopeId: SUBJECT.teamId, state: "on" }),
        ],
      }),
    );
    expect(decision.enabled).toBe(true);
    expect(decision.mode).toBe("assisted");
    expect(decision.subject.userId).toBeNull();
  });

  it("does not match a user row against a null user id", () => {
    const anonymous: GateSubject = {
      userId: null,
      telecallerId: SUBJECT.telecallerId,
      teamId: null,
      ownerRole: null,
    };
    const decision = resolveGate(
      input({
        subject: anonymous,
        settings: [
          setting({ scopeType: "org", state: "on", mode: "auto" }),
          setting({ scopeType: "user", scopeId: null, state: "on" }),
        ],
      }),
    );
    // A stored row with a null scope_id must never be read as "everybody".
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("no_decision");
  });
});

describe("resolveGate - scheduled windows (§3A.5)", () => {
  it("ignores a row whose effective_from has not arrived", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "auto" }),
          setting({
            scopeType: "user",
            scopeId: SUBJECT.userId,
            state: "on",
            effectiveFrom: new Date("2026-10-10T00:00:00.000Z"),
          }),
        ],
      }),
    );
    expect(decision.reason).toBe("no_decision");
  });

  it("ignores a row whose effective_to has passed - a 14-day trial ends by itself", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "auto" }),
          setting({
            scopeType: "user",
            scopeId: SUBJECT.userId,
            state: "on",
            effectiveTo: new Date("2026-10-09T09:59:59.000Z"),
          }),
        ],
      }),
    );
    expect(decision.reason).toBe("no_decision");
  });

  it("treats effective_to as exclusive and effective_from as inclusive", () => {
    const atStart = setting({
      scopeType: "user",
      scopeId: SUBJECT.userId,
      effectiveFrom: NOW,
    });
    expect(settingInForce(atStart, NOW)).toBe(true);

    const atEnd = setting({ scopeType: "user", scopeId: SUBJECT.userId, effectiveTo: NOW });
    expect(settingInForce(atEnd, NOW)).toBe(false);
  });
});

describe("fail closed", () => {
  it("denies an unknown feature instead of throwing inside a worker loop", () => {
    const decision = resolveGate(
      // @ts-expect-error - a programming error reaching the gate
      input({ feature: "not_a_feature" }),
    );
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("gate_unavailable");
  });

  it("has one shape for `we do not know`", () => {
    const decision = gateUnavailable("transcript_agent", SUBJECT);
    expect(decision.enabled).toBe(false);
    expect(decision.mode).toBe("off");
    expect(decision.capabilities).toEqual([]);
    expect(decision.reason).toBe("gate_unavailable");
    expect(gateAllows(decision, "record")).toBe(false);
  });

  it("every denial reports mode off and no capabilities, whatever the cause", () => {
    const denials = [
      resolveGate(enabled({ platformKillSwitch: true })),
      resolveGate(enabled({ enabledModules: [] })),
      resolveGate(input()),
      resolveGate(enabled({}, "off")),
      gateUnavailable("transcript_agent", SUBJECT),
    ];
    for (const decision of denials) {
      expect(decision.enabled).toBe(false);
      expect(decision.mode).toBe("off");
      expect(decision.capabilities).toEqual([]);
    }
  });
});

describe("the audit snapshot (§3A.4)", () => {
  it("records every scope consulted, broadest first", () => {
    const decision = resolveGate(enabled());
    expect(decision.scopes.map((s) => s.scopeType)).toEqual([
      "platform",
      "plan",
      "org",
      "team",
      "role",
      "user",
    ]);
  });

  it("names a scope that was absent as absent, not as off", () => {
    const decision = resolveGate(
      input({
        settings: [
          setting({ scopeType: "org", state: "on", mode: "auto" }),
          setting({ scopeType: "user", scopeId: SUBJECT.userId, state: "on" }),
        ],
      }),
    );
    const team = decision.scopes.find((s) => s.scopeType === "team");
    expect(team?.state).toBe("absent");
  });
});

describe("the full matrix (§19)", () => {
  /**
   * Every combination of the five scopes' states against every mode. This is
   * the assertion §19 asks for literally, and it is here as a loop rather than
   * 600 hand-written cases because the invariants - not the individual
   * answers - are what must hold.
   */
  it("holds four invariants over every combination", () => {
    const states = GateSettingState.options;
    let checked = 0;

    for (const kill of [false, true]) {
      for (const modules of [["call_intel"], [] as string[]]) {
        for (const orgState of ["on", "off"] as const) {
          for (const orgMax of AgentMode.options) {
            for (const teamState of states) {
              for (const userState of states) {
                for (const userMode of AgentMode.options) {
                  const decision = resolveGate(
                    input({
                      platformKillSwitch: kill,
                      enabledModules: modules,
                      settings: [
                        setting({
                          scopeType: "org",
                          state: orgState,
                          mode: orgMax,
                          capabilities: AgentCapability.options,
                        }),
                        setting({
                          scopeType: "team",
                          scopeId: SUBJECT.teamId,
                          state: teamState,
                        }),
                        setting({
                          scopeType: "user",
                          scopeId: SUBJECT.userId,
                          state: userState,
                          mode: userMode,
                        }),
                      ],
                    }),
                  );
                  checked += 1;

                  // (a) The kill switch, a missing plan, an org OFF and an
                  //     explicit OFF at any narrower scope all deny.
                  if (
                    kill ||
                    modules.length === 0 ||
                    orgState === "off" ||
                    teamState === "off" ||
                    userState === "off"
                  ) {
                    expect(decision.enabled).toBe(false);
                    continue;
                  }

                  // (b) Nothing is granted without a narrower ON.
                  if (userState !== "on" && teamState !== "on") {
                    expect(decision.enabled).toBe(false);
                    continue;
                  }

                  // (c) The effective mode never exceeds the org maximum.
                  expect(modeRank(decision.mode)).toBeLessThanOrEqual(modeRank(orgMax));

                  // (d) `off` on either side means not enabled; anything else
                  //     is enabled with a mode at or below both.
                  if (orgMax === "off" || (userState === "on" && userMode === "off")) {
                    expect(decision.enabled).toBe(false);
                  } else {
                    expect(decision.enabled).toBe(true);
                    for (const capability of decision.capabilities) {
                      expect(modeAtLeast(decision.mode, CAPABILITY_MIN_MODE[capability])).toBe(true);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(checked).toBe(2 * 2 * 2 * 5 * 3 * 3 * 5);
  });
});

describe("evaluateCaps (§3A.7)", () => {
  const usage = { transcripts: 800, audioMinutes: 100, modelCostMinor: 5_000 };

  it("is ok below every soft limit", () => {
    expect(
      evaluateCaps(usage, [{ metric: "transcripts", softLimit: 900, hardLimit: 1000 }]).state,
    ).toBe("ok");
  });

  it("warns at 80 % when only a hard limit is set", () => {
    const result = evaluateCaps(usage, [
      { metric: "transcripts", softLimit: null, hardLimit: 1000 },
    ]);
    expect(result.state).toBe("warn");
    expect(result.metric).toBe("transcripts");
    expect(result.fraction).toBeCloseTo(0.8);
  });

  it("stops at 100 %", () => {
    const result = evaluateCaps(usage, [
      { metric: "transcripts", softLimit: null, hardLimit: 800 },
    ]);
    expect(result.state).toBe("hard");
    expect(result.used).toBe(800);
    expect(result.limit).toBe(800);
  });

  it("takes the worst state across metrics and says which one caused it", () => {
    const result = evaluateCaps(usage, [
      { metric: "transcripts", softLimit: 700, hardLimit: 2000 },
      { metric: "model_cost_minor", softLimit: null, hardLimit: 5_000 },
    ]);
    expect(result.state).toBe("hard");
    expect(result.metric).toBe("model_cost_minor");
  });

  it("treats a limit of zero as a real limit, not as absent", () => {
    const result = evaluateCaps({ transcripts: 0, audioMinutes: 0, modelCostMinor: 0 }, [
      { metric: "transcripts", softLimit: null, hardLimit: 0 },
    ]);
    expect(result.state).toBe("hard");
  });

  it("is ok when there are no limits at all - the default for every metric", () => {
    expect(evaluateCaps(usage, []).state).toBe("ok");
  });

  it("degrades a hard-capped org to `record` only rather than cutting it off", () => {
    const decision = resolveGate(enabled({ capState: "hard" }));
    // §3A.7: "the feature falls back to record-only or off". A capped org still
    // gets its summaries; the expensive half stops and the owner is alerted.
    expect(decision.enabled).toBe(true);
    expect(decision.mode).toBe("shadow");
    expect(decision.capabilities).toEqual(["record"]);
  });

  it("leaves a warned org running at full mode", () => {
    const decision = resolveGate(enabled({ capState: "warn" }));
    expect(decision.mode).toBe("auto");
  });
});
