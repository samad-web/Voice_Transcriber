import { describe, expect, it } from "vitest";

import {
  ASR_LANGUAGE_LABELS,
  ASR_LANGUAGES,
  ASR_MODE_DEFAULT,
  ASR_MODE_OPTIONS,
  ASR_MODES,
  AsrLanguage,
  asrLanguageOptions,
  normaliseVocabulary,
  VOCABULARY_MAX,
} from "./asr";

/**
 * The transcription settings both consoles read.
 *
 * The point of this module is that the operator console and the client console
 * offer the SAME options - they had already drifted by six languages when the
 * lists lived in two files. These tests pin the properties that keep them from
 * drifting again, rather than freezing the list itself, which is expected to
 * grow.
 */

describe("the language list", () => {
  it("labels every code it accepts", () => {
    // The drift that actually happened: the API took 24 codes and the console
    // offered 18, so six languages were storable but not selectable. A missing
    // label now renders as `undefined` in a dropdown, so this is the assertion
    // that would have caught it.
    for (const code of ASR_LANGUAGES) {
      expect([code, ASR_LANGUAGE_LABELS[code]?.length > 0]).toEqual([code, true]);
    }
  });

  it("offers exactly the codes it accepts - no more, no fewer", () => {
    const offered = asrLanguageOptions().map((o) => o.code);
    expect([...offered].sort()).toEqual([...ASR_LANGUAGES].sort());
  });

  it("puts auto-detect first, then sorts by label rather than by code", () => {
    // A dropdown of two dozen languages is scanned by NAME. Ordered by BCP-47
    // code, Assamese sits under "as" between Punjabi and Urdu - sensible only
    // to somebody who already knows the code.
    const options = asrLanguageOptions();
    expect(options[0].code).toBe("unknown");

    const labels = options.slice(1).map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("gives every language a distinct label", () => {
    const labels = Object.values(ASR_LANGUAGE_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("accepts every listed code through the zod schema", () => {
    for (const code of ASR_LANGUAGES) {
      expect([code, AsrLanguage.safeParse(code).success]).toEqual([code, true]);
    }
    expect(AsrLanguage.safeParse("fr-FR").success).toBe(false);
  });
});

describe("the transcript styles", () => {
  it("only ever OFFERS modes the API would accept", () => {
    // The subset direction that matters. Offering a mode the API rejects means
    // a customer picks it, saves, and gets a zod error they cannot act on.
    for (const option of ASR_MODE_OPTIONS) {
      expect([option.code, ASR_MODES.includes(option.code)]).toEqual([option.code, true]);
    }
  });

  it("leaves `translit` accepted but not offered, deliberately", () => {
    // Documented in asr.ts: the API and 0016's CHECK take it, but nobody has
    // confirmed what Saaras actually returns, and a guessed description in
    // front of a paying customer is worse than one missing option. This test
    // exists so removing it is a decision rather than an accident.
    expect(ASR_MODES).toContain("translit");
    expect(ASR_MODE_OPTIONS.map((m) => m.code)).not.toContain("translit");
  });

  it("describes every mode it offers", () => {
    for (const option of ASR_MODE_OPTIONS) {
      expect([option.code, option.label.length > 0 && option.blurb.length > 0]).toEqual([
        option.code,
        true,
      ]);
    }
  });

  it("defaults to a mode that is actually on offer", () => {
    expect(ASR_MODE_OPTIONS.map((m) => m.code)).toContain(ASR_MODE_DEFAULT);
  });
});

describe("normaliseVocabulary", () => {
  it("trims, and drops blanks entirely", () => {
    expect(normaliseVocabulary(["  RD Interlock  ", "", "   ", "Salem"])).toEqual([
      "RD Interlock",
      "Salem",
    ]);
  });

  it("de-duplicates case-insensitively but KEEPS the first spelling", () => {
    // The whole list exists to fix spelling, so the casing somebody typed is
    // the data - folding it to lower case would defeat the feature. Two
    // entries differing only by case are still one term, though: they would
    // tell the analyser two different things about the same word.
    expect(normaliseVocabulary(["RD Interlock", "rd interlock", "RD INTERLOCK"])).toEqual([
      "RD Interlock",
    ]);
  });

  it("preserves order otherwise", () => {
    expect(normaliseVocabulary(["Cheyyur", "Salem", "Chennai"])).toEqual([
      "Cheyyur",
      "Salem",
      "Chennai",
    ]);
  });

  it("caps the list at the API's own maximum", () => {
    const many = Array.from({ length: VOCABULARY_MAX + 25 }, (_, i) => `term-${i}`);
    expect(normaliseVocabulary(many)).toHaveLength(VOCABULARY_MAX);
  });

  it("is idempotent - normalising twice changes nothing", () => {
    const once = normaliseVocabulary([" A ", "a", "B", ""]);
    expect(normaliseVocabulary(once)).toEqual(once);
  });

  it("survives an empty list", () => {
    expect(normaliseVocabulary([])).toEqual([]);
  });
});
