import { describe, expect, it } from "vitest";

import {
  AgentCapability,
  AgentMode,
  type GateDecision,
  type GateSubject,
} from "./feature-gates";
import {
  AgentToolName,
  type AgentToolName as AgentToolNameType,
  INTENT_CATALOG,
  idempotencyKey,
  toolSpec,
} from "./transcript-agent";
import {
  type ActionCandidate,
  type ActingIdentity,
  type BookingRules,
  type BusySpan,
  type ContactPolicyState,
  DEFAULT_BOOKING_RULES,
  POLICY_VERSION,
  cascadeSkips,
  checkContactPolicy,
  checkPermission,
  checkSlot,
  checkTemplate,
  compensationFor,
  findDuplicate,
  pickAssignee,
  planActions,
  proposeSlots,
  reviewSlaDeadline,
} from "./agent-policy";
import { instantToWallTime } from "./time";

const ZONE = "Asia/Kolkata";
const NOW = new Date("2026-10-09T06:30:00.000Z"); // 12:00 IST, Friday
const CALL = "4bd1a6f0-0000-4000-8000-000000000001";

const SUBJECT: GateSubject = {
  userId: "11111111-1111-1111-1111-111111111111",
  telecallerId: "22222222-2222-2222-2222-222222222222",
  teamId: null,
  ownerRole: "telecaller",
};

function gate(
  mode: AgentMode = "auto",
  capabilities: readonly AgentCapability[] = AgentCapability.options,
): GateDecision {
  return {
    feature: "transcript_agent",
    enabled: mode !== "off",
    mode,
    capabilities,
    lockedByPlan: false,
    reason: mode === "off" ? "mode_off" : "enabled",
    scopes: [],
    subject: SUBJECT,
  };
}

function rules(overrides: Partial<BookingRules> = {}): BookingRules {
  return { ...DEFAULT_BOOKING_RULES, timeZone: ZONE, ...overrides };
}

function wall(instant: Date): string {
  return instantToWallTime(instant, ZONE).replace("T", " ");
}

/** 10:00-19:00 IST on the given day, as an instant. */
function ist(dayKey: string, hour: number, minute = 0): Date {
  const offset = 5 * 60 + 30;
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + (hour * 60 + minute - offset) * 60_000);
}

