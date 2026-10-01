import { isCalendarDate } from "@aura/shared";

/**
 * The period picker behind "Reprocess failed calls", as pure functions.
 *
 * Separated from the component because every rule here has a counterpart in
 * `apps/api/src/modules/calls/retry-window.ts`, and the two have to agree: the
 * panel must refuse a range the API would refuse, name the window the same way
 * the audit row will, and never offer a button whose cost it has not stated.
 * None of that is testable through a dialog, and all of it is testable here.
 */

/** The one-click spans, in the order they are drawn. `null` is everything. */
export const RETRY_PRESETS: Array<number | null> = [7, 21, 30, null];

/** Must match MAX_WINDOW_DAYS on the API, which refuses anything longer. */
export const MAX_WINDOW_DAYS = 3650;

export type RetryWindowState =
  | { kind: "preset"; days: number | null }
  | { kind: "custom"; from: string; to: string };

export const DEFAULT_WINDOW: RetryWindowState = { kind: "preset", days: 30 };

export function presetLabel(days: number | null): string {
  return days === null ? "Everything" : `Last ${days} days`;
}

/**
 * The window in words - the phrase the confirmation and the toast both use.
 *
 * Deliberately the same wording as the API's `describeRetryWindow()`, so the
 * sentence an operator agreed to is the sentence the audit ledger records.
 */
export function windowPhrase(window: RetryWindowState): string {
  if (window.kind === "custom") return `${window.from} to ${window.to}`;
  if (window.days === null) return "every stored call";
  return `the last ${window.days} days`;
}

/**
 * The query/body fields for a window, or the reason it cannot be sent.
 *
 * Checked here as well as on the API, not instead of it: a 400 from a bulk-spend
 * endpoint is a worse answer than a disabled button, because the operator has
 * already decided to spend by the time they see it.
 */
export function windowFields(
  window: RetryWindowState,
): { fields: { sinceDays?: number | null; from?: string; to?: string } } | { error: string } {
  if (window.kind === "preset") return { fields: { sinceDays: window.days } };
  const { from, to } = window;
  if (!from || !to) return { error: "Pick both a start and an end date." };
  if (!isCalendarDate(from) || !isCalendarDate(to)) return { error: "Those are not real dates." };
  // Refused rather than swapped: see the API's note on the same check. Guessing
  // what somebody meant is not a thing to do with their money.
  if (from > to) return { error: "The start date is after the end date." };
  if (spanDays(from, to) > MAX_WINDOW_DAYS) {
    return { error: `That range is longer than ${MAX_WINDOW_DAYS} days.` };
  }
  return { fields: { from, to } };
}

/** Inclusive day count, so a single day is 1 rather than 0. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * A pipeline state in the words an operator uses.
 *
 * The raw enum is in the table beside this panel, and it stays there - a status
 * chip is a precise thing. But a checkbox that asks somebody to spend money on
 * `FAILED_ANALYZE` is asking them to decode an enum first, and the two failures
 * that matter here are not equally worth retrying: a transcode failure is
 * usually the file, an ASR failure is usually the provider.
 */
const STATUS_LABELS: Record<string, string> = {
  FAILED_TRANSCODE: "Audio conversion failed",
  FAILED_ASR: "Transcription failed",
  FAILED_ANALYZE: "Analysis failed",
  FAILED_CRM: "CRM delivery failed",
  TRANSCRIPTION_OFF: "Not transcribed",
  COMPLETE: "Already complete",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Recorded audio as a person would say it.
 *
 * This is the number that predicts the bill - every provider in the pipeline
 * charges by the second of audio - so it is shown beside every count rather
 * than left for the operator to multiply.
 */
export function audioPhrase(seconds: number): string {
  if (seconds <= 0) return "no audio";
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

/** How many presses a backlog needs, given the API's per-run cap. */
export function runsNeeded(calls: number, maxPerRun: number): number {
  if (calls <= 0 || maxPerRun <= 0) return 0;
  return Math.ceil(calls / maxPerRun);
}

/**
 * `GET /v1/calls/retry-summary`, as the panel reads it.
 *
 * Every field is optional-tolerant on purpose: this console is deployed
 * separately from the API, and a panel that throws because an older API has no
 * `maxPerRun` is worse than one that shows a cautious default.
 */
export interface RetrySummary {
  window: { sinceDays: number | null; from: string | null; to: string | null };
  windowLabel: string;
  presets: Array<{ days: number | null; calls: number; seconds: number }>;
  total: { calls: number; seconds: number };
  statuses: Array<{ status: string; calls: number; seconds: number }>;
  oldest: string | null;
  newest: string | null;
  maxPerRun: number;
}

/** The total for one chip, or null when this API answer does not carry it. */
export function presetTotal(
  summary: RetrySummary | null,
  days: number | null,
): { calls: number; seconds: number } | null {
  return summary?.presets.find((p) => p.days === days) ?? null;
}
