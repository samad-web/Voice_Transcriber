import {
  AMOUNT_RESOLVER_VERSION,
  type ActionCandidate,
  type AgentIntentType,
  type AgentToolName,
  type AmountResolution,
  type GateDecision,
  type PolicyResult,
  RESOLVER_VERSION,
  type TimeResolution,
  type UnderstandingIntent,
  bestInstant,
  checkContactPolicy,
  checkPermission,
  checkSlot,
  idempotencyKey,
  intentSpec,
  isActionable,
  isAmountActionable,
  proposeSlots,
  resolveAmountPhrase,
  resolveTimePhrase,
  scoreIntent,
  toolSpec,
  verifyIntents,
} from "@aura/shared";
import type { PolicySideContext } from "./context";

/**
 * §7 - THE RESOLVERS, AND THE CANDIDATES THEY PRODUCE
 * (Build docs/transcript-agent-build-plan §7, §8).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The seam between "the model said something" and "the planner has something
 * to decide about". Per intent it:
 *
 *   1. verifies the evidence against the stored transcript (§6);
 *   2. turns `when_text`/`by_text` into an instant, a window or a refusal,
 *      with the DIRECTION taken from the intent catalog (§7.1);
 *   3. turns `amount_text` into an amount against known totals (§7.2);
 *   4. cross-checks the resolved values against the CRM (§7.3);
 *   5. combines everything into §8.3's final score, components and all;
 *   6. runs §8.1's policy checks;
 *   7. emits an `ActionCandidate` the planner can rank and order.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE MODEL'S OWN TENSE IS ADVISORY; THE CATALOG'S DIRECTION IS NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §7.1 says "kal" must be settled from "verb tense and context in the
 * evidence". `INTENT_CATALOG`'s `timeDirection` is that context, in code: a
 * `callback_request` cannot be about yesterday, and no reading of the verb
 * should be able to make it so. The model's `tense` field is used only where
 * the catalog has no opinion.
 *
 * That is why the resolver itself stays honest (`tense: null` -> ambiguous)
 * and the direction is applied HERE. A resolver that assumed the future would
 * be wrong for a `complaint`.
 */

export const RESOLVERS_VERSION = `${RESOLVER_VERSION}+${AMOUNT_RESOLVER_VERSION}`;

export interface ResolvedIntent {
  index: number;
  intent: UnderstandingIntent;
  type: string;
  time: TimeResolution | null;
  amount: AmountResolution | null;
  /** The slot the booking would take, where one could be proposed. */
  slot: { start: Date; end: Date } | null;
  /** §7.3's cross-checks. Null when none applied. */
  crossChecksPassed: boolean | null;
  crossCheckNotes: readonly string[];
  score: number;
  scoreComponents: Readonly<Record<string, number>>;
  /** §7's "ambiguous results create a clarification task, never a guess". */
  needsClarification: boolean;
  clarification: string | null;
}

export interface ResolveInput {
  intents: readonly UnderstandingIntent[];
  /** The REDACTED transcript - the text evidence is verified against. */
  transcript: string;
  reference: Date;
  policy: PolicySideContext;
  rolesInferred: boolean;
  sttConfidence: number | null;
  chunked: boolean;
  injectionDetected: boolean;
  /** The model's own reading of the verb. Advisory - see the header. */
  modelTense: "past" | "future" | null;
}

export interface ResolveResult {
  resolved: readonly ResolvedIntent[];
  /** §6: intents whose quotes were not found. Stored, never acted on. */
  discarded: readonly { intent: UnderstandingIntent; quote: string; ratio: number }[];
}