function candidate(partial: Partial<ActionCandidate> = {}): ActionCandidate {
  return {
    intentType: "callback_request",
    intentIndex: 0,
    tool: "schedule_callback",
    params: {},
    keyParts: { contact: "+919876543210" },
    score: 0.95,
    policy: { ok: true, code: "ok", message: "" },
    ...partial,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  §17 M4's two acceptance criteria
// ════════════════════════════════════════════════════════════════════════════

describe("M4 ACCEPTANCE: T3 never auto-executes", () => {
  it("holds for every mode, with the org's switch on and the accuracy gate met", () => {
    for (const mode of AgentMode.options) {
      const plan = planActions({
        callId: CALL,
        gate: gate(mode),
        mode,
        candidates: [
          candidate({
            intentType: "refund_or_cancel_request",
            tool: "request_refund_review",
            keyParts: {},
            score: 1,
            orgEnabledAuto: true,
            accuracyGateMet: true,
          }),
        ],
      });
      const action = plan.actions[0]!;
      expect(action.state).not.toBe("planned");
      if (mode !== "off") {
        expect(action.state).toBe("pending_review");
        expect(action.code).toBe("tier_requires_human");
        expect(action.reason).toMatch(/never does it by itself/);
      }
    }
  });

  it("holds for every T3 tool in the catalog", () => {
    const t3 = AgentToolName.options.filter((name) => toolSpec(name).tier === "T3");
    expect(t3.length).toBeGreaterThan(0);
    for (const tool of t3) {
      const plan = planActions({
        callId: CALL,
        gate: gate("auto"),
        mode: "auto",
        candidates: [
          candidate({
            intentType: "refund_or_cancel_request",
            tool,
            keyParts: {},
            score: 1,
            orgEnabledAuto: true,
            accuracyGateMet: true,
          }),
        ],
      });
      expect(plan.actions[0]!.state).toBe("pending_review");
    }
  });
});

describe("M4 ACCEPTANCE: opt-outs are always honoured", () => {
  const optedOut: ContactPolicyState = {
    doNotContact: true,
    consent: {},
    suppressed: false,
  };

  it("blocks every customer-visible tool for an opted-out contact", () => {
    for (const tool of AgentToolName.options) {
      if (!toolSpec(tool).customerVisible) continue;
      const result = checkContactPolicy(tool, optedOut);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("opt_out");
    }
  });

  it("blocks a CALLBACK too - a callback is contact", () => {
    expect(checkContactPolicy("schedule_callback", optedOut).ok).toBe(false);
  });

  it("blocks for a suppressed number as well as an explicit opt-out", () => {
    const suppressed: ContactPolicyState = {
      doNotContact: false,
      consent: {},
      suppressed: true,
    };
    expect(checkContactPolicy("send_message", suppressed).code).toBe("opt_out");
  });

  it("refuses a channel the customer has not consented to", () => {
    const noWhatsapp: ContactPolicyState = {
      doNotContact: false,
      consent: { whatsapp: false },
      suppressed: false,
    };
    expect(checkContactPolicy("send_message", noWhatsapp, "whatsapp").code).toBe("no_consent");
    expect(checkContactPolicy("send_message", noWhatsapp, "sms").ok).toBe(true);
  });

  it("STILL ALLOWS recording the opt-out itself", () => {
    // The one case where refusing would mean a customer's own request blocked
    // the honouring of that request.
    expect(checkContactPolicy("mark_do_not_contact", optedOut).ok).toBe(true);
  });

  it("still allows internal records about the call", () => {
    for (const tool of ["set_disposition", "write_call_summary", "create_followup"] as const) {
      expect(checkContactPolicy(tool, optedOut).ok).toBe(true);
    }
  });

  it("cannot be overridden by the plan - a refused policy becomes `blocked`", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({
          intentType: "send_information",
          tool: "send_information",
          keyParts: { doc: "brochure" },
          score: 1,
          orgEnabledAuto: true,
          accuracyGateMet: true,
          policy: checkContactPolicy("send_information", optedOut),
        }),
      ],
    });
    expect(plan.actions[0]!.state).toBe("blocked");
    expect(plan.actions[0]!.code).toBe("opt_out");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - templates
// ════════════════════════════════════════════════════════════════════════════

describe("checkTemplate (§8.1)", () => {
  it("accepts an approved template and a local canned reply", () => {
    expect(checkTemplate({ name: "callback_confirm", status: "approved" }).ok).toBe(true);
    expect(checkTemplate({ name: "callback_confirm", status: "local" }).ok).toBe(true);
  });

  it("refuses a paused, rejected, pending or disabled template", () => {
    for (const status of ["paused", "rejected", "pending", "disabled"]) {
      const result = checkTemplate({ name: "t", status });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("template_not_approved");
      expect(result.message).toContain(status);
    }
  });

  it("refuses when there is no template at all - no free-form generation", () => {
    const result = checkTemplate(null);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nothing can be sent/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - availability
// ════════════════════════════════════════════════════════════════════════════

describe("checkSlot (§8.1)", () => {
  const slot = (hour: number, minute = 0, dayKey = "2026-10-09"): BusySpan => ({
    start: ist(dayKey, hour, minute),
    end: ist(dayKey, hour, minute + 30),
  });

  it("accepts a free slot inside working hours", () => {
    expect(checkSlot(slot(16), [], rules(), NOW).ok).toBe(true);
  });

  it("refuses a slot inside the minimum notice", () => {
    // NOW is 12:00; 12:20 is 20 minutes away and the notice is 30.
    const result = checkSlot(slot(12, 20), [], rules(), NOW);
    expect(result.code).toBe("too_soon");
  });

  it("refuses a slot outside working hours", () => {
    // 08:00 TOMORROW, not today: 08:00 today is behind NOW and would be
    // refused as `too_soon` before the hours were ever considered.
    expect(checkSlot(slot(8, 0, "2026-10-10"), [], rules(), NOW).code).toBe(
      "outside_working_hours",
    );
    expect(checkSlot(slot(20), [], rules(), NOW).code).toBe("outside_working_hours");
  });

  it("says a past slot has passed, rather than that it is 30 minutes away", () => {
    const result = checkSlot(slot(8), [], rules(), NOW);
    expect(result.code).toBe("too_soon");
    expect(result.message).toBe("That time has already passed.");
  });

  it("refuses a slot that would run PAST the end of the window", () => {
    // 18:45 + 30 minutes = 19:15, past the 19:00 close. The start is inside
    // the window and the booking is not, which a start-only check would miss.
    expect(checkSlot(slot(18, 45), [], rules(), NOW).code).toBe("outside_working_hours");
  });

  it("refuses a non-working day and a closed day", () => {
    expect(checkSlot(slot(16, 0, "2026-10-11"), [], rules(), NOW).code).toBe(
      "outside_working_hours",
    ); // Sunday
    expect(
      checkSlot(slot(16), [], rules({ closedDays: ["2026-10-09"] }), NOW).code,
    ).toBe("holiday_or_leave");
  });

  it("refuses a busy slot", () => {
    const busy = [{ start: ist("2026-10-09", 16), end: ist("2026-10-09", 17) }];
    expect(checkSlot(slot(16, 30), busy, rules(), NOW).code).toBe("slot_busy");
  });

  it("APPLIES THE BUFFER, so a back-to-back booking is refused", () => {
    // A meeting ending at 16:00 and another starting at 16:00 is legal by
    // overlap and wrong in practice: §18's 10-minute buffer exists so a
    // telecaller is not on two calls with no gap.
    const busy = [{ start: ist("2026-10-09", 15), end: ist("2026-10-09", 16) }];
    expect(checkSlot(slot(16), busy, rules(), NOW).code).toBe("slot_busy");
    // Ten minutes later is fine.
    expect(checkSlot(slot(16, 10), busy, rules(), NOW).ok).toBe(true);
  });

  it("refuses once the day is full", () => {
    expect(checkSlot(slot(16), [], rules({ maxPerDay: 3 }), NOW, 3).code).toBe("day_full");
    expect(checkSlot(slot(16), [], rules({ maxPerDay: 3 }), NOW, 2).ok).toBe(true);
    // 0 means unlimited.
    expect(checkSlot(slot(16), [], rules({ maxPerDay: 0 }), NOW, 99).ok).toBe(true);
  });

  it("refuses a zero-length slot", () => {
    const zero = { start: ist("2026-10-09", 16), end: ist("2026-10-09", 16) };
    expect(checkSlot(zero, [], rules(), NOW).code).toBe("no_slot_available");
  });
});

describe("proposeSlots (§7.1's windows become slots)", () => {
  it("walks a window in slot-length steps and skips the busy ones", () => {
    const window = { start: ist("2026-10-09", 16), end: ist("2026-10-09", 18) };
    const busy = [{ start: ist("2026-10-09", 16, 30), end: ist("2026-10-09", 17) }];
    const slots = proposeSlots(window, busy, rules(), NOW);
    // Only 17:30 survives, and the buffer is why. The candidates are 16:00,
    // 16:30, 17:00 and 17:30; with §18's 10-minute buffer each is widened by
    // ten minutes either side, so 16:00 (15:50-16:40), 16:30 and 17:00
    // (16:50-17:40) all touch the 16:30-17:00 meeting. That is the buffer doing
    // its job - a telecaller is not put on two calls with no gap.
    expect(slots.map((s) => wall(s.start))).toEqual(["2026-10-09 17:30"]);
  });

  it("offers every step when nothing is in the way", () => {
    const window = { start: ist("2026-10-09", 16), end: ist("2026-10-09", 18) };
    expect(proposeSlots(window, [], rules(), NOW).map((s) => wall(s.start))).toEqual([
      "2026-10-09 16:00",
      "2026-10-09 16:30",
      "2026-10-09 17:00",
      "2026-10-09 17:30",
    ]);
  });

  it("offers the first candidate for a zero-length window - an exact time", () => {
    // "at 5" resolves to an instant; a 30-minute meeting at 17:00 does not stop
    // being proposable because the window had no width.
    const at17 = ist("2026-10-09", 17);
    const slots = proposeSlots({ start: at17, end: at17 }, [], rules(), NOW);
    expect(slots).toHaveLength(1);
    expect(wall(slots[0]!.start)).toBe("2026-10-09 17:00");
  });

  it("returns nothing for a window that is entirely outside working hours", () => {
    const window = { start: ist("2026-10-09", 22), end: ist("2026-10-09", 23) };
    expect(proposeSlots(window, [], rules(), NOW)).toEqual([]);
  });

  it("is bounded, so a month-long window cannot generate a thousand candidates", () => {
    const window = { start: ist("2026-10-13", 10), end: ist("2026-11-13", 19) };
    expect(proposeSlots(window, [], rules(), NOW).length).toBeLessThanOrEqual(8);
    expect(proposeSlots(window, [], rules(), NOW, 3)).toHaveLength(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - assignment
// ════════════════════════════════════════════════════════════════════════════

describe("pickAssignee (§8.1)", () => {
  const person = (id: string, partial: Partial<Parameters<typeof pickAssignee>[1][number]> = {}) => ({
    userId: id,
    available: true,
    load: 0,
    lastAssignedAt: null,
    skills: [] as string[],
    ...partial,
  });

  it("gives it to the lead's own owner when they are available", () => {
    const result = pickAssignee(person("owner"), [person("a"), person("b")], "round_robin");
    expect(result).toEqual({ userId: "owner", reason: "the lead's own owner" });
  });

  it("DOES NOT leave it with an unavailable owner", () => {
    // Leaving it is how a customer's callback sits in an absent person's list
    // for a week - the silent loss §20 forbids.
    const result = pickAssignee(
      person("owner", { available: false }),
      [person("a"), person("b")],
      "round_robin",
    );
    expect(result!.userId).not.toBe("owner");
    expect(result!.reason).toMatch(/not available/);
  });

  it("round-robins to the longest-idle person", () => {
    const result = pickAssignee(
      null,
      [
        person("recent", { lastAssignedAt: new Date("2026-10-09T05:00:00Z") }),
        person("idle", { lastAssignedAt: new Date("2026-10-01T05:00:00Z") }),
      ],
      "round_robin",
    );
    expect(result!.userId).toBe("idle");
  });

  it("prefers somebody never assigned over somebody assigned long ago", () => {
    const result = pickAssignee(
      null,
      [
        person("long-ago", { lastAssignedAt: new Date("2020-01-01T00:00:00Z") }),
        person("never", { lastAssignedAt: null }),
      ],
      "round_robin",
    );
    expect(result!.userId).toBe("never");
  });

  it("picks the least loaded when asked to", () => {
    const result = pickAssignee(
      null,
      [person("busy", { load: 40 }), person("free", { load: 2 })],
      "least_loaded",
    );
    expect(result!.userId).toBe("free");
  });

  it("honours a required skill", () => {
    const result = pickAssignee(
      null,
      [person("generalist"), person("specialist", { skills: ["hindi"] })],
      "skill",
      "hindi",
    );
    expect(result!.userId).toBe("specialist");
  });

  it("returns NULL rather than guessing when nobody is available", () => {
    expect(
      pickAssignee(person("owner", { available: false }), [person("a", { available: false })], "round_robin"),
    ).toBeNull();
    expect(pickAssignee(null, [], "round_robin")).toBeNull();
  });

  it("is deterministic across restarts for a tie", () => {
    const pool = [person("b"), person("a")];
    expect(pickAssignee(null, pool, "round_robin")!.userId).toBe("a");
    expect(pickAssignee(null, [...pool].reverse(), "round_robin")!.userId).toBe("a");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - permissions
// ════════════════════════════════════════════════════════════════════════════

describe("checkPermission (§8.1)", () => {
  const identity: ActingIdentity = {
    userId: SUBJECT.userId,
    telecallerId: SUBJECT.telecallerId,
    grants: ["appointment:create", "task:create"],
    authorityLimitMinor: 50_000_00,
  };

  it("THE AGENT CANNOT DO WHAT THE TELECALLER CANNOT", () => {
    // What bounds the blast radius of a bug to one person's existing access.
    expect(checkPermission("book_slot", identity, "appointment:create").ok).toBe(true);
    const refused = checkPermission("create_payment_link", identity, "finance:edit");
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("not_permitted");
    expect(refused.message).toMatch(/not allowed/);
  });

  it("respects the org chart's authority limit on amounts", () => {
    expect(checkPermission("create_payment_link", identity, null, 40_000_00).ok).toBe(true);
    const over = checkPermission("create_payment_link", identity, null, 60_000_00);
    expect(over.code).toBe("over_authority");
  });

  it("treats a null limit as no limit", () => {
    expect(
      checkPermission(
        "create_payment_link",
        { ...identity, authorityLimitMinor: null },
        null,
        999_999_00,
      ).ok,
    ).toBe(true);
  });

  it("does not check an amount that was not supplied", () => {
    expect(checkPermission("book_slot", identity, "appointment:create").ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - duplicates
// ════════════════════════════════════════════════════════════════════════════

describe("findDuplicate (§8.1)", () => {
  const existing = [
    {
      tool: "book_slot" as const,
      idempotencyKey: "other-call:book_slot:book:x",
      active: true,
      subject: "2026-10-13T09:30:00Z",
      at: new Date("2026-10-13T09:30:00Z"),
    },
  ];

  it("catches a DIFFERENT run proposing the same thing", () => {
    // The idempotency key catches a redelivery; this catches call 2 proposing
    // the slot call 1 already booked. The keys differ and the customer would
    // get two appointments.
    const found = findDuplicate(
      "book_slot",
      "2026-10-13T09:30:00Z",
      new Date("2026-10-13T09:30:00Z"),
      existing,
    );
    expect(found).toBe(existing[0]);
  });

  it("does not match a cancelled item", () => {
    expect(
      findDuplicate("book_slot", "2026-10-13T09:30:00Z", new Date("2026-10-13T09:30:00Z"), [
        { ...existing[0]!, active: false },
      ]),
    ).toBeNull();
  });

  it("does not match a different tool or a different subject", () => {
    expect(findDuplicate("cancel_slot", "2026-10-13T09:30:00Z", null, existing)).toBeNull();
    expect(findDuplicate("book_slot", "2026-10-14T09:30:00Z", null, existing)).toBeNull();
  });

  it("ignores case and padding in the subject", () => {
    expect(findDuplicate("book_slot", " 2026-10-13T09:30:00Z ", null, existing)).toBe(existing[0]);
  });

  it("only looks inside the window", () => {
    expect(
      findDuplicate(
        "book_slot",
        "2026-10-13T09:30:00Z",
        new Date("2026-10-20T09:30:00Z"),
        existing,
      ),
    ).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  §3 - the plan
// ════════════════════════════════════════════════════════════════════════════

describe("planActions - the gate comes first (§3A.4)", () => {
  it("blocks everything when the gate is off", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("off"),
      mode: "off",
      candidates: [candidate(), candidate({ tool: "write_call_summary", keyParts: {}, intentType: null })],
    });
    for (const action of plan.actions) {
      expect(action.state).toBe("blocked");
      expect(action.code).toBe("blocked_by_gate");
    }
  });

  it("blocks an action whose capability is not switched on", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto", ["record"]),
      mode: "auto",
      candidates: [candidate()],
    });
    expect(plan.actions[0]!.state).toBe("blocked");
    expect(plan.actions[0]!.code).toBe("capability_off");
    expect(plan.actions[0]!.reason).toContain("callbacks");
  });

  it("retains a blocked action with its reason rather than dropping it", () => {
    // A planner that returns a filtered list teaches nobody anything.
    const plan = planActions({
      callId: CALL,
      gate: gate("auto", ["record"]),
      mode: "auto",
      candidates: [candidate()],
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.reason.length).toBeGreaterThan(0);
  });
});

describe("planActions - roles_inferred caps the run (decisions §4.7)", () => {
  it("drops an `auto` run to `suggest` and says why", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      rolesInferred: true,
      candidates: [candidate({ orgEnabledAuto: true, accuracyGateMet: true })],
    });
    expect(plan.effectiveMode).toBe("suggest");
    expect(plan.modeCapReason).toMatch(/who was speaking/);
    expect(plan.actions[0]!.state).toBe("pending_review");
  });

  it("does not RAISE a mode that was already lower", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("shadow", ["record"]),
      mode: "shadow",
      rolesInferred: true,
      candidates: [],
    });
    expect(plan.effectiveMode).toBe("shadow");
    expect(plan.modeCapReason).toBeNull();
  });
});

describe("planActions - supersession (§6)", () => {
  it("keeps a superseded intent as a RECORD rather than deleting it", () => {
    // An audit of "why did it book 17:00 when they first said 15:00" needs
    // both halves.
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({ intentIndex: 0, superseded: true, keyParts: { contact: "a" } }),
        candidate({ intentIndex: 1, keyParts: { contact: "b" } }),
      ],
    });
    expect(plan.actions[0]!.state).toBe("recorded");
    expect(plan.actions[0]!.code).toBe("superseded");
    expect(plan.actions[1]!.state).toBe("planned");
  });
});

describe("planActions - deduplication", () => {
  it("collapses two identical actions on the same call", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({ intentIndex: 0 }),
        candidate({ intentIndex: 1 }),
      ],
    });
    expect(plan.actions.filter((a) => a.state === "planned")).toHaveLength(1);
    const collapsed = plan.actions.find((a) => a.state === "recorded");
    expect(collapsed!.code).toBe("duplicate");
    expect(collapsed!.reason).toMatch(/twice/);
  });

  it("blocks an action that already exists from another call", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({
          tool: "book_slot",
          intentType: "book_appointment",
          keyParts: { slot: "2026-10-13T09:30:00Z" },
          subject: "2026-10-13T09:30:00Z",
          at: new Date("2026-10-13T09:30:00Z"),
          orgEnabledAuto: true,
          accuracyGateMet: true,
        }),
      ],
      existing: [
        {
          tool: "book_slot",
          idempotencyKey: "other:book_slot:book:x",
          active: true,
          subject: "2026-10-13T09:30:00Z",
          at: new Date("2026-10-13T09:30:00Z"),
        },
      ],
    });
    expect(plan.actions[0]!.state).toBe("blocked");
    expect(plan.actions[0]!.code).toBe("duplicate");
  });
});

describe("planActions - clarification and bands (§7.1, §8.3)", () => {
  it("sends an ambiguous resolution to review rather than guessing", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [candidate({ needsClarification: true, orgEnabledAuto: true, accuracyGateMet: true })],
    });
    expect(plan.actions[0]!.state).toBe("pending_review");
    expect(plan.actions[0]!.code).toBe("needs_clarification");
  });

  it("records, and does not propose, anything below the review threshold", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [candidate({ score: 0.2 })],
    });
    expect(plan.actions[0]!.state).toBe("recorded");
    expect(plan.actions[0]!.band).toBe("record");
  });

  it("proposes for review between the thresholds", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [candidate({ score: 0.7 })],
    });
    expect(plan.actions[0]!.state).toBe("pending_review");
  });

  it("honours an org's own thresholds", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      thresholds: { callback_request: { auto: 0.99, review: 0.9 } },
      candidates: [candidate({ score: 0.95 })],
    });
    expect(plan.actions[0]!.state).toBe("pending_review");
  });
});

