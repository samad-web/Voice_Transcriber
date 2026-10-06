/**
 * DIALABILITY - may we ring this person, right now, from this campaign?
 *
 * ── ONE PREDICATE, THREE CALLERS, AND THE NUMBER THAT MUST MATCH ────────────
 *
 * Three different processes ask this same question about the same record:
 *
 *   1. the campaign PREVIEW, which tells a supervisor "4,812 dialable" before
 *      they commit a day of their team's time;
 *   2. the queue BUILDER, which materialises the rows the agents will work;
 *   3. the HANDSET, immediately before ACTION_CALL.
 *
 * A dialer with two copies of this logic shows a supervisor "4,812 dialable"
 * and then rings 4,900 - and the extra 88 are the ones on the do-not-call list.
 * Nobody notices until a regulator or a customer does, because both numbers
 * look authoritative and neither screen shows the other one. The reprocess
 * panel settled this shape already: it ships one shared window predicate
 * precisely so the preview and the bill cannot disagree about the same rows.
 *
 * So: one function, no second opinion, and the reason string the queue stores
 * in `dial_queue_items.block_reason` is the same string the preview counted.
 *
 * ── THE HANDSET CHECK IS NOT REDUNDANT ──────────────────────────────────────
 *
 * The obvious economy is to trust the queue: the builder already filtered, so
 * why ask again a second before dialing? Because two of the seven answers are
 * about the clock, not the record. An item built at 09:00 and dialled at 21:30
 * by an agent working late is outside the calling window AT DIAL TIME, and only
 * the third caller can know that. Same for the retry gap when a colleague got
 * there first. Skipping the pre-dial check is how a CRM rings a stranger's
 * personal phone at half past nine at night with a clean audit trail saying it
 * was fine at the time.
 *
 * ── PURE: NO DATABASE, NO CLOCK, NO I/O ─────────────────────────────────────
 *
 * Every fact arrives as data, `now` included. Three reasons, all load-bearing:
 *
 *   - The three callers live in three processes - the API, the worker and a
 *     handset - and only one of them can reach Postgres. A predicate that read
 *     its own rows could not run on the phone, and the phone is the caller that
 *     matters most.
 *   - The boundaries ARE the behaviour. A window edge you cannot test at 20:59
 *     and 21:00 without fake timers is a window edge nobody tests, which is the
 *     reasoning quiet-hours.ts already wrote down and this file inherits.
 *   - The preview counts thousands of records in one request. A per-record
 *     query would make the honest answer too slow to show, and a preview that
 *     is too slow to show gets replaced by an estimate.
 *
 * It follows that the caller does the fetching, and the comment on each input
 * field says exactly which rows it must have fetched - `onActiveDncList` is not
 * "a list mentions this number", it is "an ACTIVE list mentions this number",
 * and getting that wrong suppresses a campaign from a list somebody disabled
 * on purpose.
 *
 * ── THE INPUT DELIBERATELY DOES NOT CARRY THE PHONE NUMBER ──────────────────
 *
 * Only two routes in the whole API may serve `e164`, and a spec greps the
 * source to keep it at two. A predicate that took the number would quietly
 * make every one of its callers a third - the preview especially, which counts
 * thousands of records and has no business holding one number. So the vault row
 * arrives here as its consent basis and nothing else. Dialability answers
 * "may we", never "what is it".
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * Not "should this record be in the queue at all". Campaign status, agent
 * assignment, whether the agent is on shift, lead stage, archive state - those
 * are queue-building concerns with their own rules. This is suppression only:
 * the four ways a person may not be called and the three ways a campaign may
 * not call them yet.
 */

import { inQuietWindow, quietWindowEndsAt, type QuietHours } from "./quiet-hours";
import { type Instant, isValidTimeZone } from "./time";

/**
 * Why a dial is blocked. Eight reasons, and the set is closed on purpose: the
 * agent screen renders this verbatim so an agent knows WHY a record is greyed
 * out rather than assuming the app is broken, and the preview breaks its counts
 * out by it. A reason nobody can render is a reason nobody can act on, so
 * adding a ninth means adding its label below and its copy on both screens.
 */