/** §6 then §7, per intent. */
export function resolveIntents(input: ResolveInput): ResolveResult {
  // §6's MUST, first: "discard intents whose quotes are not found in it."
  // Before resolution, because resolving the slots of a fabricated intent is
  // work spent on something that is about to be thrown away - and because an
  // invented quote is the one signal that the whole intent is invented.
  const verified = verifyIntents(input.intents, input.transcript);

  const resolved = verified.kept.map((intent, index): ResolvedIntent => {
    const spec = knownSpec(intent.type);
    const notes: string[] = [];

    // ── §7.1: the time ───────────────────────────────────────────────────
    const phrase = intent.slots.when_text ?? intent.slots.by_text ?? null;
    const time = phrase
      ? resolveTimePhrase(phrase, {
          reference: input.reference,
          timeZone: input.policy.timeZone,
          dayparts: input.policy.dayparts,
          dayStartMinute: input.policy.callbackPolicy.callingStartMinute,
          dayEndMinute: input.policy.callbackPolicy.callingEndMinute,
          workingWeekdays: input.policy.callbackPolicy.callingWeekdays,
          holidays: input.policy.callbackPolicy.holidays,
          // The catalog's direction wins; the model's tense is the fallback.
          tense: spec?.timeDirection ?? input.modelTense,
        })
      : null;

    // ── §7.2: the amount ─────────────────────────────────────────────────
    const amount = intent.slots.amount_text
      ? resolveAmountPhrase(intent.slots.amount_text, {
          totalsMinor: input.policy.amountTotalsMinor,
        })
      : null;

    // ── §8.1: a bookable slot, from a window ─────────────────────────────
    //
    // §7.1: "windows are used to propose slots from availability." The FIRST
    // candidate is taken, because the customer who said "after 5" is available
    // from 5 - the same argument `bestInstant` makes.
    //
    // RESCHEDULE TOO, not only a new booking. Moving an appointment is
    // booking it at a different time, so it owes the same availability check -
    // and without a proposed slot `reschedule_slot` has no `startsAt`, which
    // means no idempotency key, which means every reschedule a customer asks
    // for is blocked. §9 lists the intent; this is what makes it reachable.
    let slot: { start: Date; end: Date } | null = null;
    if (
      (spec?.tool === "book_slot" || spec?.tool === "reschedule_slot") &&
      time &&
      isActionable(time)
    ) {
      const windowStart = new Date(time.kind === "exact" ? time.at : time.start);
      const windowEnd = new Date(time.kind === "exact" ? time.at : time.end);
      const candidates = proposeSlots(
        { start: windowStart, end: windowEnd },
        input.policy.busy,
        input.policy.bookingRules,
        input.reference,
        4,
      );
      slot = candidates[0] ?? null;
      if (!slot) notes.push("nothing in the time they asked for was free");
    }

    // ── §7.3: the cross-checks ───────────────────────────────────────────
    const cross = crossCheck(intent, {
      time,
      amount,
      policy: input.policy,
      notes,
      reference: input.reference,
    });

    // ── §7's clarification, which is NOT a failure ───────────────────────
    //
    // "Ambiguous results create a clarification task, never a guess."
    const clarification = clarificationFor(intent, time, amount, spec?.tool ?? null);

    const { score, components } = scoreIntent({
      modelConfidence: intent.confidence,
      status: intent.status,
      evidenceRatio: verified.ratios.get(intent) ?? 1,
      // `null` where no resolver applied, so the score does not penalise an
      // objection for having no date.
      resolverUnambiguous: time === null ? null : isActionable(time),
      crossChecksPassed: cross,
      rolesInferred: input.rolesInferred,
      sttConfidence: input.sttConfidence,
      chunked: input.chunked,
      injectionDetected: input.injectionDetected,
    });

    return {
      index,
      intent,
      type: intent.type,
      time,
      amount,
      slot,
      crossChecksPassed: cross,
      crossCheckNotes: notes,
      score,
      scoreComponents: components,
      needsClarification: clarification !== null,
      clarification,
    };
  });

  return { resolved, discarded: verified.discarded };
}

/**
 * §7.3: "validate extracted values against known data (phone numbers, names,
 * amounts versus the deal). A mismatch lowers confidence and can force review.
 * STT errors on numbers and names are the costliest, so cross-check them
 * first."
 *
 * Returns `null` when nothing could be checked - which is NOT a pass. The
 * score treats a null as "no signal" and omits the component, rather than as
 * a success, so an intent with nothing to check against does not score higher
 * than one that checked out.
 */
