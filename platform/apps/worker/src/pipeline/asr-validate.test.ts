import { describe, expect, it } from "vitest";
import type { AsrSegment } from "./asr";
import { validateAsr } from "./asr-validate";

/**
 * The inline ASR provider fails without saying so.
 *
 * Every case below is taken from a measured run of gemini-3.5-flash-lite against
 * real TNPSC Mentors calls (Tamil, 96-286s). All of them came back with
 * `finishReason: STOP` and a populated `segments` array, so before this
 * validator existed each one would have been persisted as a good transcript.
 * The numbers in these tests are the real observed ones, not invented shapes -
 * if a threshold is ever retuned, these are the cases it has to keep catching.
 */

const seg = (speaker: string, text: string, startMs: number, endMs: number): AsrSegment => ({
  speaker,
  text,
  startMs,
  endMs,
});

/** A healthy run: 24 segments, ~9 words each, timeline inside the audio. */
const healthy = (count = 24): AsrSegment[] =>
  Array.from({ length: count }, (_, i) =>
    seg(
      i % 2 === 0 ? "S1" : "S2",
      "ninga ipa enna exam mam apply pannirukeenga group two",
      i * 3_500 + 120,
      i * 3_500 + 3_200,
    ),
  );

describe("validateAsr", () => {
  it("accepts a healthy transcript", () => {
    expect(validateAsr(healthy(), 96)).toEqual({ kind: "ok" });
  });

  it("rejects an empty segment list", () => {
    expect(validateAsr([], 96)).toMatchObject({ kind: "reject" });
  });

  it("rejects segments that carry no words", () => {
    const blank = Array.from({ length: 6 }, (_, i) => seg("S1", "   ", i * 1000, i * 1000 + 500));
    expect(validateAsr(blank, 96)).toMatchObject({ kind: "reject" });
  });

  describe("collapse - plausible shape, most of the speech gone", () => {
    /**
     * Observed on the 192s call: 24 segments, 69 words, 86% of the conversation
     * lost. The response was single keywords - "exam", "okay", "institute".
     */
    it("rejects 69 words across 24 segments", () => {
      const collapsed = Array.from({ length: 24 }, (_, i) =>
        seg("S1", i % 3 === 0 ? "exam mam" : "okay", i * 4_000, i * 4_000 + 400),
      );
      const v = validateAsr(collapsed, 192);
      expect(v.kind).toBe("reject");
      expect(v.kind === "reject" && v.reason).toMatch(/collapsed/);
    });

    /** Observed on the 151s call: 149 segments of exactly one word each. */
    it("rejects one-word-per-segment output", () => {
      const fragments = Array.from({ length: 149 }, (_, i) => seg("S1", "test", i * 1000, i * 1000 + 300));
      expect(validateAsr(fragments, 151)).toMatchObject({ kind: "reject" });
    });

    /**
     * The floor must not fire on a genuinely short exchange. A wrong-number call
     * is three short turns and is a correct transcript, not a collapse - which is
     * why the check needs a minimum segment count before it applies.
     */
    it("accepts a genuinely brief call", () => {
      const brief = [seg("S1", "hello", 200, 900), seg("S2", "wrong number", 1_200, 2_400)];
      expect(validateAsr(brief, 4)).toEqual({ kind: "ok" });
    });
  });

  describe("fabricated timings - words worth keeping, clock invented", () => {
    /**
     * Observed on the 286s call: a timeline ending at 437s. The text was fine
     * (97% of Sarvam's word count), so this must NOT be rejected - it downgrades
     * to untrusted timings, which is what makes the talk-metrics gate skip it.
     */
    it("flags a timeline that runs past the end of the audio", () => {
      const over = healthy(24).map((s, i) => seg(s.speaker, s.text, i * 18_000, i * 18_000 + 17_000));
      const v = validateAsr(over, 286);
      expect(v.kind).toBe("timings-untrusted");
      expect(v.kind === "timings-untrusted" && v.reason).toMatch(/timeline ends at/);
    });

    it("tolerates a small overshoot rather than calling it fabrication", () => {
      const nudged = healthy(10).map((s) => seg(s.speaker, s.text, s.startMs, s.endMs));
      nudged[9] = seg("S2", nudged[9].text, 34_000, 35_500);
      expect(validateAsr(nudged, 35)).toEqual({ kind: "ok" });
    });

    /**
     * Observed on the 96s call: every startMs an exact multiple of 1000 - 0,
     * 1000, 3000, 5000, 8000. Real boundaries do not do that.
     */
    it("flags timestamps that all land on a whole second", () => {
      const round = Array.from({ length: 12 }, (_, i) =>
        seg(i % 2 === 0 ? "S1" : "S2", "ninga ipa enna exam mam apply pannirukeenga", i * 2_000, i * 2_000 + 1_000),
      );
      const v = validateAsr(round, 96);
      expect(v.kind).toBe("timings-untrusted");
      expect(v.kind === "timings-untrusted" && v.reason).toMatch(/whole second/);
    });

    it("does not read too much into round numbers on a short transcript", () => {
      const few = Array.from({ length: 5 }, (_, i) =>
        seg("S1", "ninga ipa enna exam mam apply pannirukeenga", i * 2_000, i * 2_000 + 1_500),
      );
      expect(validateAsr(few, 12)).toEqual({ kind: "ok" });
    });

    /** Observed: endMs missing on 18 of 19 segments. */
    it("flags missing timestamps", () => {
      const noEnd = healthy(10).map((s) => ({ ...s, endMs: undefined as unknown as number }));
      const v = validateAsr(noEnd, 96);
      expect(v.kind).toBe("timings-untrusted");
      expect(v.kind === "timings-untrusted" && v.reason).toMatch(/missing or non-numeric/);
    });
  });

  it("skips the overrun check when the duration is unknown rather than assuming one", () => {
    // Offsets are deliberately not round here: this asserts the overrun rule is
    // skipped, and round starts would trip the separate fabrication rule instead.
    const over = healthy(24).map((s, i) => seg(s.speaker, s.text, i * 18_000 + 137, i * 18_000 + 17_042));
    expect(validateAsr(over, null)).toEqual({ kind: "ok" });
  });

  it("checks collapse before timings, so a collapsed run is retried not half-kept", () => {
    // Both wrong at once: fragments AND a timeline past the end of the audio.
    // A collapse is the more serious verdict and has to win.
    const both = Array.from({ length: 30 }, (_, i) => seg("S1", "okay", i * 20_000, i * 20_000 + 1_000));
    expect(validateAsr(both, 96)).toMatchObject({ kind: "reject" });
  });
});