export type DialBlockReason =
  /** Nothing in the vault for this number key. */
  | "no_number"
  /** The basis is 'unknown' and the org has not accepted that risk. */
  | "consent_unknown"
  /** A `messaging_opt_outs` row, channel 'call', level 'certain'. */
  | "opt_out"
  /** An entry on an ACTIVE `dnc_lists`. */
  | "dnc_list"
  /** Outside the org's calling window, in the org's own zone. */
  | "quiet_hours"
  /** The campaign's attempt ceiling is reached. */
  | "max_attempts"
  /** The ORG's per-person ceiling for today is reached, across every campaign. */
  | "person_daily_cap"
  /** Inside `retry_after_hours` of the last attempt. */
  | "retry_too_soon";

export type DialBlock = { ok: true } | { ok: false; reason: DialBlockReason };

/**
 * THE EVALUATION ORDER, which is also the order of this array.
 *
 * A record can trip several rules at once, and the one it reports is the one a
 * human reads and acts on - so the order is a product decision, not an
 * implementation detail. It runs in descending PERMANENCE: the answer a
 * supervisor is given is the one that will still be true tomorrow.
 *
 *   Tier 1 - we may not ring this person at all. Facts about the person or
 *   their number, which only a human changing something can undo.
 *     1. no_number        nothing to dial; every later field is moot
 *     2. consent_unknown  we hold a number we have no stated right to use
 *     3. opt_out          they asked US, personally, with provenance
 *     4. dnc_list         a bulk or regulatory list says no
 *
 *   Tier 2 - we may ring them, but not again. Campaign-permanent first, then
 *   day-permanent: both outlive the clock checks below them.
 *     5. max_attempts       this campaign is finished with them, for good
 *     6. person_daily_cap   every campaign is finished with them, until midnight
 *
 *   Tier 3 - we may ring them, just not at this moment.
 *     7. quiet_hours      the org's window; true of every record at once
 *     8. retry_too_soon   this record's own cooling-off gap
 *
 * ── THE MISTAKE THE TIERS AVOID ─────────────────────────────────────────────
 *
 * Put the clock checks first and a record that has exhausted its attempts, at
 * 22:00, reports "quiet_hours". A supervisor reads that as "it will dial in the
 * morning". It never will. Worse in tier 1: a number on the DNC list reported
 * as "retry_too_soon" tells an agent to try again in a day, which is the one
 * instruction that turns a suppression list into a complaint.
 *
 * Note that this is NOT the order the reasons are declared in above, which is
 * the order the plan's §5 lists them in and is kept verbatim so the type reads
 * as the spec does: it has quiet_hours before max_attempts. A declaration order
 * is a list; this is the behaviour, and the one deviation between them - tier 2
 * ahead of tier 3 - is deliberate for the reason given above.
 *
 * Within tier 3, the org-wide window is reported before the per-record gap: an
 * agent told "outside calling hours" stops working the queue, which is correct,
 * whereas "called too recently" invites them to pick the next record - at
 * 22:00, every one of which is also outside the window.
 */
export const DIAL_BLOCK_ORDER: readonly DialBlockReason[] = [
  "no_number",
  "consent_unknown",
  "opt_out",
  "dnc_list",
  "max_attempts",
  "person_daily_cap",
  "quiet_hours",
  "retry_too_soon",
];

/**
 * Agent-facing copy, kept here so the console, the handset and the preview
 * cannot describe the same block three ways.
 *
 * Phrased as a state, never as an error: seven of the eight are the system doing
 * exactly what it was told. Only `no_number` is a gap in the data.
 */
export const DIAL_BLOCK_LABELS: Record<DialBlockReason, string> = {
  no_number: "No number on file",
  consent_unknown: "Consent not established",
  opt_out: "Asked not to be called",
  dnc_list: "On a do-not-call list",
  quiet_hours: "Outside calling hours",
  max_attempts: "Attempt limit reached",
  // Names the ceiling that was actually hit. "Attempt limit reached" for both
  // would send a supervisor to the campaign's max_attempts to raise a limit
  // that is not the one stopping the dial.
  person_daily_cap: "Daily limit for this person reached",
  retry_too_soon: "Called too recently",
};