function crossCheck(
  intent: UnderstandingIntent,
  ctx: {
    time: TimeResolution | null;
    amount: AmountResolution | null;
    policy: PolicySideContext;
    notes: string[];
    /** The call's END. See the past-booking check below for why it is here. */
    reference: Date;
  },
): boolean | null {
  const checks: boolean[] = [];

  // ── numbers first, because §7.3 says they are the costliest ────────────
  if (intent.slots.field === "phone" && intent.slots.value_text) {
    const digits = intent.slots.value_text.replace(/\D/g, "");
    // A plausible Indian mobile is ten digits, optionally with a country
    // prefix. Anything else is an ASR artefact, and writing it over a lead's
    // number would make them unreachable - which is why `update_contact`
    // records a NOTE rather than overwriting, as well.
    const plausible = digits.length === 10 || digits.length === 12 || digits.length === 11;
    checks.push(plausible);
    if (!plausible) {
      ctx.notes.push(`"${intent.slots.value_text}" is not a plausible phone number`);
    }
  }

  // ── amounts versus the deal ────────────────────────────────────────────
  if (ctx.amount && isAmountActionable(ctx.amount)) {
    const amountMinor = ctx.amount.kind === "exact" ? ctx.amount.amountMinor : ctx.amount.amountMinor;
    const biggestKnown = Math.max(0, ...ctx.policy.amountTotalsMinor);
    if (biggestKnown > 0) {
      // An amount wildly above anything this lead is worth is almost always a
      // scale error - "pachaas" heard as "pachaas hazaar", or a stray zero.
      // Ten times is deliberately generous: a customer genuinely upgrading is
      // real, and the penalty is a lower score rather than a refusal.
      const plausible = amountMinor <= biggestKnown * 10;
      checks.push(plausible);
      if (!plausible) {
        ctx.notes.push(
          `the amount is far more than anything recorded on this lead - it may be a mis-hearing`,
        );
      }
    }
  }

  // ── a booking before the call ended is not a booking ───────────────────
  //
  // Against `reference` - THE CALL'S END - and never `Date.now()`.
  //
  // This cost the whole module its accuracy once. Every resolver in the
  // feature resolves relative to the call's end (`time-phrases.ts` opens with
  // why), so a transcript processed LATE still reads "kal subah 11 baje" as
  // the morning after the call, correctly. A cross-check against the wall
  // clock then calls that correct answer implausible, multiplies the score by
  // 0.6, and the callback drops below the review threshold - so it is filed
  // as `recorded` and nobody is ever told about it.
  //
  // "Late" is not an edge case here: §3A.5's backfill runs over SEVEN DAYS of
  // past calls by design, a reprocess can be weeks after the fact, and a
  // handset that was out of signal uploads whenever it next has some. All
  // three would have produced almost nothing, silently, and the only visible
  // symptom would have been a quiet queue.
  //
  // The hour of grace stays: a customer saying "in ten minutes" near the end
  // of a long call can legitimately land just before the recording stopped.
  if (ctx.time && ctx.time.kind === "exact") {
    const at = new Date(ctx.time.at);
    const plausible = at.getTime() > ctx.reference.getTime() - 60 * 60_000;
    checks.push(plausible);
    if (!plausible) ctx.notes.push("the time worked out to something already past");
  }

  return checks.length === 0 ? null : checks.every(Boolean);
}

/**
 * §7's clarification, phrased for the person who will read it.
 *
 * `null` means "nothing to ask". Everything else is a sentence a telecaller
 * can act on without opening the transcript - which is the difference between
 * a review queue people work through and one they ignore.
 */
function clarificationFor(
  intent: UnderstandingIntent,
  time: TimeResolution | null,
  amount: AmountResolution | null,
  tool: AgentToolName | null,
): string | null {
  if (time && time.kind === "ambiguous") {
    return `"${intent.slots.when_text ?? intent.slots.by_text}" could mean more than one time (${time.reason}). Confirm which.`;
  }
  // A tool that NEEDS a time and has none. An objection with no date is fine;
  // a booking with no date is not.
  if (tool && NEEDS_A_TIME.has(tool) && (!time || !isActionable(time))) {
    return intent.slots.when_text
      ? `"${intent.slots.when_text}" could not be read as a time. Set it by hand.`
      : "No time was given for this. Set it by hand.";
  }
  if (amount && amount.kind === "needs_total") {
    return `The customer gave a share rather than an amount ("${intent.slots.amount_text}"), and there is no total on this lead to take it of.`;
  }
  if (amount && amount.kind === "unresolved" && intent.slots.amount_text) {
    return `"${intent.slots.amount_text}" could not be read as an amount.`;
  }
  return null;
}

/**
 * The tools whose whole purpose is a time. A callback with no time is not a
 * callback - it is a note - and §10A.6's vague rules supply a time rather than
 * letting one through without.
 */
