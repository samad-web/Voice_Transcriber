import type { ReactNode } from "react";

/**
 * THE FUNCTIONAL COLOUR SYSTEM.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * Colour in this console encodes STATE and nothing else. There are exactly
 * four states that get a hue, and one that does not:
 *
 *   missed    red      an inbound call nobody picked up
 *   answered  green    a conversation actually happened
 *   outgoing  blue     we called them
 *   error     orange   the system failed at something
 *   neutral   -        everything else, which is most things
 *
 * Everything not on that list is grey. Not "mostly grey" - grey. A category, a
 * count, a name, a tag, a section heading, a card that happens to feel
 * important: none of them are states, so none of them get colour. The point is
 * that a splash of red anywhere on a screen means one thing, and a person can
 * learn it once in about four seconds and then trust it forever. Every
 * decorative use of a hue spends that down.
 *
 * ── WHY RED IS NOT "ERROR" HERE ─────────────────────────────────────────────
 *
 * Red-for-error is the convention almost everywhere, and this system breaks it
 * deliberately. On a call-intelligence dashboard the thing an owner scans for
 * is missed business, not failed jobs - a missed call is money walking away,
 * a failed transcode is a retry. Red is the loudest colour available and it is
 * spent on whichever of the two the reader actually came for. Errors take
 * orange, which is still an alarm colour and still unmistakable, and they are
 * additionally the only state carrying a triangle.
 *
 * That is also why every state below carries a distinct GLYPH. Colour alone
 * fails WCAG 1.4.1, fails in greyscale (these screens get screenshotted into
 * WhatsApp constantly in this market), and fails for the ~8% of men who cannot
 * separate red from green - which here would be exactly "missed" from
 * "answered", the single most consequential distinction on the page. The
 * glyphs are chosen to differ in SILHOUETTE, not in hue: a slashed ring, a
 * filled disc, an arrow, a triangle, a bar.
 *
 * ── WHY IT LIVES IN ONE FILE ────────────────────────────────────────────────
 *
 * Because a rule stated in a design doc is a rule nobody can enforce. This
 * module is the only place in the kit that names a hue for a state, every
 * consumer goes through `STATE_TONE`, and `apps/web` has a source-scan test
 * that fails the build when a component reaches for a colour utility directly.
 * Adding a sixth state means editing this file and arguing about it, which is
 * the correct amount of friction.
 */
export const CONSOLE_STATES = ["missed", "answered", "outgoing", "error", "neutral"] as const;

export type ConsoleState = (typeof CONSOLE_STATES)[number];

export interface StateTone {
  /** Default human label. A call site may override it; the tone may not change. */
  label: string;
  /** Chip fill + label + border, for a chip sitting on a neutral surface. */
  chip: string;
  /** A bare marker - the leading rule on a row, a legend swatch. */
  dot: string;
  /**
   * A CHART mark - a stacked segment, a bar, a heat cell (Build docs/29 §4.1).
   * Separate from `dot` because a chart puts the states SIDE BY SIDE as a
   * series, and there they must also pass the categorical checks: equal
   * loudness and colour-blind separation. They do in light mode; in dark mode
   * the chip green (#22C55E) is far lighter than its neighbours and
   * out-shouts them, so answered draws its marks one step darker. Every
   * other state's mark is its dot.
   */
  mark: string;
  /** For a value that must carry its own state (a count, a duration). */
  text: string;
  /** Distinct silhouette, so the state survives greyscale and colour blindness. */
  glyph: ReactNode;
  /**
   * What the colour would have told a sighted reader, in words. Rendered as
   * sr-only text by StateChip when the visible label does not already say it.
   */
  meaning: string;
}

