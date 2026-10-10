import { type AgentCapability, type AgentMode, type GateDecision, gateAllows } from "./feature-gates";
import {
  type AgentIntentType,
  type AgentTier,
  type AgentToolName,
  type ScoreBand,
  capabilityForIntent,
  idempotencyKey,
  intentSpec,
  mayAutoExecute,
  scoreBandFor,
  toolSpec,
} from "./transcript-agent";
import { dayKeyIn, shiftDateKey, wallTimeToInstant, zonedParts } from "./time";

/**
 * POLICY, VALIDATION AND THE PLAN
 * (Build docs/transcript-agent-build-plan §8 and §10's executor rules).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Between "the model understood something" and "the executor does something"
 * there is a layer that says no. §8 lists what it checks; §17 M4's acceptance
 * criterion is the thing to hold onto:
 *
 *     "policy tests prove T3 never auto-executes and opt-outs are always
 *      honored."
 *
 * Both of those are properties of this file, and both are tested here rather
 * than at an integration seam, because a property that is only true when a
 * database is up is a property nobody checks on a Tuesday.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  EVERY CHECK RETURNS A REASON, AND THE REASON IS SHOWN TO A PERSON
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A planner that returns a filtered list teaches nobody anything. "Why did the
 * agent not book that?" has to have an answer, in the review queue, in the
 * words of the business - so a refused action is RETAINED with a code and a
 * sentence rather than dropped. The executor skips it; the console explains it.
 */

export const POLICY_VERSION = "1.0.0";

// ════════════════════════════════════════════════════════════════════════════
//  Results
// ════════════════════════════════════════════════════════════════════════════

/**
 * Why an action is not going to happen by itself.
 *
 * Machine-readable, because the console groups by it and the drift monitor
 * counts it. A sudden rise in `no_slot_available` is a business whose diary is
 * full; a rise in `blocked_by_gate` is somebody having switched the feature off
 * mid-wave.
 */
export const PolicyCode = [
  "ok",
  "blocked_by_gate",
  "capability_off",
  "intent_disabled",
  "superseded",
  "opt_out",
  "no_consent",
  "template_not_approved",
  "outside_working_hours",
  "holiday_or_leave",
  "too_soon",
  "slot_busy",
  "day_full",
  "no_slot_available",
  /**
   * A detail the tool cannot run without was never established - the
   * appointment a reschedule would move, the slot a booking would take.
   *
   * Distinct from `no_slot_available` on purpose: that one means the time the
   * customer asked for was busy, which a person answers by offering another
   * time. This one means the assistant does not know WHICH thing they meant,
   * which a person answers by opening the record. Collapsing the two sent a
   * reviewer looking for a diary clash that did not exist.
   */
  "missing_detail",
  "duplicate",
  "not_permitted",
  "over_authority",
  "needs_clarification",
  "needs_review",
  "tier_requires_human",
  "unknown_intent",
] as const;
export type PolicyCode = (typeof PolicyCode)[number];

export interface PolicyResult {
  ok: boolean;
  code: PolicyCode;
  /** One sentence, phrased for the person reading the review queue. */
  message: string;
}

const OK: PolicyResult = { ok: true, code: "ok", message: "" };

function refuse(code: PolicyCode, message: string): PolicyResult {
  return { ok: false, code, message };
}

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - opt-out and consent
// ════════════════════════════════════════════════════════════════════════════

export interface ContactPolicyState {
  /** A recorded do-not-contact on the lead or the number. */
  doNotContact: boolean;
  /** Per-channel consent, where the channel needs one. */
  consent: Readonly<Partial<Record<"whatsapp" | "sms" | "email" | "phone", boolean>>>;
  /** The number is on a suppression list (0158). */
  suppressed: boolean;
}

/**
 * §8.1 and §14: "an opt-out request is executed promptly across all channels
 * and cannot be overridden by the agent."
 *
 * ── THE DIRECTION OF THIS CHECK IS THE WHOLE POINT ──────────────────────────
 *
 * It only ever BLOCKS. There is no branch here that permits something which
 * would otherwise be refused, and `mark_do_not_contact` is deliberately exempt:
 * recording an opt-out on a lead that already has one is a no-op, and refusing
 * it would be the one case where honouring a customer's request was blocked by
 * their own request.
 */