const NEEDS_A_TIME = new Set<AgentToolName>([
  "book_slot",
  "reschedule_slot",
  "schedule_callback",
  "log_payment_promise",
]);

// ════════════════════════════════════════════════════════════════════════════
//  §8 - the candidates
// ════════════════════════════════════════════════════════════════════════════

export interface CandidateInput {
  callId: string;
  resolved: readonly ResolvedIntent[];
  policy: PolicySideContext;
  gate: GateDecision;
  /** The acting identity, for §8.1's permission check. */
  identity: {
    userId: string | null;
    telecallerId: string | null;
    grants: readonly string[];
    authorityLimitMinor: number | null;
  };
  reference: Date;
  /** The disposition and summary the run produced, for the T0 records. */
  disposition: string | null;
  summary: string | null;
  qualitySignals: Record<string, unknown> | null;
  /** The intent ids, once the run's intents are written. */
  intentIds?: ReadonlyMap<number, string>;
}

/**
 * Every intent plus the T0 records, as planner candidates.
 *
 * ── THE T0 RECORDS ARE SYNTHESISED, NOT EXTRACTED ────────────────────────
 *
 * §8.2's T0 row is "call summary, disposition, sentiment, quality signals" and
 * none of those is an INTENT - they are properties of the run. So the planner
 * is handed them as candidates with no intent behind them, which is why
 * `ActionCandidate.intentType` is nullable.
 *
 * They go FIRST in the list, which matters only for the stable ordering the
 * planner applies on top: a summary is the cheapest, most reversible thing the
 * agent does, and it landing before a booking is attempted means a call whose
 * booking fails still has a readable summary on it.
 */
export function buildCandidates(input: CandidateInput): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];

  // ── T0: the records ──────────────────────────────────────────────────────
  if (input.summary) {
    candidates.push({
      intentType: null,
      intentIndex: null,
      tool: "write_call_summary",
      params: { summary: input.summary },
      keyParts: {},
      // 1, not the model's confidence: a summary is what the model said, and
      // "how sure are you that you said this" is not a question. The §8.3
      // score exists to gate ACTIONS, and a summary is a record.
      score: 1,
      policy: OK,
    });
  }
  if (input.disposition) {
    candidates.push({
      intentType: "disposition_update",
      intentIndex: null,
      tool: "set_disposition",
      params: { disposition: input.disposition },
      keyParts: {},
      score: 1,
      policy: OK,
    });
  }
  if (input.qualitySignals && Object.keys(input.qualitySignals).length > 0) {
    candidates.push({
      intentType: null,
      intentIndex: null,
      tool: "record_quality_signals",
      params: { signals: input.qualitySignals },
      keyParts: {},
      score: 1,
      policy: OK,
    });
  }

  // ── the intents ──────────────────────────────────────────────────────────
  //
  // THE T0 RECORDS ABOVE WIN WHERE BOTH COVER THE SAME TOOL.
  //
  // A `disposition_update` intent maps to `set_disposition`, which the run has
  // already synthesised from its own disposition; an `objection` maps to
  // `record_quality_signals`, likewise. Both key on the same value, so the
  // planner's duplicate check caught the second and filed it `recorded` -
  // correct, audited, and a junk row on almost every call, since most calls
  // produce a disposition reading.
  //
  // So the intent-derived candidate is skipped where a record already covers
  // the tool. The RECORD is the one to keep: it carries the run's own
  // disposition and summary rather than one intent's reading of them, and it
  // scores 1 because "how sure are you that you said this" is not a question.
  const recordedTools = new Set(candidates.map((candidate) => candidate.tool));

  for (const item of input.resolved) {
    const spec = knownSpec(item.type);
    const tool = spec?.tool ?? customTool(item.type, input.policy);
    if (!tool) continue;
    if (recordedTools.has(tool)) continue;

    const cfg = input.policy.intentConfig.get(item.type);
    const { params, subject, at } = paramsFor(item, tool, input);

    candidates.push({
      intentType: item.type,
      intentIndex: item.index,
      tool,
      params,
      keyParts: keyPartsFor(tool, item, params),
      score: item.score,
      policy: policyFor(tool, item, input),
      superseded: item.intent.superseded ?? false,
      orgEnabledAuto: cfg?.autoExecute ?? false,
      // §13.3's gate, read from the stored measurement the eval sweep writes.
      // `null` precision while `auto_execute` is true DEMOTES - which
      // `autonomyDecision` decides and the sweep applies; here it simply fails
      // the gate, which is the same answer from the planner's side.
      accuracyGateMet:
        cfg?.measuredPrecision !== null &&
        cfg?.measuredPrecision !== undefined &&
        cfg.measuredPrecision >= 0.98 &&
        cfg.reviewedCases >= 200,
      intentDisabled: cfg ? !cfg.enabled : false,
      needsClarification: item.needsClarification,
      subject,
      at,
    });
  }

  return candidates;
}

