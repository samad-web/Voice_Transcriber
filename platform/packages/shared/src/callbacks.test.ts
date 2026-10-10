import { describe, expect, it } from "vitest";

import {
  CALLBACK_RULES_VERSION,
  CALLBACK_TRANSITIONS,
  type CallbackPolicy,
  CallbackPolicyInput,
  CallbackStatus,
  DEFAULT_CALLBACK_POLICY,
  OPEN_CALLBACK_STATUSES,
  WEEKDAY_NAMES,
  applyVagueRule,
  autoCompletes,
  callbackMetrics,
  callbackSection,
  callbackToTask,
  canTransition,
  classifyCallback,
  clockToMinute,
  dueEscalations,
  escalationLadder,
  inQuietMinutes,
  isCallingDay,
  isMissed,
  isTerminalCallbackStatus,
  minuteToClock,
  minuteToWords,
  minutesToWords,
  nextCallbackRetryAt,
  placeInCallingHours,
  priorityScore,
  reminderSchedule,
  shouldDeliverReminder,
  shouldEscalate,
  spreadCluster,
} from "./callbacks";
import { instantToWallTime } from "./time";

const ZONE = "Asia/Kolkata";
/** 12:00 IST, Friday 9 October 2026 - the same fixture the resolver's tests use. */
const REFERENCE = new Date("2026-10-09T06:30:00.000Z");

function wall(instant: Date): string {
  return instantToWallTime(instant, ZONE).replace("T", " ");
}

function ctx(partial: Partial<Parameters<typeof classifyCallback>[1]> = {}) {
  return { reference: REFERENCE, timeZone: ZONE, ...partial };
}

function policy(overrides: Partial<CallbackPolicy> = {}): CallbackPolicy {
  return { ...DEFAULT_CALLBACK_POLICY, ...overrides };
}