/**
 * `contact_numbers.consent_basis` - WHY we may ring this number.
 *
 * An ordered scale that the database does not know is ordered, strongest first:
 * they rang us, they ticked a box, the tenant asserts a relationship, or
 * nobody said. Only the last one is a block, and only while the org has not
 * accepted the risk.
 *
 * Spelled with a `Dial` prefix rather than as a bare `ConsentBasis` because the
 * vault's own module (migration 0157) is the right home for the canonical
 * vocabulary and the promotion ordering that goes with it; the shared index
 * re-exports with `export *`, so two modules exporting one name is an ambiguity
 * waiting for whichever lands second. Re-point this to the vault's type when it
 * exists - the string values are identical by design.
 */
export type DialConsentBasis =
  | "customer_initiated"
  | "consent_given"
  | "existing_relation"
  | "unknown";

/**
 * The two levels `messaging_opt_outs.level` actually stores.
 *
 * `OptOutVerdict` in opt-out.ts carries a third, "none" - that is the
 * classifier reporting it found nothing, which is never a row and so never
 * something this predicate is handed.
 */
export type StoredOptOutLevel = "certain" | "probable";

/** The vault row as dialability sees it: the basis, and deliberately no number. */
export interface DialableNumber {
  consentBasis: DialConsentBasis;
}

/**
 * An opt-out that is still standing, on the CALL channel.
 *
 * The caller must have filtered to `channel = 'call'` and `released_at IS NULL`
 * and matched on the NUMBER KEY, not an E.164 - the vault owns the only copy of
 * the number, and a suppression list that stores numbers defeats the vault.
 *
 * Only the call channel. "Stop messaging me" is not "stop calling me", and
 * reading one as the other would silence a channel the customer never mentioned
 * - in the direction that looks harmless and is simply wrong. A tenant who
 * wants cross-channel suppression is asking for a product decision, made once,
 * visibly, somewhere an owner can see it; not inferred here.
 */
export interface CallOptOut {
  level: StoredOptOutLevel;
}

/**
 * The hours a call MAY be placed, in the org's own zone.
 *
 * Expressed as the permitted window rather than the quiet one because that is
 * how an owner thinks about it and how the setting reads on screen ("we call
 * between 9 and 9"). It is converted to quiet-hours.ts's window - which is the
 * complement - in exactly one place below, so the two modules cannot drift into
 * disagreeing about what 21:00 means.
 */
export interface CallingWindow {
  /** First local hour a call may be placed, 0-23. Inclusive. */
  startHour: number;
  /** Local hour calling stops, 0-23. EXCLUSIVE - 21 means the last call starts at 20:59. */
  endHour: number;
  /** IANA zone the hours are expressed in - the business's, never the reader's. */
  timeZone: string;
}

/**
 * Everything the answer depends on, and nothing else.
 *
 * Flat rather than nested so the three callers can build it straight off the
 * rows they already have; each field names the column it comes from.
 */
export interface DialabilityInput {
  /** The `contact_numbers` row for this number key, or null when there is none. */
  vaultNumber: DialableNumber | null;
  /** `organizations.dialer_allows_unknown_consent`. An owner's own decision. */
  orgAllowsUnknownConsent: boolean;
  /** The standing call-channel opt-out for this number key, or null. */
  callOptOut: CallOptOut | null;
  /**
   * Does an entry on an ACTIVE `dnc_lists` match this number key?
   *
   * Active only. A disabled list is history - a tenant disables rather than
   * deletes so the record survives - and letting it still suppress would make
   * disabling a list do nothing visible.
   */
  onActiveDncList: boolean;
  /** The org's calling window, or null when the org has not set one. */
  callingWindow: CallingWindow | null;
  /** `dial_queue_items.attempt_count`. */
  attemptCount: number;
  /** When this record was last dialled, or null if it never was. */
  lastAttemptAt: Instant | null;
  /** `dial_campaigns.max_attempts`. */
  maxAttempts: number;
  /**
   * `organizations.dialer_max_calls_per_person_per_day`, or null when the org
   * has set none - which is the DEFAULT (doc 39 §40.10). Null means the only
   * ceiling is the per-campaign one, and a lead in two campaigns can therefore
   * be rung twice over. That is the documented, chosen default, not an
   * oversight.
   */
  personDailyCap: number | null;
  /**
   * Attempts already made to THIS PERSON today, across every campaign, counted
   * in the org's own day. Supplied by the caller because this predicate reads
   * nothing: the queue counts it per batch, the preview counts it per record.
   *
   * Must be 0, never null, when `personDailyCap` is null - a caller that cannot
   * count is a caller that must not be trusted to say "uncapped".
   */
  personAttemptsToday: number;
  /** `dial_campaigns.retry_after_hours`. 0 disables the gap entirely. */
  retryAfterHours: number;
  /** The instant to judge. Passed, never read - see the header. */
  now: Date;
}