const OK: PolicyResult = { ok: true, code: "ok", message: "" };

function knownSpec(type: string) {
  try {
    return intentSpec(type as AgentIntentType);
  } catch {
    return null;
  }
}

/** An org's own intent maps to whatever tool it was configured with. */
function customTool(type: string, policy: PolicySideContext): AgentToolName | null {
  const custom = policy.customIntents.find((entry) => entry.key === type && entry.enabled);
  return custom?.tool ?? null;
}

/** §8.1's checks, in one place per candidate. */
function policyFor(
  tool: AgentToolName,
  item: ResolvedIntent,
  input: CandidateInput,
): PolicyResult {
  // §8.1's opt-out and consent. FIRST, because it is the one check that must
  // never be reachable past - §14: "cannot be overridden by the agent."
  const contact = checkContactPolicy(
    tool,
    input.policy.contactPolicy,
    tool === "send_message" || tool === "send_information" ? "whatsapp" : undefined,
  );
  if (!contact.ok) return contact;

  // §8.1's permissions and authority limits. The agent acts AS the telecaller.
  const amountMinor =
    item.amount && isAmountActionable(item.amount) ? item.amount.amountMinor : null;
  const permission = checkPermission(
    tool,
    {
      userId: input.identity.userId,
      telecallerId: input.identity.telecallerId,
      grants: input.identity.grants,
      authorityLimitMinor: input.identity.authorityLimitMinor,
    },
    requiredGrant(tool),
    amountMinor,
  );
  if (!permission.ok) return permission;

  // §8.1's availability and business rules, for a booking.
  if (tool === "book_slot") {
    if (!item.slot) {
      return {
        ok: false,
        code: "no_slot_available",
        message:
          item.crossCheckNotes[0] ?? "nothing in the time the customer asked for was free",
      };
    }
    return checkSlot(
      item.slot,
      input.policy.busy,
      input.policy.bookingRules,
      input.reference,
      input.policy.bookingsToday,
    );
  }

  return OK;
}

/**
 * The permission-grid grant each tool needs.
 *
 * `null` where the grid has no object for it. That is not a hole: those tools
 * write to the CALL and the RUN, which §permissions.ts deliberately keeps off
 * the grid ("a fourth axis over one object is how 'why can Priya not read this
 * call' acquires four possible answers").
 */
/** Exported for the golden replay, which needs every grant the tools ask for. */
export function requiredGrant(tool: AgentToolName): string | null {
  switch (tool) {
    case "book_slot":
      return "appointment:create";
    case "reschedule_slot":
    case "cancel_slot":
      return "appointment:edit";
    case "schedule_callback":
      return "callback:create";
    case "update_callback":
    case "reassign_callback":
      return "callback:edit";
    case "create_followup":
    case "register_complaint":
    case "request_refund_review":
    case "create_payment_link":
    case "send_message":
    case "send_information":
      return "task:create";
    case "create_referral_lead":
      return "lead:view";
    case "update_contact":
      return "lead:edit";
    case "log_payment_promise":
      return "finance:edit";
    case "mark_do_not_contact":
      return "dnc:create";
    default:
      return null;
  }
}