describe("classifyCallback (§10A.1)", () => {
  it("THE ACCEPTANCE CRITERION: 'kal shaam 5 baje call karna' is an exact, committed 17:00 tomorrow", () => {
    // §17 M5a, verbatim: "a transcript saying 'kal shaam 5 baje call karna'
    // creates one callback in the right telecaller's list at the right time."
    const result = classifyCallback("kal shaam 5 baje call karna", ctx());
    expect(result.type).toBe("exact");
    expect(result.committed).toBe(true);
    expect(result.needsConfirmation).toBe(false);
    expect(wall(result.dueAt!)).toBe("2026-10-10 17:00");
  });

  it("reads an exact English time", () => {
    const result = classifyCallback("call me at 4:30 tomorrow", ctx());
    expect(result.type).toBe("exact");
    expect(wall(result.dueAt!)).toBe("2026-10-10 16:30");
  });

  it("reads a window as committed, due at its start", () => {
    const result = classifyCallback("shaam ko call karna", ctx());
    expect(result.type).toBe("window");
    expect(result.committed).toBe(true);
    expect(wall(result.dueAt!)).toBe("2026-10-09 16:00");
    expect(wall(result.windowStart!)).toBe("2026-10-09 16:00");
    expect(wall(result.windowEnd!)).toBe("2026-10-09 20:00");
  });

  it("reads 'after 5' as a window to the end of the calling day", () => {
    const result = classifyCallback("5 baje ke baad call karna", ctx());
    expect(result.type).toBe("window");
    expect(wall(result.dueAt!)).toBe("2026-10-09 17:00");
    expect(wall(result.windowEnd!)).toBe("2026-10-09 21:00");
  });

  it("reads 'between 2 and 4'", () => {
    const result = classifyCallback("between 2 and 4 please", ctx());
    expect(result.type).toBe("window");
    expect(wall(result.windowStart!)).toBe("2026-10-09 14:00");
    expect(wall(result.windowEnd!)).toBe("2026-10-09 16:00");
  });

  it("flags a day with no hour for confirmation, and uses the org's default time", () => {
    // "kal call karna" gives a day, not a time. The hour is business policy
    // (§10A.6 step 2), so the item exists, carries the org's default, and says
    // it needs confirming.
    const result = classifyCallback("kal call karna", ctx());
    expect(result.type).toBe("window");
    expect(result.needsConfirmation).toBe(true);
    expect(wall(result.dueAt!)).toBe("2026-10-10 11:00"); // §18: tomorrow = 11:00
    expect(result.reason).toMatch(/named a day but not a time/);
  });

  it("applies 'later' = +3 hours inside calling hours (§18)", () => {
    const result = classifyCallback("baad mein call karna", ctx());
    expect(result.type).toBe("vague");
    expect(result.committed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(wall(result.dueAt!)).toBe("2026-10-09 15:00");
  });

  it("falls to the next working day when +3 hours lands outside calling hours", () => {
    const evening = new Date("2026-10-09T14:30:00.000Z"); // 20:00 IST
    const result = classifyCallback("later", ctx({ reference: evening }));
    // 20:00 + 3h = 23:00, past the 21:00 cutoff -> Saturday 10:00.
    expect(wall(result.dueAt!)).toBe("2026-10-10 10:00");
  });

  it("marks a conditional request soft, and quotes the condition", () => {
    const result = classifyCallback("call me after I talk to my husband", ctx());
    expect(result.type).toBe("conditional");
    expect(result.committed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.condition).toMatch(/talk to my husband/);
  });

  it("marks a far-future request as far_future even when the day is exact", () => {
    // An exact day a month out is still something that must not sit in Overdue.
    const result = classifyCallback("after the 15th", ctx());
    expect(result.type).toBe("far_future");
    expect(wall(result.dueAt!)).toBe("2026-10-15 10:00");
  });

  it("reads 'kal' as TOMORROW for a callback, because the intent points forward", () => {
    // §7.1 says "kal" is ambiguous and must be settled from context. For a
    // callback request the context is the intent itself - there is no reading of
    // "call me kal" that means yesterday - so this is settled in code rather
    // than asked of the model.
    const result = classifyCallback("kal", ctx());
    expect(result.dueAt).not.toBeNull();
    expect(result.dueAt!.getTime()).toBeGreaterThan(REFERENCE.getTime());
    expect(result.needsConfirmation).toBe(true); // a day, not a time
  });

  it("treats an ambiguous day as vague and NOT committed when nothing settles it", () => {
    // An explicit `tense: null` asks for the honest reading. Two readings is a
    // question, not a commitment - but the callback still exists, because
    // losing it is the one unacceptable outcome (§20).
    const result = classifyCallback("kal", ctx({ tense: null }));
    expect(result.type).toBe("vague");
    expect(result.committed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.dueAt).not.toBeNull();
    expect(result.reason).toMatch(/more than one reading/);
  });

  it("IS NOT A CALLBACK when the customer asked to stop calling (§10A.1)", () => {
    for (const phrase of [
      "please stop calling me",
      "mujhe call mat karo",
      "do not call again",
      "remove me from your list",
    ]) {
      const result = classifyCallback(phrase, ctx());
      expect(result.isStopRequest).toBe(true);
      expect(result.dueAt).toBeNull();
      expect(result.committed).toBe(false);
    }
  });

  it("never returns a committed item without a due time", () => {
    for (const phrase of ["kal shaam 5 baje", "later", "sometime", "after diwali", "", "kal"]) {
      const result = classifyCallback(phrase, ctx());
      if (result.committed) expect(result.dueAt).not.toBeNull();
    }
  });

  it("keeps the resolver's own answer, so an audit can re-derive the decision", () => {
    const result = classifyCallback("kal shaam 5 baje call karna", ctx());
    expect(result.resolution.kind).toBe("exact");
    expect(result.resolution.matched).toContain("clock");
  });
});

describe("applyVagueRule (§10A.6 step 2)", () => {
  it("honours an org that changed the 'later' window", () => {
    const result = applyVagueRule("later", ctx({ policy: policy({ laterMinutes: 60 }) }));
    expect(wall(result.dueAt)).toBe("2026-10-09 13:00");
  });

  it("honours an org that opens later in the morning", () => {
    const evening = new Date("2026-10-09T16:00:00.000Z"); // 21:30 IST
    const result = applyVagueRule(
      "later",
      ctx({ reference: evening, policy: policy({ nextDayMinute: 11 * 60 }) }),
    );
    expect(wall(result.dueAt)).toBe("2026-10-10 11:00");
  });

  it("skips a non-calling day when falling through to the next one", () => {
    const saturdayEvening = new Date("2026-10-10T16:00:00.000Z"); // Sat 21:30 IST
    const result = applyVagueRule(
      "later",
      ctx({ reference: saturdayEvening, policy: policy({ callingWeekdays: [1, 2, 3, 4, 5] }) }),
    );
    // Saturday and Sunday are not calling days -> Monday.
    expect(wall(result.dueAt)).toBe("2026-10-12 10:00");
  });

  it("explains itself in words a telecaller can read", () => {
    expect(applyVagueRule("later", ctx()).reason).toMatch(/inside your calling hours/);
  });
});

describe("placeInCallingHours (§10A.3)", () => {
  it("leaves a time inside the window alone", () => {
    const inside = new Date("2026-10-09T11:30:00.000Z"); // 17:00 IST
    const result = placeInCallingHours(inside, DEFAULT_CALLBACK_POLICY, ZONE);
    expect(result.moved).toBe(false);
    expect(result.dueAt).toBe(inside);
    expect(result.reason).toBeNull();
  });

  it("MOVES FORWARD, never backward, for a request after hours", () => {
    // 22:00 becomes 09:00 the next morning, not 21:00 the same evening.
    // Ringing EARLIER than asked is the worse failure.
    const late = new Date("2026-10-09T16:30:00.000Z"); // 22:00 IST Friday
    const result = placeInCallingHours(late, DEFAULT_CALLBACK_POLICY, ZONE);
    expect(result.moved).toBe(true);
    expect(wall(result.dueAt)).toBe("2026-10-10 09:00");
    expect(result.reason).toMatch(/calling hours end/);
  });

  it("moves a too-early request to opening time the same day", () => {
    const early = new Date("2026-10-09T01:30:00.000Z"); // 07:00 IST
    const result = placeInCallingHours(early, DEFAULT_CALLBACK_POLICY, ZONE);
    expect(wall(result.dueAt)).toBe("2026-10-09 09:00");
    expect(result.reason).toMatch(/calling hours start/);
  });

  it("skips a day nobody rings on", () => {
    const sunday = new Date("2026-10-11T08:00:00.000Z"); // Sun 13:30 IST
    const result = placeInCallingHours(sunday, DEFAULT_CALLBACK_POLICY, ZONE);
    expect(result.moved).toBe(true);
    expect(wall(result.dueAt)).toBe("2026-10-12 09:00");
  });

  it("skips a holiday", () => {
    const saturday = new Date("2026-10-10T08:00:00.000Z"); // Sat 13:30 IST
    const result = placeInCallingHours(
      saturday,
      policy({ holidays: ["2026-10-10", "2026-10-12"] }),
      ZONE,
    );
    expect(wall(result.dueAt)).toBe("2026-10-13 09:00");
  });

  it("ALWAYS FLAGS a move, so nobody rings at an unagreed hour unknowingly", () => {
    const late = new Date("2026-10-09T16:30:00.000Z");
    expect(placeInCallingHours(late, DEFAULT_CALLBACK_POLICY, ZONE).reason).toBeTruthy();
  });

  it("does not loop forever when an org has no calling days", () => {
    const result = placeInCallingHours(
      new Date("2026-10-11T08:00:00.000Z"),
      policy({ callingWeekdays: [7], holidays: ["2026-10-11", "2026-10-18", "2026-10-25", "2026-11-01"] }),
      ZONE,
    );
    expect(result.dueAt).toBeInstanceOf(Date);
  });

  it("knows which days are calling days", () => {
    expect(isCallingDay("2026-10-09", DEFAULT_CALLBACK_POLICY)).toBe(true); // Friday
    expect(isCallingDay("2026-10-11", DEFAULT_CALLBACK_POLICY)).toBe(false); // Sunday
    expect(isCallingDay("2026-10-09", policy({ holidays: ["2026-10-09"] }))).toBe(false);
  });
});

describe("spreadCluster (§10A.3)", () => {
  const at = (minutes: number) => new Date(REFERENCE.getTime() + minutes * 60_000);

  it("NEVER moves a committed item", () => {
    const moves = spreadCluster(
      [
        { id: "a", dueAt: at(60), committed: true },
        { id: "b", dueAt: at(60), committed: true },
        { id: "c", dueAt: at(60), committed: true },
      ],
      DEFAULT_CALLBACK_POLICY,
    );
    expect(moves).toEqual([]);
  });

  it("spreads soft items around a committed one", () => {
    const moves = spreadCluster(
      [
        { id: "hard", dueAt: at(60), committed: true },
        { id: "soft1", dueAt: at(60), committed: false },
        { id: "soft2", dueAt: at(60), committed: false },
      ],
      DEFAULT_CALLBACK_POLICY,
    );
    expect(moves.map((m) => m.id)).toEqual(["soft1", "soft2"]);
    expect(moves[0]!.movedByMinutes).toBe(5);
    expect(moves[1]!.movedByMinutes).toBe(10);
  });

  it("leaves a soft item where it was rather than pushing it past tolerance", () => {
    // A soft item pushed an hour to make room has stopped being the thing the
    // business intended either.
    const crowd = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      dueAt: at(60),
      committed: false,
    }));
    const moves = spreadCluster(crowd, policy({ clusterToleranceMinutes: 10 }));
    // Only the first two can fit inside a 10-minute tolerance at 5-minute
    // spacing; the rest stay put rather than drifting away.
    expect(moves.length).toBeLessThanOrEqual(2);
  });

  it("is deterministic across runs for identical input", () => {
    const items = [
      { id: "b", dueAt: at(60), committed: false },
      { id: "a", dueAt: at(60), committed: false },
    ];
    expect(spreadCluster(items, DEFAULT_CALLBACK_POLICY)).toEqual(
      spreadCluster([...items].reverse(), DEFAULT_CALLBACK_POLICY),
    );
  });

  it("returns only the items that actually moved", () => {
    const moves = spreadCluster(
      [
        { id: "a", dueAt: at(0), committed: false },
        { id: "b", dueAt: at(60), committed: false },
      ],
      DEFAULT_CALLBACK_POLICY,
    );
    expect(moves).toEqual([]);
  });
});