/**
 * May we ring this person, right now, from this campaign?
 *
 * The order of these eight tests is specified above and is part of the
 * contract; see DIAL_BLOCK_ORDER before reordering anything here.
 */
export function dialability(input: DialabilityInput): DialBlock {
  // ── Tier 1: facts about the person and their number ──────────────────────

  if (!input.vaultNumber) return { ok: false, reason: "no_number" };

  if (input.vaultNumber.consentBasis === "unknown" && !input.orgAllowsUnknownConsent) {
    return { ok: false, reason: "consent_unknown" };
  }

  // Only `certain` blocks. `probable` is the conservative tier, and what it
  // asks for is a PERSON - see hasUnconfirmedOptOut below for why a dial is
  // the one outbound action that satisfies that rather than defying it.
  if (input.callOptOut?.level === "certain") return { ok: false, reason: "opt_out" };

  if (input.onActiveDncList) return { ok: false, reason: "dnc_list" };

  // ── Tier 2: this campaign has had its turns ──────────────────────────────

  // `>=`, not `===`. An equality test is a ceiling that leaks: anything that
  // ever incremented the counter twice - a retried attempt report, a sweep that
  // ran over itself - steps straight past it and the record dials forever.
  if (input.attemptCount >= input.maxAttempts) return { ok: false, reason: "max_attempts" };

  // The cross-campaign ceiling, which is the only thing in this function that
  // knows a person exists in more than one queue. `attemptCount` above is keyed
  // (campaign, lead), so without this a lead in two campaigns is rung
  // 2 x maxAttempts and every count in the preview still reads as compliant.
  //
  // `null` is uncapped and is the default, so this is a no-op for every tenant
  // until somebody sets a number - see the column comment in 0157 for why that
  // default was chosen and what the console owes the supervisor in exchange.
  if (input.personDailyCap !== null && input.personAttemptsToday >= input.personDailyCap) {
    return { ok: false, reason: "person_daily_cap" };
  }

  // ── Tier 3: the clock ────────────────────────────────────────────────────

  if (outsideCallingWindow(input.now, input.callingWindow)) {
    return { ok: false, reason: "quiet_hours" };
  }

  if (insideRetryGap(input.now, input.lastAttemptAt, input.retryAfterHours)) {
    return { ok: false, reason: "retry_too_soon" };
  }

  return { ok: true };
}

/**
 * There is an opt-out, but only the ambiguous kind. Show a caution; do not
 * block.
 *
 * ── WHY THE AMBIGUOUS TIER DOES NOT STOP A DIAL ─────────────────────────────
 *
 * opt-out.ts draws the line by WHO ACTS: `certain` may suppress outbound on its
 * own, `probable` holds it and puts the decision in front of a person, because
 * the power to stop talking to a customer for good belongs to a person and a
 * guess cannot be undone by the one who would have known the difference.
 *
 * Applied to messaging, that means holding the send - the machine was about to
 * speak unprompted. Applied to dialing it means the opposite, and the rule is
 * the same rule: a dial is not automated. An agent reads the record and presses
 * the button, so the dial IS the person the probable tier is asking for. Hiding
 * the record would be the machine deciding on a maybe, which is exactly what
 * that tier exists to prevent - and it would hide it silently, which is the
 * failure mode opt-out.ts spends its whole header on.
 *
 * What the agent screen owes them is the caution: "they may have asked us to
 * stop - check before you pitch". That is a label, not a block.
 */