/** The tool's own params, plus the duplicate-check subject (§8.1). */
function paramsFor(
  item: ResolvedIntent,
  tool: AgentToolName,
  input: CandidateInput,
): { params: Record<string, unknown>; subject: string | null; at: Date | null } {
  const slots = item.intent.slots;
  const due = item.time ? bestInstant(item.time) : null;

  switch (tool) {
    case "schedule_callback":
      return {
        params: {
          requestedText: slots.when_text ?? slots.by_text ?? "",
          reference: input.reference.toISOString(),
          preferredLanguage: null,
          evidence: item.intent.evidence,
          intentId: input.intentIds?.get(item.index) ?? null,
          dueAt: due?.toISOString() ?? null,
        },
        // The CONTACT is the duplicate subject, not the time: §10A.2 allows
        // one active callback per lead and contact, whatever time each asked
        // for.
        subject: slots.contact_text ?? "",
        at: due,
      };
    case "book_slot":
      return {
        params: {
          startsAt: item.slot?.start.toISOString() ?? null,
          endsAt: item.slot?.end.toISOString() ?? null,
          appointmentType: slots.subject_text ? "consultation" : "consultation",
          location: null,
          assignedUserId: input.identity.userId,
        },
        subject: item.slot?.start.toISOString() ?? null,
        at: item.slot?.start ?? null,
      };
    case "reschedule_slot": {
      // §9's `reschedule_appointment`. The appointment to move comes from the
      // CONTEXT, not from the model: `buildContext` loads the lead's open
      // bookings as `existing` entries whose `idempotencyKey` is the
      // appointment's own id (context.ts's appointments subquery), so the id
      // is already in hand and the model is never asked for one it could get
      // wrong.
      //
      // Nothing open to move leaves `appointmentId` null, the key part
      // missing, and the action blocked with that said plainly - which is the
      // right outcome: "move my appointment" when there is no appointment is
      // a thing for a person to look at.
      const target = openAppointment(input);
      return {
        params: {
          appointmentId: target?.id ?? null,
          startsAt: item.slot?.start.toISOString() ?? null,
          endsAt: item.slot?.end.toISOString() ?? null,
        },
        subject: target?.id ?? null,
        at: item.slot?.start ?? null,
      };
    }
    case "cancel_slot": {
      const target = openAppointment(input);
      return {
        params: {
          appointmentId: target?.id ?? null,
          reason: slots.reason_text ?? "the customer cancelled this on a call",
        },
        subject: target?.id ?? null,
        at: null,
      };
    }
    case "log_payment_promise":
      return {
        params: {
          amountMinor:
            item.amount && isAmountActionable(item.amount) ? item.amount.amountMinor : null,
          promisedOn: due ? due.toISOString().slice(0, 10) : null,
        },
        subject: null,
        at: due,
      };
    case "create_followup":
      return {
        params: {
          title: followUpTitle(item),
          notes: quotedEvidence(item),
          dueAt: due?.toISOString() ?? null,
          assigneeUserId: input.identity.userId,
          priority: item.intent.status === "confirmed" ? "high" : "normal",
        },
        // The TITLE is the duplicate subject: two "send the price list"
        // follow-ups on one lead are one follow-up said twice.
        subject: followUpTitle(item).toLowerCase(),
        at: due,
      };
    case "update_contact":
      return {
        params: { field: slots.field ?? "phone", value: slots.value_text ?? "" },
        subject: `${slots.field ?? "phone"}:${slots.value_text ?? ""}`,
        at: null,
      };
    case "create_referral_lead":
      return {
        params: { name: slots.contact_text ?? null, phone: slots.value_text ?? slots.contact_text ?? "" },
        subject: slots.value_text ?? slots.contact_text ?? null,
        at: null,
      };
    case "set_disposition":
      return {
        params: { disposition: slots.disposition_text ?? input.disposition ?? "" },
        subject: null,
        at: null,
      };
    case "mark_do_not_contact":
      return { params: { channel: "call", peerAddress: "" }, subject: null, at: null };
    case "send_message":
    case "send_information":
      return {
        params: { template: templateFor(item), channel: slots.channel ?? "whatsapp" },
        subject: templateFor(item),
        at: null,
      };
    case "escalate_to_human":
      return {
        params: { reason: slots.reason_text ?? "the customer asked for a manager" },
        subject: null,
        at: null,
      };
    case "register_complaint":
    case "request_refund_review":
      return { params: { summary: quotedEvidence(item) }, subject: null, at: null };
    case "create_payment_link":
      return {
        params: {
          amountMinor:
            item.amount && isAmountActionable(item.amount) ? item.amount.amountMinor : null,
        },
        subject: null,
        at: null,
      };
    default:
      return { params: {}, subject: null, at: null };
  }
}


