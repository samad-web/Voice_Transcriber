import type { AsrSegment } from "./asr";

/**
 * Sanity-check an inline ASR result before the pipeline trusts it.
 *
 * This exists because a generative model does not fail loudly. Measured over 15
 * runs of gemini-3.5-flash-lite against five real TNPSC calls (96-286s, Tamil),
 * 40% of responses were unusable and NONE of them announced it: `finishReason`
 * was `STOP`, the JSON was well-formed often enough to parse, `segments` was
 * populated, and an `"S2"` was present - so the old code would have written a
 * transcript, set `diarized: true`, and reported success. Two distinct failures:
 *
 *   * COLLAPSE - the response keeps the shape but loses the speech, returning
 *     one- and two-word fragments ("exam", "okay", "section test") in place of
 *     sentences. Four of fifteen runs lost 79-86% of the conversation this way.
 *   * FABRICATED TIMINGS - the timeline claims to run past the end of the audio
 *     (observed +37s to +157s, twelve of fifteen runs), or every boundary lands
 *     on a round multiple of 1000ms. The text is usually fine; only the clock is
 *     invented.
 *
 * Those two need different answers, which is why this returns a verdict rather
 * than a boolean. A collapse is a failed transcription and belongs in the retry
 * budget. Invented timings are NOT a failed transcription - the words are still
 * worth keeping, and lead extraction reads the flat text anyway - so that case
 * keeps the transcript and only withdraws the `diarized` claim, which is enough
 * to make the talk-metrics gate skip the call instead of publishing a confident
 * wrong ratio.
 */
export type AsrVerdict =
  | { kind: "ok" }
  | { kind: "timings-untrusted"; reason: string }
  | { kind: "reject"; reason: string };

/**
 * Mean words per segment below this means fragments rather than speech.
 *
 * Measured: healthy runs (including Sarvam's own output as a reference) sat
 * between 5.35 and 19.64 words per segment; every collapsed run sat between
 * 0.00 and 2.88. 4.0 splits them with room on both sides. Words per SECOND
 * separates just as cleanly (healthy 1.73-2.87, collapsed 0.00-0.99) but is not
 * used as a rejection: a call that is mostly ringing or silence would fail it
 * honestly, whereas words-per-segment does not care how much silence there is.
 */
const MIN_WORDS_PER_SEGMENT = 4.0;

/**
 * Below this many segments the mean is too noisy to judge - a genuine two-line
 * call ("hello" / "wrong number") would look like a collapse.
 */
const COLLAPSE_MIN_SEGMENTS = 5;

/** Slack for rounding before a timeline counts as overrunning the audio. */
const OVERRUN_TOLERANCE_MS = 2_000;

/**
 * Above this many segments, every boundary landing on a whole second is not a
 * coincidence - it means the model estimated the clock instead of reading it.
 */
const ROUND_TIMESTAMP_MIN_SEGMENTS = 8;

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export function validateAsr(segments: AsrSegment[], audioSeconds: number | null): AsrVerdict {
  if (segments.length === 0) {
    return { kind: "reject", reason: "ASR returned no segments" };
  }

  const words = segments.reduce((total, s) => total + wordCount(s.text ?? ""), 0);
  if (words === 0) {
    return { kind: "reject", reason: `ASR returned ${segments.length} segments with no words` };
  }

  const perSegment = words / segments.length;
  if (segments.length >= COLLAPSE_MIN_SEGMENTS && perSegment < MIN_WORDS_PER_SEGMENT) {
    return {
      kind: "reject",
      reason:
        `ASR collapsed: ${words} words across ${segments.length} segments ` +
        `(${perSegment.toFixed(2)}/segment, floor ${MIN_WORDS_PER_SEGMENT}) - ` +
        `fragments rather than speech`,
    };
  }

  // From here the words are worth keeping; only the clock is in question.
  const badTiming = segments.filter(
    (s) => !Number.isFinite(Number(s.startMs)) || !Number.isFinite(Number(s.endMs)),
  );
  if (badTiming.length > 0) {
    return {
      kind: "timings-untrusted",
      reason: `${badTiming.length}/${segments.length} segments have a missing or non-numeric timestamp`,
    };
  }

  const endMs = Math.max(...segments.map((s) => Number(s.endMs)));
  if (audioSeconds !== null && Number.isFinite(audioSeconds) && audioSeconds > 0) {
    const limit = audioSeconds * 1000 + OVERRUN_TOLERANCE_MS;
    if (endMs > limit) {
      return {
        kind: "timings-untrusted",
        reason:
          `timeline ends at ${(endMs / 1000).toFixed(1)}s on ` +
          `${audioSeconds.toFixed(1)}s of audio (+${((endMs - audioSeconds * 1000) / 1000).toFixed(0)}s)`,
      };
    }
  }

  if (segments.length >= ROUND_TIMESTAMP_MIN_SEGMENTS) {
    const allRound = segments.every((s) => Number(s.startMs) % 1000 === 0);
    if (allRound) {
      return {
        kind: "timings-untrusted",
        reason: `all ${segments.length} segment starts land on a whole second - timings were estimated`,
      };
    }
  }

  return { kind: "ok" };
}