export function checkContactPolicy(
  tool: AgentToolName,
  state: ContactPolicyState,
  channel?: "whatsapp" | "sms" | "email" | "phone",
): PolicyResult {
  if (tool === "mark_do_not_contact") return OK;

  const spec = toolSpec(tool);
  if (!spec.customerVisible) {
    // An internal record about somebody who opted out is still allowed - the
    // business may note what happened on the call. What it may not do is
    // CONTACT them, and a callback is contact.
    if (tool !== "schedule_callback") return OK;
  }

  if (state.doNotContact) {
    return refuse("opt_out", "This customer has asked not to be contacted.");
  }
  if (state.suppressed) {
    return refuse("opt_out", "This number is on a do-not-call list.");
  }
  if (channel && state.consent[channel] === false) {
    return refuse(
      "no_consent",
      `This customer has not agreed to be contacted on ${channel}.`,
    );
  }
  return OK;
}

/**
 * §8.1: "outbound messages use pre-approved templates (WhatsApp/SMS
 * compliance); no free-form generation to customers in v1."
 *
 * Takes the template's stored `status` from `message_templates` (0098), whose
 * values this platform already has: `local` is a canned reply on a personal
 * WhatsApp provider with no approval process, `approved` is Meta's answer.
 * Anything else refuses - including `paused`, which is a template Meta approved
 * yesterday and stopped today, and a send against which fails with an error the
 * rep cannot interpret.
 */
export function checkTemplate(
  template: { name: string; status: string } | null,
): PolicyResult {
  if (!template) {
    return refuse(
      "template_not_approved",
      "There is no approved message template for this, so nothing can be sent.",
    );
  }
  if (template.status === "approved" || template.status === "local") return OK;
  return refuse(
    "template_not_approved",
    `The "${template.name}" template is ${template.status}, so it cannot be sent.`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - availability and business rules
// ════════════════════════════════════════════════════════════════════════════

export interface WorkingWindow {
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface BookingRules {
  slotMinutes: number;
  /** Dead time either side of a booking. §18: 10 minutes. */
  bufferMinutes: number;
  /** §18: 30 minutes. Nothing is booked sooner than this from now. */
  minNoticeMinutes: number;
  /** 0 = unlimited. */
  maxPerDay: number;
  workingWindows: readonly WorkingWindow[];
  /** `YYYY-MM-DD` - org holidays and the assignee's own leave, merged. */
  closedDays: readonly string[];
  timeZone: string;
}

export const DEFAULT_BOOKING_RULES: Omit<BookingRules, "timeZone"> = Object.freeze({
  slotMinutes: 30,
  bufferMinutes: 10,
  minNoticeMinutes: 30,
  maxPerDay: 0,
  workingWindows: [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startMinute: 10 * 60,
    endMinute: 19 * 60,
  })),
  closedDays: [],
});

export interface BusySpan {
  start: Date;
  end: Date;
}

function overlaps(a: BusySpan, b: BusySpan): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

function minuteOfDay(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return parts ? parts.hour * 60 + parts.minute : 0;
}

function weekdayOf(instant: Date, timeZone: string): number {
  return zonedParts(instant, timeZone)?.weekday ?? 1;
}

/**
 * §8.1's whole list, for one proposed slot.
 *
 * ── THE ORDER IS CHEAPEST-AND-MOST-DEFINITE FIRST ───────────────────────────
 *
 * Working hours and holidays are arithmetic on a date; the busy list is a
 * calendar read. Checking the arithmetic first means a slot at 03:00 on a
 * Sunday is refused without anybody's calendar being fetched - which matters,
 * because §9 wants the free/busy read done concurrently and as late as possible
 * and §11 re-does it at write time.
 *
 * ── THE BUFFER IS APPLIED TO THE CANDIDATE, NOT TO THE BUSY SPANS ───────────
 *
 * Widening the candidate by the buffer on both sides and testing for overlap is
 * equivalent to widening every busy span, and it is one object to get right
 * instead of N. It also keeps the stored appointment the length the customer
 * was told, which widening the booking would not.
 */
export function checkSlot(
  slot: BusySpan,
  busy: readonly BusySpan[],
  rules: BookingRules,
  now: Date,
  bookingsThatDay = 0,
): PolicyResult {
  const zone = rules.timeZone;

  if (slot.end.getTime() <= slot.start.getTime()) {
    return refuse("no_slot_available", "That slot has no length.");
  }

  if (slot.start.getTime() - now.getTime() < rules.minNoticeMinutes * 60_000) {
    // One code, two sentences. A slot in the past and a slot nine minutes away
    // are refused for the same reason and read completely differently to the
    // person in the review queue, and "that is less than 30 minutes away" about
    // last Tuesday reads like a bug in the product.
    return refuse(
      "too_soon",
      slot.start.getTime() <= now.getTime()
        ? "That time has already passed."
        : `That is less than ${rules.minNoticeMinutes} minutes away, which is too soon to book.`,
    );
  }

  const dayKey = dayKeyIn(slot.start, zone)!;
  if (rules.closedDays.includes(dayKey)) {
    return refuse("holiday_or_leave", "Nobody is working that day.");
  }

  const weekday = weekdayOf(slot.start, zone);
  const windows = rules.workingWindows.filter((w) => w.weekday === weekday);
  if (windows.length === 0) {
    return refuse("outside_working_hours", "That is not a working day.");
  }

  const startMinute = minuteOfDay(slot.start, zone);
  const endMinute = startMinute + Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000);
  const fits = windows.some((w) => startMinute >= w.startMinute && endMinute <= w.endMinute);
  if (!fits) {
    return refuse("outside_working_hours", "That is outside working hours.");
  }

  if (rules.maxPerDay > 0 && bookingsThatDay >= rules.maxPerDay) {
    return refuse("day_full", "That day already has as many bookings as you allow.");
  }

  const padded: BusySpan = {
    start: new Date(slot.start.getTime() - rules.bufferMinutes * 60_000),
    end: new Date(slot.end.getTime() + rules.bufferMinutes * 60_000),
  };
  if (busy.some((span) => overlaps(padded, span))) {
    return refuse("slot_busy", "That time is already taken.");
  }

  return OK;
}