/**
 * The lead's next open appointment, for a reschedule or a cancel.
 *
 * `existing` is the duplicate-check list, and its `book_slot` entries carry
 * the appointment's own id as the key (see `context.ts`). The SOONEST active
 * one is taken: a customer saying "move my appointment" on a call means the
 * one coming up, and if there are two, the one they are about to miss.
 */
function openAppointment(input: CandidateInput): { id: string; at: Date | null } | null {
  const open = input.policy.existing
    .filter((entry) => entry.tool === "book_slot" && entry.active)
    .sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity));
  const first = open[0];
  return first ? { id: first.idempotencyKey, at: first.at } : null;
}

/** §10's idempotency key parts, per tool. */
function keyPartsFor(
  tool: AgentToolName,
  item: ResolvedIntent,
  params: Record<string, unknown>,
): Record<string, string | number | null | undefined> {
  const spec = toolSpec(tool);
  const parts: Record<string, string | number | null | undefined> = {};
  for (const part of spec.keyParts) {
    switch (part) {
      case "hash":
        // A short, stable digest of what makes this action distinct. The
        // INTENT INDEX is deliberately not in it: two runs over the same
        // transcript must produce the same key, and the index would make a
        // re-run a different action.
        parts.hash = shortHash(JSON.stringify(params));
        break;
      case "slot":
        parts.slot = String(params.startsAt ?? "");
        break;
      case "contact":
        // The contact, or the LEAD when the callback is for the lead's own
        // number. An empty segment would collide with every other callback on
        // the call, which `idempotencyKey` refuses outright.
        parts.contact = String(item.intent.slots.contact_text ?? "self");
        break;
      case "amount":
        parts.amount = String(params.amountMinor ?? "0");
        break;
      case "date":
        parts.date = String(params.promisedOn ?? "none");
        break;
      case "field":
        parts.field = String(params.field ?? "none");
        break;
      case "phone":
        parts.phone = String(params.phone ?? "none");
        break;
      case "template":
        parts.template = String(params.template ?? "none");
        break;
      case "channel":
        parts.channel = String(params.channel ?? "none");
        break;
      case "doc":
        parts.doc = String(params.template ?? "none");
        break;
      case "reason":
        parts.reason = shortHash(String(params.reason ?? "none"));
        break;
      case "event":
        // NO FALLBACK, unlike the parts above. `"none"` here would key a
        // reschedule or a cancel that has no appointment to act on, so the
        // planner would queue it for approval and the tool would throw at
        // execution - the one outcome §10 forbids, an action offered to a
        // person that cannot succeed. Left absent, `idempotencyKey` throws and
        // the planner blocks it with "there is no appointment open to move".
        parts.event = params.appointmentId ? String(params.appointmentId) : null;
        break;
      case "schedule_item":
        parts.schedule_item = String(params.amountMinor ?? "none");
        break;
      default:
        // A literal discriminator from §10's table ("book", "msg", "dnc").
        // Left out of `parts` so `idempotencyKey` uses the literal itself.
        break;
    }
  }
  return parts;
}

function followUpTitle(item: ResolvedIntent): string {
  const subject = item.intent.slots.subject_text?.trim();
  if (subject) return `Follow up: ${subject}`.slice(0, 300);
  if (item.type === "request_quote") return "Send a quote";
  if (item.type === "send_information") return "Send the information asked for";
  return "Follow up on this call";
}

function templateFor(item: ResolvedIntent): string {
  // The org's own templates are matched by NAME in the tool. A subject the
  // customer named is the best guess at which; `custom_crm_info` is the
  // catalogue's general-purpose one and the tool refuses an unapproved name,
  // so a wrong guess becomes a refusal rather than a wrong message.
  return item.intent.slots.subject_text?.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 60) ||
    "custom_crm_info";
}

/** The customer's own words, for a task a person will read. */
function quotedEvidence(item: ResolvedIntent): string {
  return item.intent.evidence
    .map((e) => `${e.speaker === "customer" ? "Customer" : "Agent"}: "${e.quote}"`)
    .join("\n")
    .slice(0, 2000);
}

/**
 * A short, stable digest. Not cryptographic and does not need to be: it exists
 * to make two different follow-ups on one call produce two different keys, and
 * a collision costs one deduplicated suggestion.
 */
function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Re-exported so `runner.ts` has one import for the keying rule. */
export { idempotencyKey };