describe("priorityScore (§10A.3)", () => {
  const base = {
    committed: false,
    type: "vague" as const,
    overdueMinutes: 0,
    attempts: 0,
    leadValueMinor: null,
    moneyAtRiskMinor: null,
    temperature: null,
    lateStage: false,
  };

  it("puts a time the customer gave above everything else", () => {
    const committed = priorityScore({ ...base, committed: true, type: "exact" });
    const hotRich = priorityScore({
      ...base,
      temperature: "hot",
      leadValueMinor: 1_000_000_00,
      lateStage: true,
    });
    expect(committed.score).toBeGreaterThan(hotRich.score);
  });

  it("stores its reasons (§10A.3)", () => {
    const result = priorityScore({ ...base, committed: true, moneyAtRiskMinor: 50_000_00 });
    expect(result.reasons.map((r) => r.factor)).toContain("the customer gave a time");
    expect(result.reasons.map((r) => r.factor)).toContain("money is riding on this call");
    expect(result.reasons.reduce((a, r) => a + r.points, 0)).toBe(result.score);
  });

  it("omits a factor that contributed nothing", () => {
    const result = priorityScore(base);
    expect(result.reasons.map((r) => r.factor)).not.toContain("a hot lead");
  });

  it("raises an item that has been attempted, so a hard-to-reach customer is not buried", () => {
    const fresh = priorityScore(base).score;
    expect(priorityScore({ ...base, attempts: 2 }).score).toBeGreaterThan(fresh);
  });

  it("caps the overdue bonus so last week cannot outrank the next ten minutes forever", () => {
    const aDay = priorityScore({ ...base, overdueMinutes: 24 * 60 }).score;
    const aWeek = priorityScore({ ...base, overdueMinutes: 7 * 24 * 60 }).score;
    expect(aWeek).toBe(aDay);
  });

  it("scales lead value logarithmically, not linearly", () => {
    // Compared as the FACTOR's own points, not as the total: the total carries
    // the other factors' signs and would make this assertion about arithmetic
    // on a negative base rather than about the scaling.
    const points = (minor: number) =>
      priorityScore({ ...base, leadValueMinor: minor }).reasons.find(
        (r) => r.factor === "the lead is worth something",
      )!.points;

    const oneLakh = points(100_000_00);
    const hundredLakh = points(10_000_000_00);
    expect(hundredLakh).toBeGreaterThan(oneLakh);
    // A hundred times the value is worth more, but nowhere near a hundred
    // times more - a linear term would make every other factor noise.
    expect(hundredLakh).toBeLessThan(oneLakh * 100);
  });

  it("caps the lead-value bonus so one enormous lead cannot dominate the list", () => {
    const huge = priorityScore({ ...base, leadValueMinor: 10_000_000_000_00 }).reasons.find(
      (r) => r.factor === "the lead is worth something",
    )!.points;
    expect(huge).toBe(20);
  });

  it("pushes a far-future item down", () => {
    expect(priorityScore({ ...base, type: "far_future" }).score).toBeLessThan(
      priorityScore(base).score,
    );
  });
});