export const STATE_TONE: Record<ConsoleState, StateTone> = {
  missed: {
    label: "Missed",
    chip: "border-danger-text/30 bg-danger-subtle text-danger-text",
    dot: "bg-danger",
    mark: "bg-danger",
    text: "text-danger-text",
    // A slashed ring - "this did not happen". The only glyph with a stroke
    // crossing its own body, which is what makes it readable at 10px.
    glyph: (
      <>
        <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M2.4 7.6 L7.6 2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
    meaning: "missed call",
  },
  answered: {
    label: "Answered",
    chip: "border-success-text/30 bg-success-subtle text-success-text",
    dot: "bg-success",
    mark: "bg-mark-answered",
    text: "text-success-text",
    // Filled disc - the densest mark in the set, "it completed".
    glyph: <circle cx="5" cy="5" r="3.6" fill="currentColor" />,
    meaning: "answered call",
  },
  outgoing: {
    label: "Outgoing",
    // `outgoing`, not `accent`. The accent is brandable and this is not - see
    // the note beside these tokens in theme.css. They hold the same blues, so
    // an unbranded console is unchanged.
    chip: "border-outgoing-text/30 bg-outgoing-subtle text-outgoing-text",
    dot: "bg-outgoing",
    mark: "bg-outgoing",
    text: "text-outgoing-text",
    // Arrow leaving to the top-right. Directional, so it cannot be confused
    // with any of the four static shapes even at a glance.
    glyph: (
      <path
        d="M2.6 7.4 L7.4 2.6 M4.2 2.6 H7.4 V5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    meaning: "outgoing call",
  },
  error: {
    label: "Error",
    chip: "border-orange-text/30 bg-orange-subtle text-orange-text",
    dot: "bg-orange",
    mark: "bg-orange",
    text: "text-orange-text",
    // Triangle - the only pointed solid, and the shape every warning sign on
    // every road in the world already uses.
    glyph: <path d="M5 1 L9.3 8.5 H0.7 Z" fill="currentColor" />,
    meaning: "error",
  },
  neutral: {
    label: "",
    chip: "border-border bg-surface-hover text-text",
    dot: "bg-text-subtle",
    mark: "bg-text-subtle",
    text: "text-text",
    // Bar - informational, no valence.
    glyph: <rect x="1.5" y="4" width="7" height="2" rx="1" fill="currentColor" />,
    meaning: "",
  },
};

/* ── Deriving a state from a call ──────────────────────────────────────────
 *
 * IMPORTANT, because the schema does not say it: `calls.status` is the
 * PROCESSING pipeline (AWAITING_AUDIO → … → COMPLETE, plus FAILED_*), not the
 * call's outcome. There is no `missed` value anywhere in it, and there never
 * was - see migration 0014's `calls_status_check`.
 *
 * So "missed" is derived, and it is derived from the only two columns that can
 * answer it: an INBOUND call that connected for zero seconds is one nobody
 * picked up. That is the same test `packages/shared`'s telephony intake
 * already applies when a CTI webhook reports `call_status: "missed"`, so the
 * two paths agree.
 *
 * The pipeline is a SEPARATE axis and is deliberately not folded in here: a
 * call that was answered and is still transcribing is answered, and painting
 * it neutral until the worker catches up would make the dashboard's headline
 * number wobble for reasons that have nothing to do with the business. The one
 * exception is FAILED_*, which wins outright - if we could not process it, we
 * cannot honestly claim to know what it was.
 */

/** The direction words that reach us from handsets, CTI webhooks and imports. */
const INBOUND = new Set(["incoming", "inbound", "in", "missed", "received"]);
const OUTBOUND = new Set(["outgoing", "outbound", "out", "dialled", "dialed"]);

export interface CallLike {
  direction?: string | null;
  duration_s?: number | string | null;
  status?: string | null;
}

export function callState(call: CallLike): ConsoleState {
  if (typeof call.status === "string" && call.status.startsWith("FAILED")) return "error";

  const direction = (call.direction ?? "").trim().toLowerCase();
  if (OUTBOUND.has(direction)) return "outgoing";
  if (!INBOUND.has(direction)) return "neutral";

  // `duration_s` arrives as a string from pg's numeric handling on some
  // queries and as a number on others. Number("") is 0, which would be a
  // false "missed", so an empty/absent duration is treated as unknown -
  // an inbound call we cannot measure is not evidence that nobody answered.
  if (call.duration_s === null || call.duration_s === undefined || call.duration_s === "") {
    return "neutral";
  }
  const seconds = Number(call.duration_s);
  if (!Number.isFinite(seconds)) return "neutral";
  return seconds > 0 ? "answered" : "missed";
}

/** The state's label, unless the call was inbound-and-answered where "Incoming"
 *  reads better than "Answered" beside an explicit duration. */
export function callStateLabel(call: CallLike): string {
  return STATE_TONE[callState(call)].label;
}

/* ── The processing axis ───────────────────────────────────────────────────
 *
 * What the pipeline is doing to a call right now. Separate from `callState`
 * above on purpose (see the note there), and separate because it drives
 * something different in the UI: not a colour, but a SENTENCE. A row that says
 * "Transcribing" and nothing else has told the reader a word they did not ask
 * for; a row that says "Transcribing - the text and AI read appear here in a
 * few minutes, nothing to do" has told them they can leave.
 */
export type PipelinePhase = "working" | "settled" | "off" | "error";

export interface PipelineStage {
  phase: PipelinePhase;
  label: string;
  /** One sentence, addressed to the reader, saying what to expect and whether
   *  they must act. Rendered by RowHint. */
  hint: string;
}

const PIPELINE: Record<string, PipelineStage> = {
  AWAITING_AUDIO: {
    phase: "working",
    label: "Waiting for audio",
    hint: "The handset has logged the call but not uploaded the recording yet - usually because it is on mobile data or out of coverage. It uploads itself; nothing to do here.",
  },
  UPLOADED: {
    phase: "working",
    label: "Uploaded",
    hint: "The recording is with us and queued for processing. It moves on by itself within a few minutes.",
  },
  TRANSCODING: {
    phase: "working",
    label: "Transcoding",
    hint: "Converting the recording before it can be transcribed. No action needed.",
  },
  TRANSCRIBING: {
    phase: "working",
    label: "Transcribing",
    hint: "Turning speech into text. The transcript and the AI read appear on this row when it finishes.",
  },
  ANALYZING: {
    phase: "working",
    label: "Analyzing",
    hint: "Reading the transcript for intent, sentiment and next steps. This is the last step before the row is complete.",
  },
  SYNCING: {
    phase: "working",
    label: "Syncing to CRM",
    hint: "Pushing the outcome to your connected CRM. If the CRM rejects it this row turns into an error you can retry.",
  },
  COMPLETE: {
    phase: "settled",
    label: "Complete",
    hint: "",
  },
  // A missed call from the handset's call log (0133). Settled, not "off":
  // nothing was switched off and nothing is coming - there was never audio.
  // No hint, because the row's own Missed chip and call-back line already say
  // what happened and what to do.
  NO_AUDIO: {
    phase: "settled",
    label: "No recording",
    hint: "",
  },
  TRANSCRIPTION_OFF: {
    phase: "off",
    label: "Not transcribed",
    hint: "Transcription is switched off for this instance, so this call was stored but never read. Turning it on affects new calls; ask your provider to reprocess this one.",
  },
  FAILED_TRANSCODE: {
    phase: "error",
    label: "Transcode failed",
    hint: "The recording could not be converted - usually a truncated or silent file. There is no transcript for this call.",
  },
  FAILED_ASR: {
    phase: "error",
    label: "Transcription failed",
    hint: "Speech recognition could not read this recording. The call and its audio are still here; the transcript is not.",
  },
  FAILED_ANALYZE: {
    phase: "error",
    label: "Analysis failed",
    hint: "The transcript exists but the AI read of it did not complete, so intent and next steps are blank on this call.",
  },
  FAILED_CRM: {
    phase: "error",
    label: "CRM sync failed",
    hint: "Everything was processed, but your CRM refused the update. The call is safe here - the CRM copy is missing.",
  },
};

export function pipelineStage(status: string | null | undefined): PipelineStage {
  if (!status) return { phase: "working", label: "Pending", hint: "" };
  return (
    PIPELINE[status] ?? {
      // An unknown status is not an error - it is a newer API than this build.
      // Say so rather than painting it orange and alarming somebody.
      phase: "working",
      label: status,
      hint: "",
    }
  );
}