describe("planActions - ordering and dependencies (§10)", () => {
  it("runs suppression first and a message last", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({
          intentType: "send_information",
          tool: "send_information",
          keyParts: { doc: "brochure" },
          intentIndex: 2,
        }),
        candidate({ intentIndex: 1 }),
        candidate({
          intentType: "do_not_contact",
          tool: "mark_do_not_contact",
          keyParts: {},
          intentIndex: 0,
        }),
      ],
    });
    expect(plan.actions.map((a) => a.tool)).toEqual([
      "mark_do_not_contact",
      "schedule_callback",
      "send_information",
    ]);
  });

  it("makes a message depend on the actions that precede it", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({
          intentType: "book_appointment",
          tool: "book_slot",
          keyParts: { slot: "2026-10-13T09:30:00Z" },
          orgEnabledAuto: true,
          accuracyGateMet: true,
          intentIndex: 0,
        }),
        candidate({
          intentType: "send_information",
          tool: "send_information",
          keyParts: { doc: "brochure" },
          intentIndex: 1,
        }),
      ],
    });
    const message = plan.actions.find((a) => a.tool === "send_information")!;
    const booking = plan.actions.find((a) => a.tool === "book_slot")!;
    expect(message.dependsOn).toContain(booking.idempotencyKey);
  });

  it("does not make a message depend on a blocked action", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({
          intentType: "book_appointment",
          tool: "book_slot",
          keyParts: { slot: "2026-10-13T09:30:00Z" },
          policy: { ok: false, code: "slot_busy", message: "That time is already taken." },
          intentIndex: 0,
        }),
        candidate({
          intentType: "send_information",
          tool: "send_information",
          keyParts: { doc: "brochure" },
          intentIndex: 1,
        }),
      ],
    });
    const message = plan.actions.find((a) => a.tool === "send_information")!;
    expect(message.dependsOn).toEqual([]);
  });

  it("keys every action, and never two the same", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({ intentIndex: 0, keyParts: { contact: "a" } }),
        candidate({ intentIndex: 1, keyParts: { contact: "b" } }),
      ],
    });
    const keys = plan.actions.map((a) => a.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe(idempotencyKey("schedule_callback", CALL, { contact: "a" }));
  });

  it("blocks - rather than throws on - an action it cannot key", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [candidate({ keyParts: { contact: null } })],
    });
    expect(plan.actions[0]!.state).toBe("blocked");
    expect(plan.actions[0]!.code).toBe("missing_detail");
    // The REASON is written for the reviewer, not lifted from the exception.
    // It used to be `idempotencyKey`'s own message - which names a key part
    // and means nothing to the person reading the queue - and `missing_detail`
    // did not exist, so it was filed under `no_slot_available` and sent people
    // looking for a diary clash that was not there.
    expect(plan.actions[0]!.reason).not.toMatch(/idempotency|key part/i);
    expect(plan.actions[0]!.reason.length).toBeGreaterThan(20);
  });

  it("names WHAT was missing, per tool, where it can", () => {
    // A generic "a detail was missing" is the one line a reviewer cannot act
    // on. These are the tools where the next step is obvious once the missing
    // thing is named.
    const forTool = (tool: AgentToolNameType, keyParts: Record<string, unknown>) =>
      planActions({
        callId: CALL,
        gate: gate("auto"),
        mode: "auto",
        candidates: [candidate({ tool, keyParts: keyParts as never })],
      }).actions[0]!.reason;

    expect(forTool("reschedule_slot", { resched: "x", event: null, slot: "y" })).toMatch(
      /no appointment open/i,
    );
    expect(forTool("cancel_slot", { cancel: "x", event: null })).toMatch(/no appointment open/i);
    expect(forTool("book_slot", { book: "x", slot: null })).toMatch(/nothing was free/i);
  });
});