export function hasUnconfirmedOptOut(input: Pick<DialabilityInput, "callOptOut">): boolean {
  return input.callOptOut?.level === "probable";
}

/**
 * The calling window, expressed as the quiet window quiet-hours.ts understands.
 *
 * The complement of [start, end) is [end, start), so the conversion is a swap -
 * and because `inQuietWindow` treats its own window as half-open, the swap
 * lands the boundaries where an owner expects them: a 09:00-21:00 window dials
 * at 09:00 sharp and is shut at 21:00 sharp.
 *
 * Null for a window this runtime cannot evaluate - an hour out of range, or a
 * zone Intl does not know. Both would otherwise reach `Intl.DateTimeFormat`,
 * which throws on a bad zone and would turn one malformed org setting into a
 * 500 on the preview for everybody in that org. Returning null means "no
 * window", i.e. dialable, which is the same direction quiet-hours.ts chose for
 * its zero-width window and for its absent env vars: a system that silently
 * stops is worse than one that does what it was last told.
 */
export function quietHoursForCallingWindow(window: CallingWindow): QuietHours | null {
  if (!isHour(window.startHour) || !isHour(window.endHour)) return null;
  if (!isValidTimeZone(window.timeZone)) return null;
  return {
    startHour: window.endHour,
    endHour: window.startHour,
    timeZone: window.timeZone.trim(),
  };
}

/**
 * Is `now` outside the hours this org calls in?
 *
 * The whole time-of-day question, answered by quiet-hours.ts rather than
 * re-derived: the wrapping-window branch, the half-open boundaries, the
 * zero-width reading and the Intl-over-fixed-offset decision are all already
 * written down there, with their own tests and their own explanation of the
 * DST bug a hard-coded +05:30 reintroduces.
 */
export function outsideCallingWindow(now: Date, window: CallingWindow | null): boolean {
  if (!window) return false;
  const quiet = quietHoursForCallingWindow(window);
  if (!quiet) return false;
  return inQuietWindow(now, quiet);
}

/**
 * The next instant this org may call, or null when it may already.
 *
 * Literally quiet-hours.ts's `quietWindowEndsAt` read in the other direction:
 * the instant the quiet window ENDS is the instant the calling window BEGINS.
 * Routed through `outsideCallingWindow` first so this answer and the block
 * cannot disagree about whether we are inside the window at all.
 */
export function callingWindowResumesAt(now: Date, window: CallingWindow | null): Date | null {
  if (!window || !outsideCallingWindow(now, window)) return null;
  const quiet = quietHoursForCallingWindow(window);
  return quiet ? quietWindowEndsAt(now, quiet) : null;
}

/**
 * The earliest this record may be dialled again, or null when no gap applies.
 *
 * Returned as an absolute instant so the queue can sort on it, the way the
 * outbox sorts on `next_attempt_at`.
 */
export function nextRetryAt(lastAttemptAt: Instant | null, retryAfterHours: number): Date | null {
  const last = instantMs(lastAttemptAt);
  if (last === null || !(retryAfterHours > 0)) return null;
  return new Date(last + retryAfterHours * 3_600_000);
}

/**
 * Inside the cooling-off gap?
 *
 * Three edges, each chosen rather than fallen into:
 *
 *   - At the boundary exactly, the record is DIALABLE. "Inside
 *     retry_after_hours" is strictly inside, and the half-open reading matches
 *     the calling window's, so one mental model covers both clock rules.
 *   - No last attempt means no gap. A missing timestamp beside a non-zero
 *     attempt count is a data bug, and blocking on it would park the record
 *     forever with a reason that tells nobody what is wrong.
 *   - A last attempt in the FUTURE does block, for up to the gap. That comes
 *     from a handset with a wrong clock, and of the two wrong answers - ring
 *     somebody twice in a minute, or wait a day - waiting costs a slot and
 *     ringing costs the customer's patience.
 */
function insideRetryGap(now: Date, lastAttemptAt: Instant | null, retryAfterHours: number): boolean {
  const due = nextRetryAt(lastAttemptAt, retryAfterHours);
  return due !== null && now.getTime() < due.getTime();
}

/** Milliseconds, or null for absent and for anything that will not parse. */
function instantMs(value: Instant | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isHour(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 23;
}
