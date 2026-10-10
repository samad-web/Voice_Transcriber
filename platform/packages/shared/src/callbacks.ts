import { z } from "zod";
import { dayKeyIn, shiftDateKey, wallTimeToInstant, zonedParts } from "./time";
import {
  type ResolverContext,
  type TimeResolution,
  bestInstant,
  nextWorkingDay,
  resolveTimePhrase,
} from "./time-phrases";

/**
 * "CALL ME AT 5" MUST REACH THE RIGHT PERSON AT 5
 * (Build docs/transcript-agent-build-plan §10A).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §20: "no customer commitment is silently lost, **including when the feature
 * is turned off**."
 *
 * Everything here follows from that sentence. A callback is not a reminder that
 * fires and is forgotten - it is a COMMITMENT a business made to a person on a
 * recorded call, and the failure modes are all silent:
 *
 *   · resolved to the wrong day, and nobody rings;
 *   · scheduled at 02:00, outside every calling-hours rule, and dropped;
 *   · assigned to somebody on leave, and nobody notices for a week;
 *   · reminded by a browser timer, and lost when the tab closed;
 *   · missed, and escalated to a manager who was also the person who missed it;
 *   · open when the owner switched the feature off, and deleted with it.
 *
 * Each of those has a rule below and a test beside it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  EVERY FUNCTION IS PURE AND TAKES ITS INSTANT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * No clock, no database. The reminder schedule, the escalation ladder and the
 * missed-detection boundary are the whole behaviour, and a boundary you cannot
 * test at `due + 14:59` and `due + 15:01` is a boundary nobody tests.
 */

export const CALLBACK_RULES_VERSION = "1.0.0";

// ════════════════════════════════════════════════════════════════════════════
//  §10A.1 - classification
// ════════════════════════════════════════════════════════════════════════════

/**
 * §10A.1's five kinds. The distinction that MATTERS is `committed`, not the
 * type: §10A.5 escalates committed callbacks and only reminds about the rest,
 * because waking a manager about "call me sometime" is how a business learns to
 * ignore this alert.
 */
export const CallbackType = z.enum(["exact", "window", "vague", "far_future", "conditional"]);
export type CallbackType = z.infer<typeof CallbackType>;

export const CALLBACK_TYPE_LABELS: Record<CallbackType, string> = {
  exact: "At a set time",
  window: "In a window",
  vague: "No time given",
  far_future: "Later on",
  conditional: "Depends on something",
};

/**
 * §10A.1: a far-future request is one resolved beyond this horizon. It stays in
 * "Later" and surfaces as due on its own day.
 *
 * Three days rather than "next month": the behaviour that matters is the
 * PARKING - a callback that is not this week should not sit in Overdue colouring
 * somebody's day red - and "after the 15th" said on the 9th deserves that as
 * much as "next month" does.
 */
export const FAR_FUTURE_DAYS = 3;

/**
 * Words that make a request CONDITIONAL on something outside the call.
 *
 * §10A.1: "call me after I talk to my husband" is soft - `committed = false`,
 * a default delay, and the condition quoted on the item so the telecaller
 * opens the call knowing what they are waiting for.
 *
 * Checked on the raw phrase and not on the resolution, because the resolver
 * has no opinion about conditions: "after I talk to my husband" resolves to
 * `unresolved`, and so does "sometime" - and those two need different handling.
 */
const CONDITIONAL_MARKERS =
  /\b(?:if|agar|jab|once|after\s+(?:i|we|my|mere|meri)|baat\s+kar(?:ke|ne)|poochh?\s*kar|discuss\s+kar|confirm\s+kar|salary|paisa\s+aa|decide\s+kar|soch\s*kar)\b/i;