describe("cascadeSkips (§10's partial failure)", () => {
  it("skips a message whose booking failed", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [
        candidate({
          intentType: "book_appointment",
          tool: "book_slot",
          keyParts: { slot: "2026-10-13T09:30:00Z" },
          orgEnabledAuto: true,
          accuracyGateMet: true,
          intentIndex: 0,
        }),
        candidate({
          intentType: "send_information",
          tool: "send_information",
          keyParts: { doc: "brochure" },
          intentIndex: 1,
        }),
      ],
    });
    const booking = plan.actions.find((a) => a.tool === "book_slot")!;
    const skipped = cascadeSkips(plan.actions, [booking.idempotencyKey]);
    expect(skipped.map((a) => a.tool)).toEqual(["send_information"]);
  });

  it("skips nothing when nothing failed", () => {
    const plan = planActions({
      callId: CALL,
      gate: gate("auto"),
      mode: "auto",
      candidates: [candidate()],
    });
    expect(cascadeSkips(plan.actions, [])).toEqual([]);
  });

  it("reaches a fixpoint over a chain", () => {
    const chain = [
      { idempotencyKey: "a", dependsOn: [] as string[] },
      { idempotencyKey: "b", dependsOn: ["a"] },
      { idempotencyKey: "c", dependsOn: ["b"] },
    ] as unknown as Parameters<typeof cascadeSkips>[0];
    expect(cascadeSkips(chain, ["a"]).map((x) => x.idempotencyKey)).toEqual(["b", "c"]);
  });
});