describe("the lifecycle graph (§10A.2)", () => {
  it("covers every status", () => {
    expect(Object.keys(CALLBACK_TRANSITIONS).sort()).toEqual([...CallbackStatus.options].sort());
  });

  it("names three terminal states and no others", () => {
    const terminal = CallbackStatus.options.filter(isTerminalCallbackStatus).sort();
    expect(terminal).toEqual(["cancelled", "closed_unreachable", "completed"]);
  });

  it("only ever points at a real status", () => {
    for (const [, targets] of Object.entries(CALLBACK_TRANSITIONS)) {
      for (const target of targets) expect(CallbackStatus.options).toContain(target);
    }
  });

  it("treats a reassignment as a continuation, not an end", () => {
    // The same commitment with a different person's name on it.
    expect(canTransition("missed", "reassigned")).toBe(true);
    expect(canTransition("reassigned", "scheduled")).toBe(true);
    expect(isTerminalCallbackStatus("reassigned")).toBe(false);
  });

  it("refuses to resurrect a completed callback", () => {
    for (const to of CallbackStatus.options) {
      expect(canTransition("completed", to)).toBe(false);
      expect(canTransition("cancelled", to)).toBe(false);
    }
  });

  it("lists every open status, and no terminal one", () => {
    for (const status of OPEN_CALLBACK_STATUSES) {
      expect(isTerminalCallbackStatus(status)).toBe(false);
    }
  });
});

describe("reminderSchedule (§10A.4)", () => {
  const due = new Date("2026-10-09T11:30:00.000Z"); // 17:00 IST

  it("plans T-10, due and +5 by default", () => {
    const plan = reminderSchedule(due, DEFAULT_CALLBACK_POLICY, REFERENCE);
    expect(plan.map((p) => p.kind)).toEqual(["pre", "due", "nudge"]);
    expect(wall(plan[0]!.at)).toBe("2026-10-09 16:50");
    expect(wall(plan[1]!.at)).toBe("2026-10-09 17:00");
    expect(wall(plan[2]!.at)).toBe("2026-10-09 17:05");
  });

  it("SKIPS a pre-reminder that would land in the past", () => {
    // Otherwise the scheduler fires it immediately and the telecaller gets two
    // popups five minutes apart for one item.
    const createdLate = new Date(due.getTime() - 5 * 60_000);
    const plan = reminderSchedule(due, DEFAULT_CALLBACK_POLICY, createdLate);
    expect(plan.map((p) => p.kind)).toEqual(["due", "nudge"]);
  });

  it("always plans the due reminder, whatever the policy switches off", () => {
    const plan = reminderSchedule(
      due,
      policy({ preReminderMinutes: 0, nudgeMinutes: 0 }),
      REFERENCE,
    );
    expect(plan.map((p) => p.kind)).toEqual(["due"]);
  });

  it("carries the org's channels onto every reminder", () => {
    const plan = reminderSchedule(
      due,
      policy({ reminderChannels: ["in_app", "whatsapp"] }),
      REFERENCE,
    );
    for (const reminder of plan) expect(reminder.channels).toEqual(["in_app", "whatsapp"]);
  });
});

