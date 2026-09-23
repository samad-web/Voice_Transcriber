import type { MissedCallReason } from "./device-api";

/**
 * Missed calls (migration 0133) - the handset's call-log entries nobody picked
 * up, and whether anybody rang them back.
 *
 * Everything that decides how a missed call is MATCHED or WORDED lives here,
 * so the API's SQL, the call log, the lead drawer, the insights page and the
 * PDF cannot disagree about who a caller is or what "called back" means.
 */

/** Below this many digits a "number" is junk ("n/a", "-", an extension) - crm-ingest.service.ts's floor. */
const MIN_MATCH_DIGITS = 6;

/**
 * The digits two calls are compared on to decide they reached the same person.
 *
 * The call log is not consistent about how it writes a number: an incoming
 * call arrives as "+919876543210", the same person dialled back from the
 * keypad as "9876543210" or "09876543210". Hashing the raw digits (which is
 * what `remote_number_hash` does, and must keep doing - leads join on it)
 * gives three different people. The last ten digits are the same in all three,
 * and ten is the Indian national number length the whole fleet dials.
 *
 * A shorter number (a landline without its STD code, a short code) keeps its
 * digits minus any trunk zero - there is no country code to strip from it.
 *
 * Mirrored in SQL by 0133's backfill; keep the two in step.
 */
export function phoneMatchDigits(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D+/gu, "");
  if (digits.length < MIN_MATCH_DIGITS) return null;
  const key = digits.length >= 10 ? digits.slice(-10) : digits.replace(/^0+/u, "");
  return key.length >= MIN_MATCH_DIGITS ? key : null;
}

export const MISSED_REASON_LABEL: Record<MissedCallReason, string> = {
  unanswered: "Rang out",
  declined: "Declined",
  voicemail: "Went to voicemail",
  // An OUTGOING attempt (0134) - one of ours rang out, not a missed inbound
  // call. Never call this one "missed": the console reserves that word for
  // the customer side (console-palette rule, red = missed INBOUND call).
  no_answer: "No answer",
};

/** A stored reason as words; null for a zero-second call that predates 0133. */
export function missedReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return MISSED_REASON_LABEL[reason as MissedCallReason] ?? null;
}

/**
 * How long somebody waited: "4m", "2h 05m", "3d". Rounded to whole minutes,
 * because "called back 0m later" reads as a bug and a callback inside a minute
 * is still "under a minute".
 */
export function formatWait(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return "–";
  if (minutes < 1) return "under a minute";
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  if (hours < 48) return `${hours}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.round(hours / 24)}d`;
}

/** What happened after a missed call, as the API reports it. */
export interface MissedCallback {
  /** The first later call to or from the same person that reached them, or null. */
  returnedAt: string | null;
  /** `outgoing` - we rang them back; `incoming` - they rang again and got through. */
  returnDirection: string | null;
}

export type CallbackState = "returned" | "waiting" | "no_number";

export function callbackState(cb: MissedCallback, hasNumber: boolean): CallbackState {
  if (cb.returnedAt) return "returned";
  return hasNumber ? "waiting" : "no_number";
}

/**
 * The leads list's "Callback" column (migration 0134): has anybody reached
 * this PERSON since the last time a call to or from them went unanswered.
 *
 * Deliberately not `callbackState` above: that one reads a single missed
 * call's own `returnedAt`, computed by owner-calls.controller.ts's number-key
 * matching for calls that are not necessarily linked to a lead yet. This one
 * reads two timestamps already aggregated off `calls.lead_id` (leads.controller
 * .ts's LEAD_COLUMNS), which only exists once a call IS on a lead - the
 * question the leads list is actually asking is about the PERSON's whole call
 * history with this business, not any one call.
 */
export function leadCallbackState(
  lastMissedAt: string | null | undefined,
  lastReachedAt: string | null | undefined,
): "returned" | "waiting" | null {
  if (!lastMissedAt) return null;
  if (lastReachedAt && Date.parse(lastReachedAt) > Date.parse(lastMissedAt)) return "returned";
  return "waiting";
}

/**
 * The one sentence every surface shows under a missed call.
 *
 * "Called back" only for OUR call. A customer who had to ring a second time
 * and got through was not called back - they chased, which is the thing this
 * report exists to show - so that reads "Reached on their next call".
 */
export function callbackLabel(startedAt: string, cb: MissedCallback, hasNumber: boolean): string {
  const state = callbackState(cb, hasNumber);
  if (state === "no_number") return "Number withheld - cannot be called back";
  if (state === "waiting") return "Not called back yet";
  const minutes = (Date.parse(cb.returnedAt as string) - Date.parse(startedAt)) / 60_000;
  const wait = formatWait(minutes);
  const when = wait === "under a minute" ? "within a minute" : `${wait} later`;
  return cb.returnDirection === "outgoing" ? `Called back ${when}` : `Reached on their next call, ${when}`;
}