describe("compensationFor (§10)", () => {
  it("knows a booking can be cancelled", () => {
    expect(compensationFor("book_slot")).toBe("cancel_slot");
  });

  it("is honest that a sent message cannot be unsent", () => {
    // Which is the whole reason messages run last and default to needing a
    // person.
    expect(compensationFor("send_message")).toBeNull();
    expect(compensationFor("send_information")).toBeNull();
  });
});

describe("reviewSlaDeadline (§12, §18)", () => {
  const slaRules = {
    workingWindows: DEFAULT_BOOKING_RULES.workingWindows,
    closedDays: [] as string[],
    timeZone: ZONE,
  };

  it("counts four WORKING hours, not four wall-clock hours", () => {
    // 12:00 Friday + 4 working hours = 16:00 Friday.
    expect(wall(reviewSlaDeadline(ist("2026-10-09", 12), 4, slaRules))).toBe("2026-10-09 16:00");
  });

  it("carries the remainder into the next working day", () => {
    // 18:00 Friday: one hour left on Friday, three more from Saturday 10:00.
    expect(wall(reviewSlaDeadline(ist("2026-10-09", 18), 4, slaRules))).toBe("2026-10-10 13:00");
  });

  it("skips a non-working day", () => {
    // 18:00 Saturday with a Mon-Fri week: everything spills to Monday.
    const weekdaysOnly = {
      ...slaRules,
      workingWindows: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMinute: 10 * 60,
        endMinute: 19 * 60,
      })),
    };
    expect(wall(reviewSlaDeadline(ist("2026-10-10", 18), 4, weekdaysOnly))).toBe(
      "2026-10-12 14:00",
    );
  });

  it("skips a closed day", () => {
    // Friday 18:00 leaves one hour; Saturday the 10th is closed and Sunday is
    // not a working weekday at all, so the remaining three hours land on
    // Monday from 10:00.
    expect(
      wall(reviewSlaDeadline(ist("2026-10-09", 18), 4, { ...slaRules, closedDays: ["2026-10-10"] })),
    ).toBe("2026-10-12 13:00");
  });

  it("starts from the opening time for an item created overnight", () => {
    expect(wall(reviewSlaDeadline(ist("2026-10-09", 3), 4, slaRules))).toBe("2026-10-09 14:00");
  });

  it("is already due when an org has no working hours at all", () => {
    const created = ist("2026-10-09", 12);
    expect(reviewSlaDeadline(created, 4, { ...slaRules, workingWindows: [] })).toBe(created);
  });

  it("returns the creation instant for a zero-hour SLA", () => {
    const created = ist("2026-10-09", 12);
    expect(reviewSlaDeadline(created, 0, slaRules)).toBe(created);
  });
});

describe("the catalog and the policy layer agree", () => {
  it("has a capability for every intent that the gate can be asked about", () => {
    for (const spec of INTENT_CATALOG) {
      expect(AgentCapability.options).toContain(spec.capability);
    }
  });

  it("pins the policy version, which travels on every run", () => {
    expect(POLICY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