/** §10A.1: "a request to stop calling is NOT a callback." */
const STOP_MARKERS =
  /\b(?:do\s*not\s*call|dont\s*call|don't\s*call|stop\s*calling|mat\s*karo|phone\s*mat|call\s*mat|unsubscribe|remove\s*me)\b/i;

export interface CallbackClassification {
  type: CallbackType;
  /** §10A.1: did the CUSTOMER give a time? Drives escalation. */
  committed: boolean;
  /** The instant the item becomes due. Null when nothing could be resolved. */
  dueAt: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  /** §10A.1: a vague or conditional request is flagged for confirmation. */
  needsConfirmation: boolean;
  /** The condition, quoted, for the telecaller to read. */
  condition: string | null;
  /** Why this classification - stored, and shown in the review queue. */
  reason: string;
  /** The resolver's own answer, kept so an audit can re-derive this. */
  resolution: TimeResolution;
  /** True when the phrase was a request to STOP, which is not a callback. */
  isStopRequest: boolean;
}

/**
 * §10A.1, as a single function.
 *
 * ── THE RESOLVER DECIDES THE TIME; THIS DECIDES THE KIND ────────────────────
 *
 * `resolveTimePhrase` is the only thing that reads the words for a time, and it
 * is called with `tense: "future"` because a callback request cannot be about
 * yesterday - see `INTENT_CATALOG`'s `timeDirection`. This function then reads
 * the SHAPE of that answer:
 *
 *   exact       -> `exact`, committed
 *   window      -> `window`, committed (a span the customer named is a time)
 *   ambiguous   -> `vague`, NOT committed. Two readings is not a commitment;
 *                  it is a question, and §10A.1's `needs_confirmation` is how
 *                  it gets asked.
 *   unresolved  -> `conditional` if the phrase names a condition, else `vague`
 *
 * and then overrides to `far_future` for anything beyond the horizon, because
 * "after the 15th" is an exact day AND something that must not sit in Overdue
 * for six days.
 */
export function classifyCallback(
  phrase: string,
  ctx: ResolverContext & { policy?: CallbackPolicy },
): CallbackClassification {
  const policy = ctx.policy ?? DEFAULT_CALLBACK_POLICY;

  if (STOP_MARKERS.test(phrase)) {
    return {
      type: "vague",
      committed: false,
      dueAt: null,
      windowStart: null,
      windowEnd: null,
      needsConfirmation: false,
      condition: null,
      reason: "this is a request to stop calling, not a callback",
      resolution: { kind: "unresolved", reason: "stop request", matched: [] },
      isStopRequest: true,
    };
  }

  // `timeDirection: "future"` from the intent catalog, applied HERE rather than
  // inside the resolver - which must stay honest about "kal" for every other
  // caller (a `complaint` may be about yesterday).
  //
  // `undefined` means "you decide", and a callback request decides FUTURE: there
  // is no reading of "call me kal" that means yesterday. An explicit `null`
  // means "stay honest", which is how the ambiguous path below is reachable at
  // all - so the two are deliberately not collapsed with `??`.
  const tense = ctx.tense === undefined ? "future" : ctx.tense;
  const resolution = resolveTimePhrase(phrase, { ...ctx, tense });
  const conditional = CONDITIONAL_MARKERS.test(phrase);

  const base = ((): Omit<CallbackClassification, "isStopRequest" | "resolution"> => {
    if (resolution.kind === "exact") {
      return {
        type: "exact",
        committed: true,
        dueAt: new Date(resolution.at),
        windowStart: null,
        windowEnd: null,
        needsConfirmation: false,
        condition: null,
        reason: "the customer named a time",
      };
    }

    if (resolution.kind === "window") {
      // A day with no hour ("kal call karna") resolves as a whole-day window.
      // That is NOT a time the customer gave, so it is not a commitment to an
      // hour - §10A.6's vague rules supply the hour and the item is flagged.
      const wholeDay = resolution.minuteOfDay === null && isWholeDayWindow(resolution, ctx);
      const due = bestInstant(resolution)!;
      if (wholeDay) {
        const settled = applyVagueRule(phrase, { ...ctx, policy }, resolution);
        return {
          type: "window",
          committed: true,
          dueAt: settled.dueAt,
          windowStart: new Date(resolution.start),
          windowEnd: new Date(resolution.end),
          needsConfirmation: true,
          condition: null,
          reason: `the customer named a day but not a time; ${settled.reason}`,
        };
      }
      return {
        type: "window",
        committed: true,
        dueAt: due,
        windowStart: new Date(resolution.start),
        windowEnd: new Date(resolution.end),
        needsConfirmation: false,
        condition: null,
        reason: "the customer named a window",
      };
    }

    if (resolution.kind === "ambiguous") {
      // §7.1: an ambiguous result creates a clarification, never a guess. The
      // callback still EXISTS - losing it would be the one unacceptable
      // outcome - but with the org's default time and a flag on it.
      const settled = applyVagueRule(phrase, { ...ctx, policy }, resolution);
      return {
        type: "vague",
        committed: false,
        dueAt: settled.dueAt,
        windowStart: null,
        windowEnd: null,
        needsConfirmation: true,
        condition: null,
        reason: `more than one reading of the time (${resolution.reason}); ${settled.reason}`,
      };
    }

    const settled = applyVagueRule(phrase, { ...ctx, policy }, resolution);
    if (conditional) {
      return {
        type: "conditional",
        committed: false,
        dueAt: settled.dueAt,
        windowStart: null,
        windowEnd: null,
        needsConfirmation: true,
        condition: phrase.trim().slice(0, 300),
        reason: `the customer is waiting on something; ${settled.reason}`,
      };
    }
    return {
      type: "vague",
      committed: false,
      dueAt: settled.dueAt,
      windowStart: null,
      windowEnd: null,
      needsConfirmation: true,
      condition: null,
      reason: `no time given; ${settled.reason}`,
    };
  })();

  // §10A.1's `far_future`, applied LAST so it can override `exact`. An exact
  // day a month out is still a thing that must not sit in Overdue.
  const horizon = ctx.reference.getTime() + FAR_FUTURE_DAYS * 86_400_000;
  const type =
    base.dueAt && base.dueAt.getTime() > horizon && base.type !== "conditional"
      ? "far_future"
      : base.type;

  return { ...base, type, resolution, isStopRequest: false };
}

function isWholeDayWindow(
  resolution: Extract<TimeResolution, { kind: "window" }>,
  ctx: ResolverContext,
): boolean {
  const start = zonedParts(resolution.start, ctx.timeZone);
  const end = zonedParts(resolution.end, ctx.timeZone);
  if (!start || !end) return false;
  const startMinute = start.hour * 60 + start.minute;
  const endMinute = end.hour * 60 + end.minute;
  return (
    startMinute === (ctx.dayStartMinute ?? 9 * 60) && endMinute === (ctx.dayEndMinute ?? 21 * 60)
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.6 - the owner's policy
// ════════════════════════════════════════════════════════════════════════════

export const EscalationRecipient = z.discriminatedUnion("kind", [
  /** Up the org chart's reporting line from the assignee. §10A.5. */
  z.object({ kind: z.literal("manager") }),
  /** Every member holding the `owner` persona. */
  z.object({ kind: z.literal("owner") }),
  /** A named seat in the org chart. Survives the person leaving it. */
  z.object({ kind: z.literal("position"), positionId: z.string().uuid() }),
  /** A named person. */
  z.object({ kind: z.literal("user"), userId: z.string().uuid() }),
  /** The assignee again, louder. Level 0 and 1's first recipient. */
  z.object({ kind: z.literal("assignee") }),
]);
export type EscalationRecipient = z.infer<typeof EscalationRecipient>;

export const AlertChannel = z.enum(["in_app", "push", "whatsapp", "email", "digest"]);
export type AlertChannel = z.infer<typeof AlertChannel>;

export const EscalationLevelConfig = z.object({
  level: z.number().int().min(0).max(5),
  /** Minutes after `due_at`. Level 0 is 0. */
  afterMinutes: z.number().int().min(0).max(14 * 24 * 60),
  recipients: z.array(EscalationRecipient).min(1).max(5),
  channels: z.array(AlertChannel).min(1),
  /**
   * §10A.5: level 3's "auto-reassign to another telecaller, or raise priority
   * and keep in Overdue, per the org rule".
   */
  action: z.enum(["notify", "reassign", "raise_priority"]),
});
export type EscalationLevelConfig = z.infer<typeof EscalationLevelConfig>;

export const CallbackPolicy = z.object({
  // ── §10A.6 step 2: vague-request defaults ───────────────────────────────
  /** "later" = this many minutes on, inside calling hours. §18: 3 hours. */
  laterMinutes: z.number().int().min(15).max(24 * 60),
  /** When "later" cannot fit today: next working day at this minute. 10:00. */
  nextDayMinute: z.number().int().min(0).max(24 * 60 - 1),
  /** "tomorrow" with no time. §18: 11:00. */
  tomorrowMinute: z.number().int().min(0).max(24 * 60 - 1),
  /** "next week" with no day. §18: Monday 10:00 - the day comes from the resolver. */
  weekMinute: z.number().int().min(0).max(24 * 60 - 1),
  /** A conditional request's default delay. */
  conditionalMinutes: z.number().int().min(60).max(14 * 24 * 60),

  // ── §10A.6 step 3: calling hours ────────────────────────────────────────
  callingStartMinute: z.number().int().min(0).max(24 * 60 - 1),
  callingEndMinute: z.number().int().min(1).max(24 * 60),
  /** ISO weekdays (1 = Monday) on which this business rings people. */
  callingWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  /** `YYYY-MM-DD`. Nobody is rung on these. */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(400),
  /** 0 = unlimited. §10A.6 step 3. */
  maxPerTelecallerPerDay: z.number().int().min(0).max(500),
  /** §10A.3: how many calls to the same customer in a day. 0 = unlimited. */
  maxPerCustomerPerDay: z.number().int().min(0).max(20),
  /** §10A.3: spread soft items this many minutes apart inside their tolerance. */
  clusterSpacingMinutes: z.number().int().min(1).max(120),
  /** How far a soft item may be moved to de-cluster it. */
  clusterToleranceMinutes: z.number().int().min(0).max(240),

  // ── §10A.6 step 4: reminders ────────────────────────────────────────────
  preReminderMinutes: z.number().int().min(0).max(240),
  nudgeMinutes: z.number().int().min(0).max(240),
  reminderChannels: z.array(AlertChannel).min(1),
  sound: z.boolean(),
  snoozeOptionsMinutes: z.array(z.number().int().min(1).max(24 * 60)).min(1).max(8),
  /** Which of the above a telecaller may change for themselves. */
  personalOverrides: z.array(z.enum(["sound", "channels", "preReminderMinutes"])),

  // ── §10A.6 step 5: missed and escalation ────────────────────────────────
  graceMinutes: z.number().int().min(0).max(24 * 60),
  /** §18: committed only. */
  escalateCommittedOnly: z.boolean(),
  ladder: z.array(EscalationLevelConfig).max(6),
  /** Quiet hours for the ALERTS, not for the callback. §10A.4. */
  quietStartMinute: z.number().int().min(0).max(24 * 60 - 1).nullable(),
  quietEndMinute: z.number().int().min(0).max(24 * 60 - 1).nullable(),
  /** The hour the owner's missed-callback digest goes out. */
  digestMinute: z.number().int().min(0).max(24 * 60 - 1),

  // ── §10A.6 step 6: retries ──────────────────────────────────────────────
  retryIntervalsMinutes: z.array(z.number().int().min(5).max(14 * 24 * 60)).min(1).max(6),
  maxAttempts: z.number().int().min(1).max(10),
  /**
   * §10A.5's "we tried to reach you" template.
   *
   * NAMED, never sent by this module. See `TRANSCRIPT_AGENT_DECISIONS.md` §4.6:
   * the `messaging` capability is off by default and its sends are T2, so the
   * fallback QUEUES a pending action for a person. An owner who wants it
   * automatic throws the per-intent switch, which is itself gated on §13.3's
   * measured accuracy.
   */
  unreachableTemplate: z.string().trim().max(120).nullable(),

  // ── §10A.6 step 7: reassignment ─────────────────────────────────────────
  reassignOnAbsence: z.boolean(),
  reassignAfterMisses: z.number().int().min(0).max(10),
  reassignStrategy: z.enum(["round_robin", "least_loaded", "manager"]),

  // ── §10A.6 step 8: auto-complete ────────────────────────────────────────
  /** §18: a connected call of 20 seconds or more inside the window. */
  autoCompleteSeconds: z.number().int().min(1).max(600),
  /** How far either side of the window a call still counts as this callback. */
  autoCompleteWindowMinutes: z.number().int().min(0).max(24 * 60),

  /** §10A.3's optional calendar block for committed exact-time callbacks. */
  blockCalendarForExact: z.boolean(),
});
export type CallbackPolicy = z.infer<typeof CallbackPolicy>;

/**
 * §18's defaults, every one of them.
 *
 * A single frozen object rather than per-field defaults on the schema, and that
 * is deliberate: `CallbackPolicy.partial()` would KEEP a `.default()`, so a
 * PATCH that omitted `graceMinutes` would silently reset it to 15 - the
 * partial/default trap this codebase already has one live instance of. The
 * schema requires every field; the defaults live here and are spread by the
 * caller when it creates a policy, never when it updates one.
 */
const DEFAULT_POLICY_VALUES: CallbackPolicy = {
  laterMinutes: 180,
  nextDayMinute: 10 * 60,
  tomorrowMinute: 11 * 60,
  weekMinute: 10 * 60,
  conditionalMinutes: 2 * 24 * 60,

  callingStartMinute: 9 * 60,
  callingEndMinute: 21 * 60,
  callingWeekdays: [1, 2, 3, 4, 5, 6],
  holidays: [],
  maxPerTelecallerPerDay: 0,
  maxPerCustomerPerDay: 3,
  clusterSpacingMinutes: 5,
  clusterToleranceMinutes: 60,

  preReminderMinutes: 10,
  nudgeMinutes: 5,
  reminderChannels: ["in_app", "push"],
  sound: true,
  snoozeOptionsMinutes: [5, 15, 30],
  personalOverrides: ["sound"],

  graceMinutes: 15,
  escalateCommittedOnly: true,
  ladder: [
    { level: 0, afterMinutes: 0, recipients: [{ kind: "assignee" }], channels: ["in_app", "push"], action: "notify" },
    {
      level: 1,
      afterMinutes: 15,
      recipients: [{ kind: "assignee" }, { kind: "manager" }],
      channels: ["in_app", "push"],
      action: "notify",
    },
    {
      level: 2,
      afterMinutes: 60,
      recipients: [{ kind: "owner" }],
      channels: ["push", "digest"],
      action: "notify",
    },
    {
      level: 3,
      afterMinutes: 24 * 60,
      recipients: [{ kind: "manager" }],
      channels: ["in_app"],
      action: "reassign",
    },
  ],
  quietStartMinute: 21 * 60,
  quietEndMinute: 9 * 60,
  digestMinute: 9 * 60,

  retryIntervalsMinutes: [30, 120, 24 * 60],
  maxAttempts: 3,
  unreachableTemplate: null,

  reassignOnAbsence: true,
  reassignAfterMisses: 2,
  reassignStrategy: "round_robin",

  autoCompleteSeconds: 20,
  autoCompleteWindowMinutes: 120,

  blockCalendarForExact: false,
};

/**
 * Annotated BEFORE being frozen, which is not a style choice.
 *
 * `Object.freeze({ reminderChannels: ["in_app", "push"] })` infers `string[]`
 * for that field and `Readonly<…>` for the whole object, and neither is
 * assignable to `CallbackPolicy` - so the type annotation has to sit on the
 * literal, where TypeScript can check each field against the schema's narrow
 * unions rather than against a widened copy of itself.
 */
export const DEFAULT_CALLBACK_POLICY: CallbackPolicy = Object.freeze(DEFAULT_POLICY_VALUES);

/**
 * The write schema. No `.default()` anywhere - see the note on
 * `DEFAULT_CALLBACK_POLICY` - and the one cross-field rule the wizard cannot
 * express: a ladder has to climb.
 */
export const CallbackPolicyInput = CallbackPolicy.extend({
  reason: z.string().trim().max(500).nullish(),
  /** §10A.6 step 10: "an option to re-apply to open ones". */
  reapplyToOpen: z.boolean(),
})
  .refine((p) => p.callingEndMinute > p.callingStartMinute, {
    message: "calling hours must end after they start",
  })
  .refine(
    (p) => p.ladder.every((level, i) => i === 0 || level.afterMinutes >= p.ladder[i - 1]!.afterMinutes),
    { message: "each escalation level must come at or after the one before it" },
  )
  .refine((p) => p.ladder.every((level, i) => level.level === i), {
    message: "escalation levels must be numbered from 0 with no gaps",
  })
  .refine(
    (p) =>
      p.retryIntervalsMinutes.every((m, i) => i === 0 || m >= p.retryIntervalsMinutes[i - 1]!),
    { message: "retry intervals must not get shorter" },
  );
export type CallbackPolicyInput = z.infer<typeof CallbackPolicyInput>;

// ════════════════════════════════════════════════════════════════════════════
//  §10A.6 step 2 - the vague rules
// ════════════════════════════════════════════════════════════════════════════

function minuteOfDayIn(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return parts ? parts.hour * 60 + parts.minute : 0;
}

function instantAt(dateKey: string, minuteOfDay: number, timeZone: string): Date {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, minuteOfDay));
  const wall = `${dateKey}T${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(
    clamped % 60,
  ).padStart(2, "0")}`;
  const iso = wallTimeToInstant(wall, timeZone);
  return new Date(iso ?? `${wall}:00Z`);
}

/**
 * §10A.6 step 2, and §18's row for it.
 *
 * ── THE DEFAULT IS BUSINESS POLICY, NOT A READING OF THE WORDS ──────────────
 *
 * This is why the resolver refuses to invent an hour for a day-only phrase. "By
 * when does 'later' mean" is a decision a clinic and a steel trader answer
 * differently, and it belongs to the owner's wizard - so the resolver says
 * "a day, no hour" and this applies the owner's answer on top.
 */
export function applyVagueRule(
  phrase: string,
  ctx: ResolverContext & { policy?: CallbackPolicy },
  resolution?: TimeResolution,
): { dueAt: Date; reason: string } {
  const policy = ctx.policy ?? DEFAULT_CALLBACK_POLICY;
  const zone = ctx.timeZone;
  const text = phrase.toLowerCase();

  // A day the resolver DID find keeps its day and takes the policy's hour.
  if (resolution && resolution.kind === "window" && resolution.minuteOfDay === null) {
    const dateKey = resolution.dateKey;
    const today = dayKeyIn(ctx.reference, zone) ?? dateKey;
    const minute = /\b(?:next\s+week|agle\s+hafte)\b/.test(text)
      ? policy.weekMinute
      : dateKey === shiftDateKey(today, 1)
        ? policy.tomorrowMinute
        : policy.nextDayMinute;
    return {
      dueAt: instantAt(dateKey, minute, zone),
      reason: `using your default time for a day with no hour (${formatMinute(minute)})`,
    };
  }

  // "later" / "baad mein" / nothing at all: +N hours if it fits inside calling
  // hours today, otherwise the next working day's opening time.
  const shifted = new Date(ctx.reference.getTime() + policy.laterMinutes * 60_000);
  const shiftedDay = dayKeyIn(shifted, zone)!;
  const referenceDay = dayKeyIn(ctx.reference, zone)!;
  const shiftedMinute = minuteOfDayIn(shifted, zone);

  const fitsToday =
    shiftedDay === referenceDay &&
    shiftedMinute >= policy.callingStartMinute &&
    shiftedMinute < policy.callingEndMinute &&
    isCallingDay(shiftedDay, policy);

  if (fitsToday) {
    return {
      dueAt: shifted,
      reason: `${Math.round(policy.laterMinutes / 60)}h from the call, which is still inside your calling hours`,
    };
  }

  const nextDay = nextWorkingDay(referenceDay, {
    reference: ctx.reference,
    timeZone: zone,
    workingWeekdays: policy.callingWeekdays,
    holidays: policy.holidays,
  });
  return {
    dueAt: instantAt(nextDay, policy.nextDayMinute, zone),
    reason: `the next working day at ${formatMinute(policy.nextDayMinute)}`,
  };
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

export function isCallingDay(dateKey: string, policy: CallbackPolicy): boolean {
  if (policy.holidays.includes(dateKey)) return false;
  const parts = zonedParts(`${dateKey}T12:00:00Z`, "UTC");
  return parts ? policy.callingWeekdays.includes(parts.weekday) : true;
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.3 - placement
// ════════════════════════════════════════════════════════════════════════════

export interface PlacementResult {
  dueAt: Date;
  /** True when the requested time was outside the permitted hours or days. */
  moved: boolean;
  /** Shown to the telecaller beside the item. §10A.3: "flagged". */
  reason: string | null;
}

/**
 * §10A.3: "enforce permitted calling hours and days. A request outside them is
 * moved to the nearest permitted time and flagged to the telecaller."
 *
 * ── MOVED FORWARD, NEVER BACKWARD ───────────────────────────────────────────
 *
 * A request for 22:00 becomes 09:00 the next permitted morning, not 21:00 the
 * same evening. Ringing somebody EARLIER than they asked is a worse failure
 * than ringing them later: at 21:00 they may be mid-dinner having said "call me
 * at ten"; at 09:00 they are a person being called the next morning, which is
 * what every business does.
 *
 * ── AND THE FLAG MATTERS AS MUCH AS THE MOVE ────────────────────────────────
 *
 * §20's rule is that no commitment is silently lost. A callback moved without a
 * note is a telecaller ringing at an hour the customer did not agree to with no
 * idea that is what they are doing.
 */
export function placeInCallingHours(
  dueAt: Date,
  policy: CallbackPolicy,
  timeZone: string,
): PlacementResult {
  const zone = timeZone;
  let dayKey = dayKeyIn(dueAt, zone)!;
  const minute = minuteOfDayIn(dueAt, zone);

  // Too early in the day: same day, opening time.
  if (isCallingDay(dayKey, policy) && minute < policy.callingStartMinute) {
    return {
      dueAt: instantAt(dayKey, policy.callingStartMinute, zone),
      moved: true,
      reason: `moved to ${formatMinute(policy.callingStartMinute)} - your calling hours start then`,
    };
  }

  // Inside the window on a permitted day: nothing to do.
  if (isCallingDay(dayKey, policy) && minute < policy.callingEndMinute) {
    return { dueAt, moved: false, reason: null };
  }

  // Too late, or a day nobody rings on: the next permitted morning.
  const searchFrom = minute >= policy.callingEndMinute ? dayKey : shiftDateKey(dayKey, -1);
  dayKey = searchFrom;
  for (let i = 1; i <= 400; i += 1) {
    const candidate = shiftDateKey(dayKey, i);
    if (!isCallingDay(candidate, policy)) continue;
    return {
      dueAt: instantAt(candidate, policy.callingStartMinute, zone),
      moved: true,
      reason:
        minute >= policy.callingEndMinute
          ? `moved to ${formatMinute(policy.callingStartMinute)} the next working day - your calling hours end at ${formatMinute(policy.callingEndMinute)}`
          : `moved to the next working day - nobody calls on that day`,
    };
  }
  // A policy with no calling days at all. Leave the time alone and say so,
  // rather than looping or inventing a day.
  return {
    dueAt,
    moved: false,
    reason: "your calling-days setting has no days in it, so this was left as asked",
  };
}

export interface ClusterItem {
  id: string;
  dueAt: Date;
  /** An exact committed time is never moved. §10A.3. */
  committed: boolean;
}

/**
 * §10A.3: "if many callbacks fall due in the same minutes for one telecaller,
 * keep exact-time ones first and spread soft ones within their tolerance."
 *
 * ── EXACT TIMES ARE FIXED POINTS, NOT PRIORITIES ────────────────────────────
 *
 * A committed item is never moved by a single minute. It is the thing the
 * customer was told. Soft items flow around them, and only within
 * `clusterToleranceMinutes` - a soft item pushed two hours to make room has
 * stopped being the thing the business intended either.
 *
 * Returns only the items that MOVED, so the caller writes the minimum.
 */
export function spreadCluster(
  items: readonly ClusterItem[],
  policy: CallbackPolicy,
): ReadonlyArray<{ id: string; dueAt: Date; movedByMinutes: number }> {
  const spacing = policy.clusterSpacingMinutes * 60_000;
  const tolerance = policy.clusterToleranceMinutes * 60_000;

  // Committed first at the same instant, then by time, then stable by id so the
  // sweep is deterministic across runs.
  const sorted = [...items].sort(
    (a, b) =>
      a.dueAt.getTime() - b.dueAt.getTime() ||
      Number(b.committed) - Number(a.committed) ||
      a.id.localeCompare(b.id),
  );

  const taken: number[] = [];
  const moves: Array<{ id: string; dueAt: Date; movedByMinutes: number }> = [];

  for (const item of sorted) {
    const original = item.dueAt.getTime();
    if (item.committed) {
      taken.push(original);
      continue;
    }
    let slot = original;
    while (taken.some((t) => Math.abs(t - slot) < spacing)) {
      slot += spacing;
      if (slot - original > tolerance) {
        // Past tolerance: leave it where it was. A crowded minute is better
        // than a callback half an hour from the time anybody intended.
        slot = original;
        break;
      }
    }
    taken.push(slot);
    if (slot !== original) {
      moves.push({
        id: item.id,
        dueAt: new Date(slot),
        movedByMinutes: Math.round((slot - original) / 60_000),
      });
    }
  }

  return moves;
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.3 - priority
// ════════════════════════════════════════════════════════════════════════════

export interface PriorityInputs {
  committed: boolean;
  type: CallbackType;
  /** Minutes past due. Negative for an item not yet due. */
  overdueMinutes: number;
  attempts: number;
  /** The lead's own value in minor units, where it has one. */
  leadValueMinor: number | null;
  /** A linked payment promise or outstanding due, in minor units. */
  moneyAtRiskMinor: number | null;
  /** §10A.3: "customer sentiment (hot lead)". */
  temperature: "hot" | "medium" | "cold" | null;
  /** The lead's stage, where a late-stage lead should be rung first. */
  lateStage: boolean;
}

export interface PriorityResult {
  score: number;
  /** §10A.3: "stored with its reasons". */
  reasons: readonly { factor: string; points: number }[];
}

/**
 * §10A.3's priority score, as an additive model with its reasons stored.
 *
 * ── ADDITIVE, UNLIKE THE CONFIDENCE SCORE ───────────────────────────────────
 *
 * `scoreIntent` is a product because its signals are preconditions. This is a
 * sum because its signals are genuinely votes about the same question - "ring
 * this one first" - and a hot lead with no money attached should still outrank a
 * cold one. A product here would let one zero (no lead value) flatten
 * everything.
 *
 * ── THE NUMBERS ARE AN OPENING POSITION ─────────────────────────────────────
 *
 * They are not tuned, and they are not claimed to be. What they encode is an
 * ORDERING a telecalling floor would recognise: a time the customer actually
 * gave beats everything, money at risk beats a hot lead, and an item that has
 * been attempted twice has to climb or it will never be reached. The reasons
 * are stored so the first owner who disagrees can see what to argue with.
 */
export function priorityScore(inputs: PriorityInputs): PriorityResult {
  const reasons: Array<{ factor: string; points: number }> = [];
  const add = (factor: string, points: number) => {
    if (points !== 0) reasons.push({ factor, points });
  };

  // A time the customer gave is the strongest single signal there is.
  if (inputs.committed) add("the customer gave a time", 40);
  if (inputs.type === "exact") add("an exact time", 10);
  if (inputs.type === "vague") add("no time was given", -10);
  if (inputs.type === "far_future") add("not due for a while", -20);

  // Overdue climbs, and keeps climbing - capped so one forgotten item from
  // last week cannot outrank everything due in the next ten minutes forever.
  if (inputs.overdueMinutes > 0) {
    add("overdue", Math.min(30, Math.round(inputs.overdueMinutes / 15) * 2));
  }

  // Money first, because it is the most concrete.
  if (inputs.moneyAtRiskMinor && inputs.moneyAtRiskMinor > 0) {
    add("money is riding on this call", 25);
  }
  if (inputs.leadValueMinor && inputs.leadValueMinor > 0) {
    // Log-scaled: a ₹10 lakh lead matters more than a ₹1 lakh one, but not a
    // hundred times more, and a linear term would make every other factor noise.
    const lakhs = inputs.leadValueMinor / 100_000_00;
    add("the lead is worth something", Math.min(20, Math.round(Math.log10(1 + lakhs) * 12)));
  }

  if (inputs.temperature === "hot") add("a hot lead", 15);
  if (inputs.temperature === "cold") add("a cold lead", -5);
  if (inputs.lateStage) add("late in the pipeline", 10);

  // Each failed attempt raises it, so a hard-to-reach customer is not quietly
  // sorted to the bottom of the list forever.
  if (inputs.attempts > 0) add("already tried", Math.min(15, inputs.attempts * 5));

  const score = reasons.reduce((acc, r) => acc + r.points, 0);
  return { score, reasons };
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.2 - lifecycle
// ════════════════════════════════════════════════════════════════════════════

export const CallbackStatus = z.enum([
  "scheduled",
  "due",
  "reminded",
  "in_progress",
  "completed",
  "rescheduled",
  "missed",
  "escalated",
  "reassigned",
  "closed_unreachable",
  "cancelled",
]);
export type CallbackStatus = z.infer<typeof CallbackStatus>;

/**
 * §10A.2's graph, as data.
 *
 * A map and not a chain of `if`s, because the states are the thing a reader
 * needs to be able to check against the spec - and because the API, the worker
 * sweep and the console all move callbacks, and a transition one of them allows
 * and another does not is how a callback ends up in a state nothing will ever
 * pick up again.
 *
 * `reassigned` goes back to `scheduled`: a reassignment is not an end state, it
 * is the same commitment with a different person's name on it.
 */
export const CALLBACK_TRANSITIONS: Readonly<Record<CallbackStatus, readonly CallbackStatus[]>> = {
  scheduled: ["due", "rescheduled", "cancelled", "reassigned", "in_progress", "completed"],
  due: ["reminded", "in_progress", "completed", "missed", "rescheduled", "cancelled", "reassigned"],
  reminded: ["in_progress", "completed", "missed", "rescheduled", "cancelled", "reassigned"],
  in_progress: ["completed", "missed", "rescheduled", "closed_unreachable"],
  missed: ["escalated", "in_progress", "completed", "rescheduled", "reassigned", "cancelled"],
  escalated: ["in_progress", "completed", "rescheduled", "reassigned", "cancelled", "closed_unreachable"],
  reassigned: ["scheduled"],
  rescheduled: ["scheduled"],
  completed: [],
  closed_unreachable: [],
  cancelled: [],
};

export function canTransition(from: CallbackStatus, to: CallbackStatus): boolean {
  return CALLBACK_TRANSITIONS[from].includes(to);
}

export function isTerminalCallbackStatus(status: CallbackStatus): boolean {
  return CALLBACK_TRANSITIONS[status].length === 0;
}

/** The statuses that still want a telecaller to do something. */
export const OPEN_CALLBACK_STATUSES: readonly CallbackStatus[] = [
  "scheduled",
  "due",
  "reminded",
  "in_progress",
  "missed",
  "escalated",
];

// ════════════════════════════════════════════════════════════════════════════
//  §10A.4 - reminders
// ════════════════════════════════════════════════════════════════════════════

export const ReminderKind = z.enum(["pre", "due", "nudge"]);
export type ReminderKind = z.infer<typeof ReminderKind>;

export interface PlannedReminder {
  kind: ReminderKind;
  at: Date;
  channels: readonly AlertChannel[];
}

/**
 * §10A.4's default schedule: T-10, due, +5.
 *
 * ── A PRE-REMINDER IN THE PAST IS NOT SCHEDULED ─────────────────────────────
 *
 * A callback created at 16:55 for 17:00 has no T-10. Emitting one anyway would
 * put a reminder in the past, which the scheduler would fire immediately -
 * giving the telecaller two popups five minutes apart for the same item, which
 * is how people learn to dismiss popups unread.
 *
 * ── AND THE SCHEDULE IS SERVER-SIDE, WHICH IS WHY THIS RETURNS INSTANTS ─────
 *
 * §10A.4: "delivered by a server-side scheduler, not client timers. Reminders
 * survive restarts, are idempotent, and have tracked states." Rows with
 * instants, drained by a sweep - not `setTimeout` in a browser tab that gets
 * closed at lunchtime.
 */
export function reminderSchedule(
  dueAt: Date,
  policy: CallbackPolicy,
  createdAt: Date,
): readonly PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const channels = policy.reminderChannels;

  if (policy.preReminderMinutes > 0) {
    const at = new Date(dueAt.getTime() - policy.preReminderMinutes * 60_000);
    if (at.getTime() > createdAt.getTime()) out.push({ kind: "pre", at, channels });
  }

  out.push({ kind: "due", at: dueAt, channels });

  if (policy.nudgeMinutes > 0) {
    out.push({
      kind: "nudge",
      at: new Date(dueAt.getTime() + policy.nudgeMinutes * 60_000),
      channels,
    });
  }

  return out;
}

/**
 * §10A.4's smart suppression: "if the telecaller is on a call, queue the popup
 * and show it right after the call ends."
 *
 * Returns the instant to deliver at, or `null` for "hold" - which is what the
 * `on a call` case is, because the end of the call is not known yet and the
 * scheduler re-asks on its next tick.
 */
export interface DeliveryContext {
  now: Date;
  /** The telecaller is mid-call. §10A.4. */
  onCall: boolean;
  /** Their own Do Not Disturb, or the org's quiet hours. */
  doNotDisturb: boolean;
  timeZone: string;
}

export type ReminderDecision =
  | { deliver: true; reason: "due" }
  | { deliver: false; reason: "on_call" | "quiet_hours" | "not_yet" | "expired" };

/**
 * ── MISSED-CALLBACK RULES STILL APPLY DURING DND (§10A.4) ───────────────────
 *
 * This decides only whether the REMINDER is delivered. It is not consulted by
 * the escalation ladder, and that separation is the point: a telecaller with Do
 * Not Disturb on does not get a popup, and the callback is still missed at
 * `due + grace`, and the manager is still told. Suppressing the reminder and
 * the escalation together would make DND a way to silently drop commitments.
 */
export function shouldDeliverReminder(
  reminderAt: Date,
  ctx: DeliveryContext,
  policy: CallbackPolicy,
): ReminderDecision {
  if (reminderAt.getTime() > ctx.now.getTime()) return { deliver: false, reason: "not_yet" };

  // A reminder nobody collected for a whole day is noise by the time it
  // arrives - the same rule `HANDSET_ALERT_TTL_MINUTES` applies to phone
  // alerts. The callback itself is unaffected and still escalates.
  const ageMinutes = (ctx.now.getTime() - reminderAt.getTime()) / 60_000;
  if (ageMinutes > 12 * 60) return { deliver: false, reason: "expired" };

  if (ctx.onCall) return { deliver: false, reason: "on_call" };
  if (ctx.doNotDisturb) return { deliver: false, reason: "quiet_hours" };
  if (inQuietMinutes(ctx.now, ctx.timeZone, policy)) {
    return { deliver: false, reason: "quiet_hours" };
  }
  return { deliver: true, reason: "due" };
}

export function inQuietMinutes(
  instant: Date,
  timeZone: string,
  policy: CallbackPolicy,
): boolean {
  const { quietStartMinute: start, quietEndMinute: end } = policy;
  if (start === null || end === null || start === end) return false;
  const now = minuteOfDayIn(instant, timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.5 - missed, escalation, retries
// ════════════════════════════════════════════════════════════════════════════

/**
 * §10A.5: "not completed or attempted by `due_at + grace`. An unanswered
 * attempt is NOT 'missed'; it counts as an attempt and follows the retry
 * rules."
 *
 * That second sentence is the whole function. A telecaller who rang and got no
 * answer did their job; escalating them to their manager for it is how a
 * business teaches its floor that the system is wrong about them.
 */
export function isMissed(
  callback: {
    status: CallbackStatus;
    dueAt: Date;
    attempts: number;
    lastAttemptAt: Date | null;
    committed: boolean;
  },
  policy: CallbackPolicy,
  now: Date,
): boolean {
  if (isTerminalCallbackStatus(callback.status)) return false;
  if (callback.status === "missed" || callback.status === "escalated") return true;
  if (callback.status === "in_progress") return false;

  const deadline = callback.dueAt.getTime() + policy.graceMinutes * 60_000;
  if (now.getTime() < deadline) return false;

  // An attempt AFTER the due time means it was not missed - it was tried.
  if (callback.lastAttemptAt && callback.lastAttemptAt.getTime() >= callback.dueAt.getTime()) {
    return false;
  }
  return true;
}

/**
 * §10A.5: "by default, escalate only committed callbacks. Soft and vague ones
 * remind only the telecaller. Configurable."
 */
export function shouldEscalate(
  callback: { committed: boolean },
  policy: CallbackPolicy,
): boolean {
  return policy.escalateCommittedOnly ? callback.committed : true;
}

export interface PlannedEscalation {
  level: number;
  at: Date;
  recipients: readonly EscalationRecipient[];
  channels: readonly AlertChannel[];
  action: EscalationLevelConfig["action"];
}

/**
 * The ladder, as instants.
 *
 * ── MEASURED FROM `due_at`, NOT FROM THE MISS ───────────────────────────────
 *
 * §10A.5's table says "+15 min, still not actioned". Measured from the
 * DETECTION instead, the whole ladder would slide by however long the sweep
 * took to notice - so a sweep running every five minutes would escalate at +20
 * on a good day and +35 on a slow one, and the owner's "+60 min" level would
 * land at an hour and a half. Anchoring on `due_at` makes the ladder mean what
 * the owner configured regardless of sweep latency.
 */
export function escalationLadder(
  dueAt: Date,
  policy: CallbackPolicy,
): readonly PlannedEscalation[] {
  return policy.ladder.map((level) => ({
    level: level.level,
    at: new Date(dueAt.getTime() + level.afterMinutes * 60_000),
    recipients: level.recipients,
    channels: level.channels,
    action: level.action,
  }));
}

/**
 * Which levels are due now and not yet acknowledged.
 *
 * §10A.5: "acknowledgement stops further escalation **for that level**."
 * Deliberately per-level and not for the whole ladder: a manager seeing it at
 * +15 does not mean the owner should not learn at +60 that it is still not
 * done. What stops the ladder is the callback being ACTIONED, which is a status
 * change this function reads.
 */
export function dueEscalations(
  dueAt: Date,
  policy: CallbackPolicy,
  now: Date,
  alreadySentLevels: readonly number[],
): readonly PlannedEscalation[] {
  const sent = new Set(alreadySentLevels);
  return escalationLadder(dueAt, policy).filter(
    (level) => !sent.has(level.level) && level.at.getTime() <= now.getTime(),
  );
}

/**
 * §10A.5's retries: 30 min, 2 h, next day, up to 3 attempts.
 *
 * Named `nextCallbackRetryAt` and not `nextRetryAt` because `dialable.ts`
 * already exports the latter for dial attempts, and both are in the barrel. A
 * name collision there is a build error rather than a silent shadowing, which
 * is the good kind - but one of them has to give, and a callback retry is the
 * newer idea.
 *
 * `attempts` is the number ALREADY made. Returns null when the budget is spent,
 * which is the caller's signal to run the unreachable path (notify the manager,
 * set `closed_unreachable`, and queue - never send - the fallback template).
 */
export function nextCallbackRetryAt(
  attempts: number,
  lastAttemptAt: Date,
  policy: CallbackPolicy,
  timeZone: string,
): Date | null {
  if (attempts >= policy.maxAttempts) return null;
  const interval =
    policy.retryIntervalsMinutes[Math.min(attempts, policy.retryIntervalsMinutes.length) - 1] ??
    policy.retryIntervalsMinutes[policy.retryIntervalsMinutes.length - 1]!;
  const naive = new Date(lastAttemptAt.getTime() + interval * 60_000);
  // A retry is a CALL, so it obeys calling hours like any other.
  return placeInCallingHours(naive, policy, timeZone).dueAt;
}

/**
 * §10A.2: "auto-completed when a connected call to that lead and contact
 * finishes inside the window with duration at or above a threshold."
 *
 * ── THE WINDOW IS GENEROUS ON PURPOSE ───────────────────────────────────────
 *
 * `autoCompleteWindowMinutes` defaults to two hours either side. A telecaller
 * who rings at 17:40 for a 17:00 callback has done the thing; a strict window
 * would leave the item open, escalate it to their manager, and teach everybody
 * that the list lies. The cost of being generous is an occasional unrelated
 * call closing a callback - recoverable, visible, and far cheaper.
 */
export function autoCompletes(
  call: { startedAt: Date; durationSeconds: number; connected: boolean },
  callback: { dueAt: Date; windowStart: Date | null; windowEnd: Date | null },
  policy: CallbackPolicy,
): boolean {
  if (!call.connected) return false;
  if (call.durationSeconds < policy.autoCompleteSeconds) return false;

  const slack = policy.autoCompleteWindowMinutes * 60_000;
  const from = (callback.windowStart ?? callback.dueAt).getTime() - slack;
  const to = (callback.windowEnd ?? callback.dueAt).getTime() + slack;
  const at = call.startedAt.getTime();
  return at >= from && at <= to;
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.7 - turning the feature off
// ════════════════════════════════════════════════════════════════════════════

/**
 * §10A.7: "open callbacks must NEVER be silently lost. When the feature or
 * capability is switched off for a user: stop popups and escalations, convert
 * open callbacks into ordinary follow-up tasks in the standard to-do list (no
 * popups, no escalation), and show the owner a list of those tasks for manual
 * reassignment."
 *
 * The conversion is the whole of §20's "including when the feature is turned
 * off", so the shape of the task is here rather than in the worker: the title,
 * the notes and the due instant are what survive, and they have to carry enough
 * for a person with no agent to do the job.
 */
export interface ConvertedTask {
  title: string;
  notes: string;
  /** `tasks.due_at` - the instant, so the time the customer asked for survives. */
  dueAt: Date;
  priority: "low" | "normal" | "high";
}

export function callbackToTask(callback: {
  contactName: string | null;
  contactPhone: string | null;
  requestedText: string | null;
  dueAt: Date;
  committed: boolean;
  attempts: number;
  notes: string | null;
}): ConvertedTask {
  const who = callback.contactName?.trim() || callback.contactPhone?.trim() || "this customer";
  const lines = [
    `The customer asked to be called back${callback.requestedText ? `: "${callback.requestedText.trim()}"` : "."}`,
  ];
  if (callback.attempts > 0) {
    lines.push(`Already tried ${callback.attempts} time${callback.attempts === 1 ? "" : "s"}.`);
  }
  if (callback.notes?.trim()) lines.push(callback.notes.trim());
  lines.push(
    "Carried over from the call-back list when the transcript assistant was switched off, so there are no reminders on it.",
  );

  return {
    title: `Call ${who} back`,
    notes: lines.join("\n"),
    dueAt: callback.dueAt,
    // A time the customer gave stays high priority even without the agent -
    // demoting it on the way out would be exactly the silent loss §10A.7
    // exists to prevent.
    priority: callback.committed ? "high" : "normal",
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.3 - the to-call list's sections
// ════════════════════════════════════════════════════════════════════════════

export const CallbackSection = z.enum(["overdue", "due_now", "today", "later"]);
export type CallbackSection = z.infer<typeof CallbackSection>;

export const CALLBACK_SECTION_LABELS: Record<CallbackSection, string> = {
  overdue: "Overdue",
  due_now: "Due now",
  today: "Later today",
  later: "Later",
};

/**
 * Which section an item belongs in.
 *
 * "Due now" is a WINDOW around the due time and not the single instant: an item
 * that is due in four minutes and one that went due two minutes ago are the
 * same thing to the person holding the phone, and splitting them across two
 * sections makes the list jump under their hands.
 */
export const DUE_NOW_BEFORE_MINUTES = 10;

export function callbackSection(
  callback: { dueAt: Date },
  now: Date,
  timeZone: string,
  policy: CallbackPolicy = DEFAULT_CALLBACK_POLICY,
): CallbackSection {
  const deltaMinutes = (callback.dueAt.getTime() - now.getTime()) / 60_000;
  if (deltaMinutes < -policy.graceMinutes) return "overdue";
  if (deltaMinutes <= DUE_NOW_BEFORE_MINUTES) return "due_now";
  return dayKeyIn(callback.dueAt, timeZone) === dayKeyIn(now, timeZone) ? "today" : "later";
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.8 - metrics
// ════════════════════════════════════════════════════════════════════════════

export interface CallbackMetrics {
  /** §10A.8: completed within grace of a COMMITTED time, over committed total. */
  adherenceRate: number | null;
  averageDelayMinutes: number | null;
  missedRate: number | null;
  escalations: number;
  retries: number;
  /** Completed on the last attempt, over all that needed retrying. */
  retrySuccessRate: number | null;
  /** Callbacks whose lead later converted, over completed callbacks. */
  conversionRate: number | null;
}

export interface CallbackMetricInputs {
  committedTotal: number;
  committedOnTime: number;
  completedTotal: number;
  missedTotal: number;
  totalDelayMinutes: number;
  delaySamples: number;
  escalations: number;
  retries: number;
  retriedTotal: number;
  retriedCompleted: number;
  convertedAfterCallback: number;
}

/**
 * §10A.8's metrics, computed in one place so the KPI catalogue, the console and
 * the Advisor cannot each divide by something different.
 *
 * Every rate returns NULL rather than 0 when its denominator is empty. A floor
 * with no committed callbacks has no adherence rate, and showing 0 % would read
 * as a floor that missed everything - the one number an owner would act on
 * hardest and the one that would be most wrong.
 */
export function callbackMetrics(input: CallbackMetricInputs): CallbackMetrics {
  const rate = (numerator: number, denominator: number): number | null =>
    denominator > 0 ? numerator / denominator : null;

  return {
    adherenceRate: rate(input.committedOnTime, input.committedTotal),
    averageDelayMinutes:
      input.delaySamples > 0 ? input.totalDelayMinutes / input.delaySamples : null,
    missedRate: rate(input.missedTotal, input.completedTotal + input.missedTotal),
    escalations: input.escalations,
    retries: input.retries,
    retrySuccessRate: rate(input.retriedCompleted, input.retriedTotal),
    conversionRate: rate(input.convertedAfterCallback, input.completedTotal),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  §10A.6's clock fields, in both directions
// ════════════════════════════════════════════════════════════════════════════

/**
 * A minute-of-day as `HH:mm`, and back.
 *
 * The policy stores minutes since midnight - `callingStartMinute`, the daypart
 * table, the digest hour, quiet hours - because a minute is unambiguous and a
 * string is not. A wizard has to show `<input type="time">`, which speaks
 * `HH:mm`, so the conversion exists; it lives HERE rather than in the console
 * because the simulate preview, the policy summary and the form all render the
 * same numbers and a second copy would eventually round differently.
 *
 * `24 * 60` is a legal END minute (`callingEndMinute` is `max(24 * 60)`) and
 * `<input type="time">` cannot express 24:00, so it clamps to 23:59 on the way
 * out and is preserved on the way back only if the owner leaves it alone.
 */
export function minuteToClock(minute: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minute)));
  const hour = Math.floor(clamped / 60);
  const rest = clamped - hour * 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** `HH:mm` to minutes since midnight. Anything unparseable gives `null`. */
export function clockToMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59) return null;
  const total = hour * 60 + minute;
  return total > 24 * 60 ? null : total;
}

/** "9:00 am" - for prose, where `09:00` reads like a timetable. */
export function minuteToWords(minute: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minute)));
  if (clamped === 24 * 60) return "midnight";
  const hour24 = Math.floor(clamped / 60);
  const rest = clamped - hour24 * 60;
  const suffix = hour24 < 12 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return rest === 0
    ? `${hour12} ${suffix}`
    : `${hour12}:${String(rest).padStart(2, "0")} ${suffix}`;
}

/** ISO weekday (1 = Monday) names, for the calling-days checklist. */
export const WEEKDAY_NAMES: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

/**
 * A duration in minutes, said the way a person would.
 *
 * The policy is full of minute counts an owner has to judge - a 180-minute
 * "later" rule, a 1440-minute retry - and "1440 minutes" is not a number
 * anybody can sanity-check.
 */
export function minutesToWords(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes - hours * 60} min`;
}