describe("shouldDeliverReminder (§10A.4)", () => {
  const reminderAt = new Date("2026-10-09T11:30:00.000Z"); // 17:00 IST
  const now = new Date("2026-10-09T11:31:00.000Z");

  it("delivers when it is due and the telecaller is free", () => {
    expect(
      shouldDeliverReminder(
        reminderAt,
        { now, onCall: false, doNotDisturb: false, timeZone: ZONE },
        DEFAULT_CALLBACK_POLICY,
      ),
    ).toEqual({ deliver: true, reason: "due" });
  });

  it("QUEUES the popup while the telecaller is on a call (§10A.4)", () => {
    expect(
      shouldDeliverReminder(
        reminderAt,
        { now, onCall: true, doNotDisturb: false, timeZone: ZONE },
        DEFAULT_CALLBACK_POLICY,
      ),
    ).toEqual({ deliver: false, reason: "on_call" });
  });

  it("holds during Do Not Disturb and during the org's quiet hours", () => {
    expect(
      shouldDeliverReminder(
        reminderAt,
        { now, onCall: false, doNotDisturb: true, timeZone: ZONE },
        DEFAULT_CALLBACK_POLICY,
      ).reason,
    ).toBe("quiet_hours");

    const nightReminder = new Date("2026-10-09T17:00:00.000Z"); // 22:30 IST
    expect(
      shouldDeliverReminder(
        nightReminder,
        {
          now: new Date("2026-10-09T17:01:00.000Z"),
          onCall: false,
          doNotDisturb: false,
          timeZone: ZONE,
        },
        DEFAULT_CALLBACK_POLICY,
      ).reason,
    ).toBe("quiet_hours");
  });

  it("does not deliver before its time", () => {
    expect(
      shouldDeliverReminder(
        reminderAt,
        {
          now: new Date(reminderAt.getTime() - 60_000),
          onCall: false,
          doNotDisturb: false,
          timeZone: ZONE,
        },
        DEFAULT_CALLBACK_POLICY,
      ).reason,
    ).toBe("not_yet");
  });

  it("drops a reminder nobody collected for half a day", () => {
    expect(
      shouldDeliverReminder(
        reminderAt,
        {
          now: new Date(reminderAt.getTime() + 13 * 3_600_000),
          onCall: false,
          doNotDisturb: false,
          timeZone: ZONE,
        },
        DEFAULT_CALLBACK_POLICY,
      ).reason,
    ).toBe("expired");
  });

  it("reads the quiet window across midnight", () => {
    expect(inQuietMinutes(new Date("2026-10-09T18:00:00.000Z"), ZONE, DEFAULT_CALLBACK_POLICY)).toBe(
      true,
    ); // 23:30 IST
    expect(inQuietMinutes(new Date("2026-10-09T06:30:00.000Z"), ZONE, DEFAULT_CALLBACK_POLICY)).toBe(
      false,
    ); // 12:00 IST
  });

  it("has no quiet window when the two bounds are equal", () => {
    expect(
      inQuietMinutes(new Date("2026-10-09T18:00:00.000Z"), ZONE, policy({ quietStartMinute: 540, quietEndMinute: 540 })),
    ).toBe(false);
  });
});

describe("isMissed (§10A.5)", () => {
  const due = new Date("2026-10-09T11:30:00.000Z"); // 17:00 IST
  const open = {
    status: "reminded" as const,
    dueAt: due,
    attempts: 0,
    lastAttemptAt: null,
    committed: true,
  };

  it("is not missed inside the grace period", () => {
    expect(isMissed(open, DEFAULT_CALLBACK_POLICY, new Date(due.getTime() + 14 * 60_000))).toBe(
      false,
    );
  });

  it("is missed after the grace period", () => {
    expect(isMissed(open, DEFAULT_CALLBACK_POLICY, new Date(due.getTime() + 16 * 60_000))).toBe(
      true,
    );
  });

  it("AN UNANSWERED ATTEMPT IS NOT A MISS (§10A.5)", () => {
    // A telecaller who rang and got no answer did their job. Escalating them
    // for it is how a floor learns the system is wrong about them.
    const tried = {
      ...open,
      attempts: 1,
      lastAttemptAt: new Date(due.getTime() + 2 * 60_000),
    };
    expect(isMissed(tried, DEFAULT_CALLBACK_POLICY, new Date(due.getTime() + 60 * 60_000))).toBe(
      false,
    );
  });

  it("ignores an attempt made BEFORE the callback was due", () => {
    const earlier = { ...open, attempts: 1, lastAttemptAt: new Date(due.getTime() - 3_600_000) };
    expect(isMissed(earlier, DEFAULT_CALLBACK_POLICY, new Date(due.getTime() + 20 * 60_000))).toBe(
      true,
    );
  });

  it("is never missed once terminal, or while a call is in progress", () => {
    const late = new Date(due.getTime() + 24 * 3_600_000);
    for (const status of ["completed", "cancelled", "closed_unreachable"] as const) {
      expect(isMissed({ ...open, status }, DEFAULT_CALLBACK_POLICY, late)).toBe(false);
    }
    expect(isMissed({ ...open, status: "in_progress" }, DEFAULT_CALLBACK_POLICY, late)).toBe(false);
  });

  it("honours a zero grace period", () => {
    expect(
      isMissed(open, policy({ graceMinutes: 0 }), new Date(due.getTime() + 1_000)),
    ).toBe(true);
  });
});

