import { z } from "zod";

/**
 * The vocabulary of a reported problem with a processed call (doc 36,
 * migration 0147).
 *
 * ── WHY THIS LIVES IN @aura/shared ──────────────────────────────────────────
 *
 * Four readers have to agree on these strings: the migration's CHECK
 * constraints, the API's zod bodies, the client console's dialog and the
 * operator console's queue filters. `notification-kind-drift` records what
 * happens when two of those lists are maintained by hand in different
 * packages - the CHECK and the enum drift, and the drift surfaces as a 23514
 * at runtime rather than as a red test. One definition here, and
 * `call-issues.test.ts` compares it against the database.
 */

/**
 * WHAT is wrong. A fixed list rather than free text, because triage routes on
 * it and because "it's wrong" is not a reproducible statement.
 *
 * Every value names something the PIPELINE can be wrong about, in the order a
 * call passes through it: audio, then transcription, then the AI read, then the
 * CRM side. A complaint with no stage behind it belongs in `other` with a
 * description - adding a value here means claiming there is something specific
 * to look at.
 */
export const CallIssueCategory = z.enum([
  "audio_unplayable",
  "audio_truncated",
  "wrong_transcript",
  "wrong_language",
  "wrong_speaker_split",
  "wrong_summary",
  "wrong_sentiment",
  "wrong_facts",
  "wrong_disposition",
  "missing_call",
  "other",
]);
export type CallIssueCategory = z.infer<typeof CallIssueCategory>;

/**
 * How much it is costing them. Three values, and deliberately not a number: a
 * 1-5 scale invites everybody to pick 1, and a boolean cannot separate "this
 * stops my team" from "worth fixing eventually", which is the only distinction
 * the queue actually sorts on.
 */
export const CallIssueSeverity = z.enum(["blocking", "wrong", "minor"]);
export type CallIssueSeverity = z.infer<typeof CallIssueSeverity>;

export const CallIssueStatus = z.enum([
  "open",
  "acknowledged",
  "in_progress",
  "awaiting_client",
  "resolved",
  "rejected",
  "duplicate",
  "withdrawn",
]);
export type CallIssueStatus = z.infer<typeof CallIssueStatus>;

/**
 * The statuses that put a report in somebody's work list.
 *
 * Load-bearing in three places that must not disagree: the partial unique index
 * that stops a double-press becoming two tickets, the partial queue index, and
 * every "live" filter in both consoles. A status added to `CallIssueStatus`
 * without a decision about this list is a status the queue silently ignores.
 */
export const CALL_ISSUE_LIVE_STATUSES = [
  "open",
  "acknowledged",
  "in_progress",
  "awaiting_client",
] as const satisfies readonly CallIssueStatus[];

export const CallIssueResolution = z.enum([
  /** We re-ran the call and that fixed it. */
  "reprocessed",
  /** Fixed in the product or at the provider; existing calls may still be wrong. */
  "fixed_upstream",
  /** The output is what it should be - a disagreement, not a defect. */
  "working_as_intended",
  "not_reproducible",
  /** Caused by something at the client's end (wrong handset setting, say). */
  "client_error",
  "duplicate",
  /** The client closed it themselves. Names nobody on our side, by design. */
  "withdrawn",
]);
export type CallIssueResolution = z.infer<typeof CallIssueResolution>;

/**
 * 'internal' rows are never selected by any `/owner/*` route. An operator
 * writing "client is confused, the audio is fine" must be able to do so without
 * it appearing in the customer's console - and a row the CLIENT wrote can never
 * be internal, which the migration asserts as a CHECK rather than leaving to
 * whichever handler writes it next.
 */
export const CallIssueVisibility = z.enum(["internal", "client"]);
export type CallIssueVisibility = z.infer<typeof CallIssueVisibility>;

export const CallIssueEventKind = z.enum([
  "filed",
  "acknowledged",
  "assigned",
  "status_changed",
  "severity_changed",
  "note",
  "reprocess_queued",
  "reprocess_finished",
  "access_requested",
  "resolved",
  "rejected",
  "reopened",
  "withdrawn",
  "client_reply",
  "client_confirmed",
]);
export type CallIssueEventKind = z.infer<typeof CallIssueEventKind>;

/**
 * How each category is worded, and where.
 *
 * `client` is what the reporting dialog offers - the customer's language, not
 * the enum's. `operator` is the queue's column, which is terser because it sits
 * beside nine others.
 *
 * `needsRecording` decides which options a call with no stored audio offers. A
 * missed call from the handset's log (0133) has no recording and no transcript,
 * so "the recording won't play" is not a complaint anybody can make about it,
 * while "this call is missing from the log" is one of the few that only makes
 * sense there.
 */
export const CALL_ISSUE_CATEGORIES: Record<
  CallIssueCategory,
  { client: string; operator: string; needsRecording: boolean }
> = {
  wrong_transcript: {
    client: "The words in the transcript are wrong",
    operator: "Wrong transcript",
    needsRecording: true,
  },
  wrong_language: {
    client: "It transcribed the wrong language",
    operator: "Wrong language",
    needsRecording: true,
  },
  wrong_speaker_split: {
    client: "The two speakers are mixed up",
    operator: "Speakers mixed up",
    needsRecording: true,
  },
  audio_unplayable: {
    client: "The recording will not play",
    operator: "Recording won't play",
    needsRecording: true,
  },
  audio_truncated: {
    client: "The recording is shorter than the call was",
    operator: "Recording cut short",
    needsRecording: true,
  },
  wrong_summary: {
    client: "The summary misreads what the call was about",
    operator: "Wrong summary",
    needsRecording: true,
  },
  wrong_sentiment: {
    client: "It read the customer's mood wrongly",
    operator: "Wrong sentiment",
    needsRecording: true,
  },
  wrong_facts: {
    client: "A detail it filled in for me is wrong",
    operator: "Wrong extracted detail",
    needsRecording: true,
  },
  wrong_disposition: {
    client: "The outcome or label on this call is wrong",
    operator: "Wrong outcome",
    needsRecording: false,
  },
  missing_call: {
    client: "A call happened that is not in this log",
    operator: "Call missing from the log",
    needsRecording: false,
  },
  other: {
    client: "Something else",
    operator: "Other",
    needsRecording: false,
  },
};

export const CALL_ISSUE_SEVERITIES: Record<CallIssueSeverity, { client: string; operator: string }> =
  {
    blocking: { client: "This is blocking my team", operator: "Blocking" },
    wrong: { client: "Wrong, but I can work round it", operator: "Wrong" },
    minor: { client: "Minor - worth fixing eventually", operator: "Minor" },
  };

/**
 * How many LIVE reports one organisation may hold.
 *
 * A policy, not an invariant, so it is checked in the handler and not by the
 * schema. A tenant sitting at this ceiling has a relationship problem rather
 * than a form-submission problem, and the refusal should say so rather than
 * silently accepting a 300th ticket nobody will read.
 */
export const MAX_LIVE_CALL_ISSUES_PER_ORG = 25;

/**
 * The reference both sides quote on the phone: `AUR-000123`.
 *
 * Formatted from the row's identity rather than stored, because a stored copy
 * of a derived string is one more thing that can disagree with the row. Six
 * digits is padding for legibility, not a limit - the number simply gets longer.
 */
export function callIssueRef(ref: number | string): string {
  return `AUR-${String(ref).padStart(6, "0")}`;
}