/**
 * §7.1's windows become slots here: "windows are used to propose slots from
 * availability."
 *
 * Walks the window in slot-length steps and returns the ones that pass every
 * check. Bounded by `limit` so a "next month" window cannot generate a thousand
 * candidates.
 *
 * ── RETURNS A LIST, NOT A CHOICE ────────────────────────────────────────────
 *
 * Picking one is the planner's job and the FIRST is what it picks, because the
 * customer who said "after 5" is available from 5 - the same argument
 * `bestInstant` makes. The list exists so the review queue can offer a person
 * the alternatives when the first is refused.
 */
export function proposeSlots(
  window: BusySpan,
  busy: readonly BusySpan[],
  rules: BookingRules,
  now: Date,
  limit = 8,
): readonly BusySpan[] {
  const out: BusySpan[] = [];
  const step = rules.slotMinutes * 60_000;
  // A window shorter than one slot still deserves one candidate at its start:
  // "at 5" resolves to an instant, and a 30-minute meeting at 17:00 does not
  // stop being proposable because the window was zero-length.
  const last = Math.max(window.start.getTime(), window.end.getTime() - step);

  for (let at = window.start.getTime(); at <= last && out.length < limit; at += step) {
    const slot: BusySpan = { start: new Date(at), end: new Date(at + step) };
    if (checkSlot(slot, busy, rules, now).ok) out.push(slot);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - assignment
// ════════════════════════════════════════════════════════════════════════════

export interface Assignee {
  userId: string;
  /** Available at the proposed time: not on leave, on shift, not full. */
  available: boolean;
  /** How many open items they already hold, for least-loaded. */
  load: number;
  /** For round-robin: when they were last given something. */
  lastAssignedAt: Date | null;
  /** The skills this person has, for skill-based routing. */
  skills: readonly string[];
}

export type AssignmentStrategy = "owner_first" | "round_robin" | "least_loaded" | "skill";

/**
 * §8.1: "lead owner first; otherwise skill-based or round-robin using the org
 * chart and availability."
 *
 * ── AN UNAVAILABLE OWNER DOES NOT KEEP THE WORK ─────────────────────────────
 *
 * §10A.3 is explicit for callbacks and the same applies here: if the lead's
 * owner is on leave or off shift at the due time, the item goes to somebody
 * else and BOTH people are told. Leaving it with them is how a customer's
 * callback sits in an absent person's list for a week - the exact silent loss
 * §20 forbids.
 *
 * Returns null when nobody is available, which is a refusal the caller turns
 * into a review item rather than a guess.
 */
export function pickAssignee(
  owner: Assignee | null,
  pool: readonly Assignee[],
  strategy: AssignmentStrategy,
  requiredSkill?: string,
): { userId: string; reason: string } | null {
  if (owner?.available) {
    return { userId: owner.userId, reason: "the lead's own owner" };
  }

  const candidates = pool.filter(
    (person) =>
      person.available && (!requiredSkill || person.skills.includes(requiredSkill)),
  );
  if (candidates.length === 0) return null;

  if (strategy === "least_loaded") {
    const best = [...candidates].sort(
      (a, b) => a.load - b.load || a.userId.localeCompare(b.userId),
    )[0]!;
    return { userId: best.userId, reason: "the person with the fewest open items" };
  }

  if (strategy === "skill" && requiredSkill) {
    const best = [...candidates].sort(
      (a, b) => a.load - b.load || a.userId.localeCompare(b.userId),
    )[0]!;
    return { userId: best.userId, reason: `knows ${requiredSkill}` };
  }

  // Round-robin, and `owner_first` falls through to it once the owner is out.
  // Longest-idle first; `null` (never assigned) sorts first, and the id breaks
  // the tie so the choice is deterministic across worker restarts.
  const best = [...candidates].sort((a, b) => {
    const at = a.lastAssignedAt?.getTime() ?? 0;
    const bt = b.lastAssignedAt?.getTime() ?? 0;
    return at - bt || a.userId.localeCompare(b.userId);
  })[0]!;
  return {
    userId: best.userId,
    reason: owner ? "the lead's owner is not available, so this went round-robin" : "round-robin",
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - permissions and authority
// ════════════════════════════════════════════════════════════════════════════

export interface ActingIdentity {
  /** The telecaller whose call this is. The agent acts AS them, never above. */
  userId: string | null;
  telecallerId: string | null;
  /** What the permission grid grants them. */
  grants: readonly string[];
  /** §8.1: the authority limit from the org chart, in minor units. Null = none. */
  authorityLimitMinor: number | null;
}

/**
 * §8.1: "the acting identity (agent service plus the telecaller) must be
 * allowed the action and the amounts."
 *
 * ── THE AGENT HAS NO AUTHORITY OF ITS OWN ───────────────────────────────────
 *
 * It acts as the telecaller who handled the call, and it can therefore never do
 * something that telecaller could not do by hand. That is what makes the whole
 * module safe to switch on for one person: the blast radius of a bug is bounded
 * by one person's existing permissions, not by a service account's.
 *
 * `grants` are the permission grid's `object:action` strings this platform
 * already uses, so the caller passes what `CrmPermissionsGuard` would have
 * resolved rather than a second permission model.
 */
export function checkPermission(
  tool: AgentToolName,
  identity: ActingIdentity,
  requiredGrant: string | null,
  amountMinor?: number | null,
): PolicyResult {
  if (requiredGrant && !identity.grants.includes(requiredGrant)) {
    return refuse(
      "not_permitted",
      "The person who took this call is not allowed to do that, so the assistant is not either.",
    );
  }

  if (
    amountMinor !== undefined &&
    amountMinor !== null &&
    identity.authorityLimitMinor !== null &&
    amountMinor > identity.authorityLimitMinor
  ) {
    return refuse(
      "over_authority",
      "The amount is above what the person who took this call may approve.",
    );
  }

  void tool;
  return OK;
}

// ════════════════════════════════════════════════════════════════════════════
//  §8.1 - duplicates
// ════════════════════════════════════════════════════════════════════════════

export interface ExistingItem {
  tool: AgentToolName;
  /** The key the previous run used. */
  idempotencyKey: string;
  /** Still live? A cancelled booking is not a duplicate of a new one. */
  active: boolean;
  /** For an equivalence check that is not key-identical. */
  subject?: string | null;
  at?: Date | null;
}

/**
 * §8.1: "an equivalent booking, task or message already exists."
 *
 * ── TWO KINDS OF DUPLICATE, AND THE KEY ONLY CATCHES ONE ────────────────────
 *
 * The idempotency key catches the SAME plan arriving twice - a redelivery, a
 * retry, a replayed job. That is the executor's job and it is exact.
 *
 * This catches the other kind: a DIFFERENT run proposing the same thing. Call
 * 1 books Tuesday 15:00; the customer rings again an hour later and call 2
 * proposes Tuesday 15:00 too. The keys differ (different call ids) and the
 * customer would get two appointments. So equivalence is on the SUBJECT - the
 * slot, the number, the template - within a window.
 */
export function findDuplicate(
  tool: AgentToolName,
  subject: string | null,
  at: Date | null,
  existing: readonly ExistingItem[],
  windowMinutes = 24 * 60,
): ExistingItem | null {
  const normalised = subject?.trim().toLowerCase() ?? null;
  return (
    existing.find((item) => {
      if (!item.active || item.tool !== tool) return false;
      if (normalised && (item.subject?.trim().toLowerCase() ?? null) !== normalised) return false;
      if (at && item.at) {
        const apart = Math.abs(at.getTime() - item.at.getTime()) / 60_000;
        if (apart > windowMinutes) return false;
      }
      return true;
    }) ?? null
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  §3 - the plan
// ════════════════════════════════════════════════════════════════════════════

export const ActionState = [
  /** Will execute. */
  "planned",
  /** A person has to approve it first. §12's review inbox. */
  "pending_review",
  /** Policy refused it. Retained with its reason, never executed. */
  "blocked",
  /** Recorded only - below the review threshold (§8.3). */
  "recorded",
] as const;
export type ActionState = (typeof ActionState)[number];

export interface ActionCandidate {
  /** The intent this came from; null for the T0 records the run always writes. */
  intentType: string | null;
  intentIndex: number | null;
  tool: AgentToolName;
  params: Readonly<Record<string, unknown>>;
  /** The parts of §10's idempotency key for this tool. */
  keyParts: Readonly<Record<string, string | number | null | undefined>>;
  /** The final score from `scoreIntent`. T0 records pass 1. */
  score: number;
  /** Policy's verdict. `ok` unless a check above refused. */
  policy: PolicyResult;
  /** True when the model marked this intent superseded by a later one. */
  superseded?: boolean;
  /** The org switched this intent to automatic (§8.2). */
  orgEnabledAuto?: boolean;
  /** §13.3's measured gate for this intent. */
  accuracyGateMet?: boolean;
  /** The org disabled this intent entirely. */
  intentDisabled?: boolean;
  /** Set when a resolver returned `ambiguous` or `needs_total` (§7). */
  needsClarification?: boolean;
  /** For `findDuplicate`. */
  subject?: string | null;
  at?: Date | null;
}

export interface PlannedAction {
  tool: AgentToolName;
  intentType: string | null;
  intentIndex: number | null;
  tier: AgentTier;
  capability: AgentCapability;
  params: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  state: ActionState;
  code: PolicyCode;
  /** One sentence for the review queue. */
  reason: string;
  score: number;
  band: ScoreBand;
  order: number;
  /** Idempotency keys this must run after. §10's "execute in a defined order". */
  dependsOn: readonly string[];
}

export interface PlanInput {
  callId: string;
  gate: GateDecision;
  mode: AgentMode;
  candidates: readonly ActionCandidate[];
  /** Existing items, for `findDuplicate`. */
  existing?: readonly ExistingItem[];
  /** §4/§decisions 4.7: roles were inferred, so the run is capped at suggest. */
  rolesInferred?: boolean;
  /** Per-intent thresholds the org overrode. */
  thresholds?: Readonly<Record<string, { auto?: number; review?: number }>>;
}

export interface Plan {
  actions: readonly PlannedAction[];
  /** The effective mode after every cap. Stored on the run. */
  effectiveMode: AgentMode;
  /** Why the mode was capped, if it was. */
  modeCapReason: string | null;
}

/**
 * THE PLANNER. One function, because the ORDER of its steps is the policy.
 *
 * ── THE STEPS, AND WHY EACH IS WHERE IT IS ──────────────────────────────────
 *
 *  1. CAP THE MODE. `roles_inferred` caps the run at `suggest` before anything
 *     else is decided (decisions §4.7). Speaker attribution is what separates
 *     "the customer agreed" from "the telecaller offered", and a run that had
 *     to guess which voice was which has not earned autonomy on anything.
 *
 *  2. DROP WHAT THE GATE DOES NOT PERMIT. Before policy, before scoring,
 *     before dedupe - §3A.4 requires the planner to "remove actions whose
 *     capability is not enabled", and doing it first means no later step can
 *     accidentally resurrect one.
 *
 *  3. HONOUR SUPERSESSION. §6: "the last confirmed statement wins; earlier ones
 *     are recorded as superseded." Recorded, so the action is retained in the
 *     plan as `recorded` rather than deleted - an audit of "why did it book
 *     17:00 when they first said 15:00" needs both.
 *
 *  4. POLICY. Whatever the caller's checks concluded.
 *
 *  5. DEDUPE. Within the plan by idempotency key, then against what already
 *     exists (`findDuplicate`).
 *
 *  6. BAND AND AUTONOMY. `scoreBandFor` then `mayAutoExecute`, which is where
 *     T3-never and the mode cap and the org's per-intent switch meet.
 *
 *  7. ORDER AND DEPEND. §10's `order`, and the one real dependency: a
 *     customer-visible message runs after the thing it is about.
 */

/**
 * Why a tool could not be keyed, said to the person who has to deal with it.
 *
 * One sentence per tool rather than a generic line, because the generic line
 * ("a detail was missing") is the one a reviewer cannot act on - and these are
 * all cases where the next step is obvious once the missing thing is named.
 */
function missingDetailReason(tool: AgentToolName): string {
  switch (tool) {
    case "reschedule_slot":
      return "There is no appointment open for this customer to move.";
    case "cancel_slot":
      return "There is no appointment open for this customer to cancel.";
    case "book_slot":
      return "Nothing was free in the time the customer asked for, so no slot could be proposed.";
    case "update_callback":
    case "reassign_callback":
      return "There is no call-back open for this customer to change.";
    case "log_payment_promise":
      return "The customer promised to pay but the amount or the date could not be made out.";
    case "update_contact":
      return "It was not clear which detail changed, or what it changed to.";
    case "create_referral_lead":
      return "A referral was mentioned but no number for the person came through.";
    default:
      return "Something this needs was not said clearly enough to act on.";
  }
}

export function planActions(input: PlanInput): Plan {
  const { callId, gate } = input;

  // ── 1. mode ──────────────────────────────────────────────────────────────
  let effectiveMode = gate.enabled ? gate.mode : "off";
  let modeCapReason: string | null = null;
  if (input.rolesInferred && (effectiveMode === "assisted" || effectiveMode === "auto")) {
    effectiveMode = "suggest";
    modeCapReason =
      "who was speaking had to be worked out rather than being given, so everything on this call waits for a person";
  }

  const actions: PlannedAction[] = [];
  const seenKeys = new Set<string>();

  for (const candidate of input.candidates) {
    const spec = toolSpec(candidate.tool);
    const tier = spec.tier;
    // The TOOL's capability, not the intent's, and they can differ for a custom
    // intent: an org-defined intent mapped to `create_followup` is gated on
    // `tasks` whatever its own entry claims. The tool is what actually runs, so
    // the tool is what the gate is asked about.
    const capability =
      capabilityForIntent(candidate.intentType ?? "", spec.name) ?? spec.capability;

    let key: string;
    try {
      key = idempotencyKey(candidate.tool, callId, candidate.keyParts);
    } catch (error) {
      // A missing key part means a detail the tool cannot run without was
      // never established - most often the appointment a reschedule would
      // move, when the lead has none open. The action is retained, blocked and
      // visible rather than dropped, because "move my appointment" with no
      // appointment is exactly the sort of thing a person should look at.
      //
      // The REASON is written for that person; the exception's own message
      // names an idempotency key part and means nothing to them. It goes to
      // the logs through the executor instead.
      actions.push({
        tool: candidate.tool,
        intentType: candidate.intentType,
        intentIndex: candidate.intentIndex,
        tier,
        capability,
        params: candidate.params,
        idempotencyKey: `${callId}:${candidate.tool}:unkeyed:${candidate.intentIndex ?? 0}`,
        state: "blocked",
        code: "missing_detail",
        reason: missingDetailReason(candidate.tool),
        score: candidate.score,
        band: "record",
        order: spec.order,
        dependsOn: [],
      });
      void error;
      continue;
    }

    const band = scoreBandFor(
      (candidate.intentType ?? "disposition_update") as AgentIntentType,
      candidate.score,
      input.thresholds?.[candidate.intentType ?? ""],
    );

    const push = (state: ActionState, code: PolicyCode, reason: string) => {
      actions.push({
        tool: candidate.tool,
        intentType: candidate.intentType,
        intentIndex: candidate.intentIndex,
        tier,
        capability,
        params: candidate.params,
        idempotencyKey: key,
        state,
        code,
        reason,
        score: candidate.score,
        band,
        order: spec.order,
        dependsOn: [],
      });
    };

    // ── 2. the gate ────────────────────────────────────────────────────────
    if (!gate.enabled) {
      push("blocked", "blocked_by_gate", "The assistant is switched off for this person.");
      continue;
    }
    if (!gateAllows(gate, capability)) {
      push(
        "blocked",
        "capability_off",
        `"${capability.replace(/_/g, " ")}" is not switched on for this person.`,
      );
      continue;
    }

    if (candidate.intentDisabled) {
      push("blocked", "intent_disabled", "Your workspace has this kind of action switched off.");
      continue;
    }

    // ── 3. supersession ────────────────────────────────────────────────────
    if (candidate.superseded) {
      push(
        "recorded",
        "superseded",
        "The customer changed their mind later in the call, so this was kept for the record only.",
      );
      continue;
    }

    // ── 4. policy ──────────────────────────────────────────────────────────
    if (!candidate.policy.ok) {
      push("blocked", candidate.policy.code, candidate.policy.message);
      continue;
    }

    // ── 5. duplicates ──────────────────────────────────────────────────────
    if (seenKeys.has(key)) {
      // Two intents in one call that resolve to exactly the same action. The
      // second is not a second booking; it is the same one said twice.
      push("recorded", "duplicate", "The same thing was asked for twice on this call.");
      continue;
    }
    const existing = findDuplicate(
      candidate.tool,
      candidate.subject ?? null,
      candidate.at ?? null,
      input.existing ?? [],
    );
    if (existing) {
      push("blocked", "duplicate", "This already exists, so nothing new was created.");
      continue;
    }
    seenKeys.add(key);

    // ── 6. clarification, band, autonomy ───────────────────────────────────
    if (candidate.needsClarification) {
      // §7.1: "ambiguous results create a clarification task, never a guess."
      push(
        "pending_review",
        "needs_clarification",
        "What the customer meant could be read more than one way, so somebody needs to confirm it.",
      );
      continue;
    }

    if (band === "record") {
      push("recorded", "needs_review", "The assistant was not confident enough to suggest this.");
      continue;
    }

    const auto = mayAutoExecute(
      (candidate.intentType ?? "disposition_update") as AgentIntentType,
      {
        mode: effectiveMode,
        band,
        orgEnabledAuto: candidate.orgEnabledAuto ?? false,
        accuracyGateMet: candidate.accuracyGateMet ?? false,
      },
    );

    if (auto.auto) {
      push("planned", "ok", "");
      continue;
    }

    push("pending_review", reasonCodeFor(auto.reason), autoReasonMessage(auto.reason, tier));
  }

  // ── 7. order and dependencies ────────────────────────────────────────────
  actions.sort(
    (a, b) =>
      a.order - b.order ||
      (a.intentIndex ?? -1) - (b.intentIndex ?? -1) ||
      a.idempotencyKey.localeCompare(b.idempotencyKey),
  );

  const executable = actions.filter((a) => a.state === "planned" || a.state === "pending_review");
  const withDeps = actions.map((action) => {
    if (!toolSpec(action.tool).customerVisible) return action;
    // §10: "check availability -> book -> send confirmation". A message runs
    // after every non-message action that is going to happen, which is the
    // general form of that rule and does not need a per-pair table.
    if (action.tool !== "send_message" && action.tool !== "send_information") return action;
    const dependsOn = executable
      .filter((other) => other.order < action.order)
      .map((other) => other.idempotencyKey);
    return dependsOn.length > 0 ? { ...action, dependsOn } : action;
  });

  return { actions: withDeps, effectiveMode, modeCapReason };
}

function reasonCodeFor(reason: ReturnType<typeof mayAutoExecute>["reason"]): PolicyCode {
  switch (reason) {
    case "tier_t3_never":
    case "intent_not_auto_eligible":
      return "tier_requires_human";
    case "mode_caps_tier":
    case "org_has_not_enabled":
    case "accuracy_gate_not_met":
    case "band_below_auto":
    case "auto":
      return "needs_review";
  }
}

function autoReasonMessage(
  reason: ReturnType<typeof mayAutoExecute>["reason"],
  tier: AgentTier,
): string {
  switch (reason) {
    case "tier_t3_never":
      return "This needs a person to decide. The assistant never does it by itself.";
    case "intent_not_auto_eligible":
      return "This always waits for a person, whatever the settings say.";
    case "mode_caps_tier":
      return tier === "T2"
        ? "Anything the customer would see waits for a person on your current setting."
        : "Your current setting puts everything in front of a person first.";
    case "org_has_not_enabled":
      return "You have not switched this kind of action to automatic.";
    case "accuracy_gate_not_met":
      return "This kind of action has not been accurate enough yet to run on its own.";
    case "band_below_auto":
      return "The assistant was not confident enough to do this by itself.";
    case "auto":
      return "";
  }
}

/**
 * §10's executor rule, as a function the executor calls per action.
 *
 * "On partial failure, keep completed steps, mark failed ones, create a review
 * task, and never leave a customer-visible half-done state."
 *
 * Returns the actions that must now be SKIPPED because something they depend on
 * did not happen. Skipped, not failed: a confirmation message for a booking
 * that did not happen is not a failed message, it is a message that must never
 * be sent.
 */
export function cascadeSkips(
  plan: readonly PlannedAction[],
  failedKeys: readonly string[],
): readonly PlannedAction[] {
  const failed = new Set(failedKeys);
  const skipped: PlannedAction[] = [];
  // Iterate to a fixpoint: a message depending on a booking depending on a
  // hold. Bounded by the plan's own length.
  for (let pass = 0; pass <= plan.length; pass += 1) {
    let changed = false;
    for (const action of plan) {
      if (failed.has(action.idempotencyKey)) continue;
      if (action.dependsOn.some((key) => failed.has(key))) {
        failed.add(action.idempotencyKey);
        skipped.push(action);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return skipped;
}

/**
 * §10's "compensating action where applicable", looked up from the tool table.
 *
 * Returns the tool that undoes `tool`, or null where nothing can. Null is the
 * honest answer for a message: a sent WhatsApp cannot be unsent, which is the
 * whole reason messages run last and default to needing a person.
 */
export function compensationFor(tool: AgentToolName): AgentToolName | null {
  return toolSpec(tool).compensatedBy ?? null;
}

/**
 * §12's SLA timer: when does a pending review item escalate?
 *
 * §18: four WORKING hours. Working, not wall-clock - an item created at 18:00
 * on a Friday must not escalate at 22:00 on a Friday, which is the behaviour a
 * naive `+4h` gives and the reason this walks the working windows.
 */
export function reviewSlaDeadline(
  createdAt: Date,
  workingHours: number,
  rules: Pick<BookingRules, "workingWindows" | "closedDays" | "timeZone">,
): Date {
  const zone = rules.timeZone;
  let remaining = Math.max(0, Math.round(workingHours * 60));
  if (remaining === 0) return createdAt;

  // Walk day by day in CIVIL dates rather than by adding milliseconds to a
  // cursor. The arithmetic-on-a-cursor version had to reconstruct the zone's
  // offset to find "midnight tomorrow", which is the one calculation
  // `wallTimeToInstant` exists to do correctly across a DST change - so the day
  // is a `YYYY-MM-DD` throughout and every instant is built from one.
  let dayKey = dayKeyIn(createdAt, zone)!;
  let fromMinute = minuteOfDay(createdAt, zone);

  for (let day = 0; day < 400; day += 1) {
    const windows = rules.closedDays.includes(dayKey)
      ? []
      : [...rules.workingWindows]
          .filter((w) => w.weekday === weekdayOfDayKey(dayKey))
          .sort((a, b) => a.startMinute - b.startMinute);

    for (const window of windows) {
      if (window.endMinute <= fromMinute) continue;
      const start = Math.max(fromMinute, window.startMinute);
      const available = window.endMinute - start;
      if (available >= remaining) {
        return instantAtMinute(dayKey, start + remaining, zone);
      }
      remaining -= available;
      fromMinute = window.endMinute;
    }

    dayKey = shiftDateKey(dayKey, 1);
    fromMinute = 0;
  }

  // An org with no working windows at all. Returning the creation instant means
  // "already due", which puts the item in front of a person immediately -
  // the fail-safe direction for a review queue.
  return createdAt;
}

function weekdayOfDayKey(dayKey: string): number {
  return zonedParts(`${dayKey}T12:00:00Z`, "UTC")?.weekday ?? 1;
}

function instantAtMinute(dayKey: string, minuteOfDayValue: number, zone: string): Date {
  // A minute past midnight rolls the day, which happens when a working window
  // is configured to end at 24:00.
  const dayShift = Math.floor(minuteOfDayValue / (24 * 60));
  const day = dayShift === 0 ? dayKey : shiftDateKey(dayKey, dayShift);
  const minute = minuteOfDayValue - dayShift * 24 * 60;
  const wall = `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
    minute % 60,
  ).padStart(2, "0")}`;
  return new Date(wallTimeToInstant(wall, zone) ?? `${wall}:00Z`);
}