describe("the escalation ladder (§10A.5)", () => {
  const due = new Date("2026-10-09T11:30:00.000Z"); // 17:00 IST

  it("escalates only committed callbacks by default (§18)", () => {
    expect(shouldEscalate({ committed: true }, DEFAULT_CALLBACK_POLICY)).toBe(true);
    expect(shouldEscalate({ committed: false }, DEFAULT_CALLBACK_POLICY)).toBe(false);
    expect(shouldEscalate({ committed: false }, policy({ escalateCommittedOnly: false }))).toBe(
      true,
    );
  });

  it("builds §18's ladder: assignee, +15 manager, +60 owner digest, next day reassign", () => {
    const ladder = escalationLadder(due, DEFAULT_CALLBACK_POLICY);
    expect(ladder.map((l) => l.level)).toEqual([0, 1, 2, 3]);
    expect(wall(ladder[0]!.at)).toBe("2026-10-09 17:00");
    expect(wall(ladder[1]!.at)).toBe("2026-10-09 17:15");
    expect(wall(ladder[2]!.at)).toBe("2026-10-09 18:00");
    expect(wall(ladder[3]!.at)).toBe("2026-10-10 17:00");
    expect(ladder[1]!.recipients.map((r) => r.kind)).toContain("manager");
    expect(ladder[2]!.recipients.map((r) => r.kind)).toContain("owner");
    expect(ladder[2]!.channels).toContain("digest");
    expect(ladder[3]!.action).toBe("reassign");
  });

  it("is anchored on due_at, so sweep latency cannot slide the whole ladder", () => {
    const ladder = escalationLadder(due, DEFAULT_CALLBACK_POLICY);
    expect(ladder[1]!.at.getTime() - due.getTime()).toBe(15 * 60_000);
  });

  it("returns the levels that are due and not already sent", () => {
    const at17_20 = new Date(due.getTime() + 20 * 60_000);
    expect(dueEscalations(due, DEFAULT_CALLBACK_POLICY, at17_20, []).map((l) => l.level)).toEqual([
      0, 1,
    ]);
    expect(dueEscalations(due, DEFAULT_CALLBACK_POLICY, at17_20, [0]).map((l) => l.level)).toEqual([
      1,
    ]);
    expect(dueEscalations(due, DEFAULT_CALLBACK_POLICY, at17_20, [0, 1])).toEqual([]);
  });

  it("acknowledging one level does not silence the next (§10A.5)", () => {
    // A manager seeing it at +15 does not mean the owner should not learn at
    // +60 that it is still not done.
    const at18_05 = new Date(due.getTime() + 65 * 60_000);
    expect(dueEscalations(due, DEFAULT_CALLBACK_POLICY, at18_05, [0, 1]).map((l) => l.level)).toEqual(
      [2],
    );
  });

  it("supports a ladder aimed at a named seat rather than a person", () => {
    const seat = "11111111-1111-1111-1111-111111111111";
    const custom = policy({
      ladder: [
        {
          level: 0,
          afterMinutes: 30,
          recipients: [{ kind: "position", positionId: seat }],
          channels: ["in_app"],
          action: "notify",
        },
      ],
    });
    expect(escalationLadder(due, custom)[0]!.recipients[0]).toEqual({
      kind: "position",
      positionId: seat,
    });
  });
});

describe("retries (§10A.5)", () => {
  const lastAttempt = new Date("2026-10-09T06:30:00.000Z"); // 12:00 IST

  it("uses §18's intervals: 30 min, 2 h, next day", () => {
    expect(wall(nextCallbackRetryAt(1, lastAttempt, DEFAULT_CALLBACK_POLICY, ZONE)!)).toBe(
      "2026-10-09 12:30",
    );
    expect(wall(nextCallbackRetryAt(2, lastAttempt, DEFAULT_CALLBACK_POLICY, ZONE)!)).toBe(
      "2026-10-09 14:00",
    );
  });

  it("gives up after the maximum number of attempts", () => {
    expect(nextCallbackRetryAt(3, lastAttempt, DEFAULT_CALLBACK_POLICY, ZONE)).toBeNull();
    expect(nextCallbackRetryAt(4, lastAttempt, DEFAULT_CALLBACK_POLICY, ZONE)).toBeNull();
  });

  it("keeps a retry inside calling hours", () => {
    const evening = new Date("2026-10-09T15:00:00.000Z"); // 20:30 IST
    // +30 min would be 21:00, the cutoff - so it moves to the next morning.
    expect(wall(nextCallbackRetryAt(1, evening, DEFAULT_CALLBACK_POLICY, ZONE)!)).toBe("2026-10-10 09:00");
  });

  it("NAMES but never sends the unreachable template (decisions §4.6)", () => {
    // This platform's standing rule: nothing automated reaches a customer
    // without a person saying yes. The fallback queues a T2 action.
    expect(DEFAULT_CALLBACK_POLICY.unreachableTemplate).toBeNull();
  });
});

describe("autoCompletes (§10A.2)", () => {
  const due = new Date("2026-10-09T11:30:00.000Z"); // 17:00 IST
  const callback = { dueAt: due, windowStart: null, windowEnd: null };

  it("completes on a connected call of at least 20 seconds near the due time", () => {
    expect(
      autoCompletes(
        { startedAt: new Date(due.getTime() + 10 * 60_000), durationSeconds: 45, connected: true },
        callback,
        DEFAULT_CALLBACK_POLICY,
      ),
    ).toBe(true);
  });

  it("does not complete on a ring-out", () => {
    expect(
      autoCompletes(
        { startedAt: due, durationSeconds: 45, connected: false },
        callback,
        DEFAULT_CALLBACK_POLICY,
      ),
    ).toBe(false);
    expect(
      autoCompletes(
        { startedAt: due, durationSeconds: 8, connected: true },
        callback,
        DEFAULT_CALLBACK_POLICY,
      ),
    ).toBe(false);
  });

  it("is generous about the window, so a late ring still counts", () => {
    // A strict window leaves the item open, escalates it, and teaches
    // everybody the list lies.
    expect(
      autoCompletes(
        { startedAt: new Date(due.getTime() + 40 * 60_000), durationSeconds: 60, connected: true },
        callback,
        DEFAULT_CALLBACK_POLICY,
      ),
    ).toBe(true);
  });

  it("does not complete on a call hours away from the window", () => {
    expect(
      autoCompletes(
        { startedAt: new Date(due.getTime() + 5 * 3_600_000), durationSeconds: 60, connected: true },
        callback,
        DEFAULT_CALLBACK_POLICY,
      ),
    ).toBe(false);
  });

  it("measures from the window's edges when there is one", () => {
    const windowed = {
      dueAt: due,
      windowStart: due,
      windowEnd: new Date(due.getTime() + 4 * 3_600_000),
    };
    expect(
      autoCompletes(
        { startedAt: new Date(due.getTime() + 4 * 3_600_000), durationSeconds: 60, connected: true },
        windowed,
        DEFAULT_CALLBACK_POLICY,
      ),
    ).toBe(true);
  });
});

describe("callbackToTask (§10A.7)", () => {
  const callback = {
    contactName: "Ramesh Kumar",
    contactPhone: "+919876543210",
    requestedText: "kal shaam 5 baje call karna",
    dueAt: new Date("2026-10-10T11:30:00.000Z"),
    committed: true,
    attempts: 1,
    notes: "Wants the premium plan price.",
  };

  it("keeps the time the customer asked for", () => {
    // §20: no commitment is silently lost, including when the feature is
    // switched off.
    expect(callbackToTask(callback).dueAt).toBe(callback.dueAt);
  });

  it("keeps the customer's own words, the attempts and the notes", () => {
    const task = callbackToTask(callback);
    expect(task.title).toBe("Call Ramesh Kumar back");
    expect(task.notes).toContain("kal shaam 5 baje call karna");
    expect(task.notes).toContain("Already tried 1 time.");
    expect(task.notes).toContain("Wants the premium plan price.");
    expect(task.notes).toMatch(/switched off/);
  });

  it("keeps a committed callback at high priority", () => {
    expect(callbackToTask(callback).priority).toBe("high");
    expect(callbackToTask({ ...callback, committed: false }).priority).toBe("normal");
  });

  it("falls back to the phone number, then to a generic phrase", () => {
    expect(callbackToTask({ ...callback, contactName: null }).title).toBe(
      "Call +919876543210 back",
    );
    expect(
      callbackToTask({ ...callback, contactName: null, contactPhone: null }).title,
    ).toBe("Call this customer back");
  });
});

describe("callbackSection (§10A.3)", () => {
  const now = new Date("2026-10-09T11:30:00.000Z"); // 17:00 IST

  it("sorts an item into the section a person would expect", () => {
    const section = (offsetMinutes: number) =>
      callbackSection({ dueAt: new Date(now.getTime() + offsetMinutes * 60_000) }, now, ZONE);

    expect(section(-60)).toBe("overdue");
    expect(section(-20)).toBe("overdue");
    // Inside grace, and just ahead: both are "the one in my hand".
    expect(section(-10)).toBe("due_now");
    expect(section(0)).toBe("due_now");
    expect(section(8)).toBe("due_now");
    expect(section(60)).toBe("today");
    expect(section(24 * 60)).toBe("later");
  });

  it("treats the grace period as not-yet-overdue", () => {
    const section = callbackSection(
      { dueAt: new Date(now.getTime() - 14 * 60_000) },
      now,
      ZONE,
    );
    expect(section).toBe("due_now");
  });
});

describe("CallbackPolicyInput", () => {
  const valid = { ...DEFAULT_CALLBACK_POLICY, reapplyToOpen: false };

  it("accepts the defaults", () => {
    expect(CallbackPolicyInput.safeParse(valid).success).toBe(true);
  });

  it("refuses calling hours that end before they start", () => {
    expect(
      CallbackPolicyInput.safeParse({ ...valid, callingStartMinute: 1200, callingEndMinute: 540 })
        .success,
    ).toBe(false);
  });

  it("refuses a ladder that goes backwards", () => {
    const backwards = {
      ...valid,
      ladder: [
        { level: 0, afterMinutes: 60, recipients: [{ kind: "assignee" }], channels: ["in_app"], action: "notify" },
        { level: 1, afterMinutes: 15, recipients: [{ kind: "manager" }], channels: ["in_app"], action: "notify" },
      ],
    };
    expect(CallbackPolicyInput.safeParse(backwards).success).toBe(false);
  });

  it("refuses a ladder with a gap in its level numbers", () => {
    const gappy = {
      ...valid,
      ladder: [
        { level: 0, afterMinutes: 0, recipients: [{ kind: "assignee" }], channels: ["in_app"], action: "notify" },
        { level: 2, afterMinutes: 60, recipients: [{ kind: "owner" }], channels: ["in_app"], action: "notify" },
      ],
    };
    expect(CallbackPolicyInput.safeParse(gappy).success).toBe(false);
  });

  it("refuses retry intervals that get shorter", () => {
    expect(
      CallbackPolicyInput.safeParse({ ...valid, retryIntervalsMinutes: [120, 30] }).success,
    ).toBe(false);
  });

  it("HAS NO DEFAULTS, so a PATCH cannot silently reset a field", () => {
    // The partial/default trap: `Input.partial()` keeps a `.default()`, so an
    // omitted `graceMinutes` would come back as 15 and overwrite the org's own.
    const { graceMinutes: _omitted, ...withoutGrace } = valid;
    expect(CallbackPolicyInput.safeParse(withoutGrace).success).toBe(false);
  });
});

describe("callbackMetrics (§10A.8)", () => {
  it("computes the rates from one place", () => {
    const metrics = callbackMetrics({
      committedTotal: 100,
      committedOnTime: 82,
      completedTotal: 90,
      missedTotal: 10,
      totalDelayMinutes: 450,
      delaySamples: 90,
      escalations: 7,
      retries: 25,
      retriedTotal: 20,
      retriedCompleted: 13,
      convertedAfterCallback: 18,
    });
    expect(metrics.adherenceRate).toBeCloseTo(0.82);
    expect(metrics.missedRate).toBeCloseTo(0.1);
    expect(metrics.averageDelayMinutes).toBeCloseTo(5);
    expect(metrics.retrySuccessRate).toBeCloseTo(0.65);
    expect(metrics.conversionRate).toBeCloseTo(0.2);
  });

  it("returns NULL and not zero for a rate with no denominator", () => {
    // A floor with no committed callbacks has no adherence rate. Showing 0 %
    // would read as a floor that missed everything - the one number an owner
    // would act on hardest and the one that would be most wrong.
    const metrics = callbackMetrics({
      committedTotal: 0,
      committedOnTime: 0,
      completedTotal: 0,
      missedTotal: 0,
      totalDelayMinutes: 0,
      delaySamples: 0,
      escalations: 0,
      retries: 0,
      retriedTotal: 0,
      retriedCompleted: 0,
      convertedAfterCallback: 0,
    });
    expect(metrics.adherenceRate).toBeNull();
    expect(metrics.missedRate).toBeNull();
    expect(metrics.averageDelayMinutes).toBeNull();
    expect(metrics.conversionRate).toBeNull();
  });
});

describe("version", () => {
  it("is recorded with every stored policy decision", () => {
    expect(CALLBACK_RULES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("the wizard's clock fields", () => {
  it("round-trips every minute of the day", () => {
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      expect(clockToMinute(minuteToClock(minute))).toBe(minute);
    }
  });

  it("clamps the one minute a time input cannot express", () => {
    // `callingEndMinute` may legally be 1440 (`max(24 * 60)`), and
    // `<input type="time">` has no 24:00. 23:59 is the honest nearest.
    expect(minuteToClock(24 * 60)).toBe("23:59");
    expect(minuteToClock(-5)).toBe("00:00");
  });

  it("accepts 24:00 from a caller but nothing past it", () => {
    expect(clockToMinute("24:00")).toBe(24 * 60);
    expect(clockToMinute("24:01")).toBeNull();
    expect(clockToMinute("25:00")).toBeNull();
    expect(clockToMinute("09:60")).toBeNull();
    expect(clockToMinute("nine")).toBeNull();
    expect(clockToMinute("")).toBeNull();
  });

  it("accepts a single-digit hour, which is what some browsers send", () => {
    expect(clockToMinute("9:05")).toBe(545);
  });

  it("says a time the way a person reads it", () => {
    expect(minuteToWords(0)).toBe("12 am");
    expect(minuteToWords(9 * 60)).toBe("9 am");
    expect(minuteToWords(12 * 60)).toBe("12 pm");
    expect(minuteToWords(21 * 60)).toBe("9 pm");
    expect(minuteToWords(13 * 60 + 30)).toBe("1:30 pm");
    expect(minuteToWords(24 * 60)).toBe("midnight");
  });

  it("says a duration the way a person checks it", () => {
    // 1440 is the number an owner has to recognise as "tomorrow" in the retry
    // ladder, and the one they cannot read as minutes.
    expect(minutesToWords(30)).toBe("30 min");
    expect(minutesToWords(60)).toBe("1 hour");
    expect(minutesToWords(180)).toBe("3 hours");
    expect(minutesToWords(1440)).toBe("1 day");
    expect(minutesToWords(2880)).toBe("2 days");
    expect(minutesToWords(90)).toBe("1 h 30 min");
  });

  it("names every ISO weekday, because 1 is Monday and not Sunday", () => {
    expect(WEEKDAY_NAMES[1]).toBe("Monday");
    expect(WEEKDAY_NAMES[7]).toBe("Sunday");
    expect(Object.keys(WEEKDAY_NAMES)).toHaveLength(7);
  });
});
