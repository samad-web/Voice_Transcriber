import { describe, expect, it } from "vitest";
import {
  CONFIRM_WORD,
  CONSOLE_STATES,
  STATE_TONE,
  callState,
  pipelineStage,
  typedWordFor,
} from "@aura/ui";

/**
 * The functional colour system's contract.
 *
 * Lives in `apps/web` rather than beside the kit because `@aura/ui` ships no
 * test runner of its own and adding one to a package with eleven files is a
 * worse trade than importing across the workspace boundary - which is exactly
 * how every consumer uses it anyway, so this exercises the real public entry
 * point rather than a relative path into `src/`.
 */

describe("callState - deriving a call's state from columns that have no 'missed'", () => {
  it("calls an inbound zero-second call missed", () => {
    expect(callState({ direction: "incoming", duration_s: 0, status: "COMPLETE" })).toBe("missed");
  });

  it("calls an inbound call that lasted answered", () => {
    expect(callState({ direction: "incoming", duration_s: 42, status: "COMPLETE" })).toBe(
      "answered",
    );
  });

  it("calls anything outbound outgoing, however long it lasted", () => {
    expect(callState({ direction: "outgoing", duration_s: 0, status: "COMPLETE" })).toBe("outgoing");
    expect(callState({ direction: "outgoing", duration_s: 300, status: "COMPLETE" })).toBe(
      "outgoing",
    );
  });

  it("lets FAILED_* win over the outcome - we cannot claim to know what we could not process", () => {
    expect(callState({ direction: "incoming", duration_s: 90, status: "FAILED_ASR" })).toBe("error");
    expect(callState({ direction: "outgoing", duration_s: 90, status: "FAILED_CRM" })).toBe("error");
  });

  it("does NOT treat a mid-pipeline status as an error", () => {
    // The single most consequential non-failure in this function: a call still
    // transcribing is a call that already happened, and painting it orange
    // would make a healthy dashboard look broken for ten minutes after every
    // call.
    for (const status of ["AWAITING_AUDIO", "TRANSCRIBING", "ANALYZING", "SYNCING"]) {
      expect([status, callState({ direction: "incoming", duration_s: 12, status })]).toEqual([
        status,
        "answered",
      ]);
    }
  });

  it("accepts the direction words that reach us from CTI webhooks and imports, not just the DB's two", () => {
    expect(callState({ direction: "INBOUND", duration_s: 5 })).toBe("answered");
    expect(callState({ direction: " Outbound ", duration_s: 0 })).toBe("outgoing");
    // packages/shared's telephony intake maps a provider's own "missed" onto
    // an inbound call; it must not be read here as an unknown direction.
    expect(callState({ direction: "missed", duration_s: 0 })).toBe("missed");
  });

  it("refuses to guess when the duration is unknown - an unmeasurable call is not a missed one", () => {
    // Number("") is 0, which would silently manufacture a missed call out of
    // every inbound row whose duration failed to serialise.
    expect(callState({ direction: "incoming", duration_s: "" })).toBe("neutral");
    expect(callState({ direction: "incoming", duration_s: null })).toBe("neutral");
    expect(callState({ direction: "incoming" })).toBe("neutral");
  });

  it("handles pg's string numerics, which is how duration arrives from some queries", () => {
    expect(callState({ direction: "incoming", duration_s: "0" })).toBe("missed");
    expect(callState({ direction: "incoming", duration_s: "17" })).toBe("answered");
  });

  it("is neutral for a direction it does not recognise", () => {
    expect(callState({ direction: "sideways", duration_s: 10 })).toBe("neutral");
    expect(callState({})).toBe("neutral");
  });
});

describe("STATE_TONE - the palette itself", () => {
  it("gives every state a distinct glyph, so colour is never the only encoding", () => {
    // WCAG 1.4.1, and the greyscale-screenshot case this market actually hits.
    // Comparing the rendered element objects is enough to catch a copy-paste
    // that leaves two states sharing one silhouette.
    const glyphs = CONSOLE_STATES.map((s) => JSON.stringify(STATE_TONE[s].glyph));
    expect(new Set(glyphs).size).toBe(CONSOLE_STATES.length);
  });

  it("keeps neutral genuinely colourless", () => {
    // The load-bearing assertion of the whole system: if "neutral" ever
    // acquires a hue, the four that have one stop meaning anything.
    expect(STATE_TONE.neutral.text).toBe("text-text");
    expect(STATE_TONE.neutral.chip).not.toMatch(/danger|success|accent|orange/);
  });

  it("assigns the four hues the brief specified and nothing else", () => {
    expect(STATE_TONE.missed.dot).toBe("bg-danger");
    expect(STATE_TONE.answered.dot).toBe("bg-success");
    expect(STATE_TONE.outgoing.dot).toBe("bg-outgoing");
    expect(STATE_TONE.error.dot).toBe("bg-orange");
  });

  it("spends no BRANDABLE token - white-labelling must not rewrite the alphabet", () => {
    // The one that actually bit: `outgoing` used to be `bg-accent`, and the
    // accent is replaced wholesale by a tenant's own hex (branding.ts). A
    // customer whose brand colour was red would have got red for "we rang
    // them" and red for "nobody picked up" - two opposite facts in one colour,
    // on the page where the distinction matters most.
    //
    // `kpi` is on the list for the same reason even though nothing uses it
    // here: a state must never be painted in the tile fill either.
    //
    // Plain substring matching over a regex, deliberately. The class strings
    // are a closed vocabulary written in this repo, so "does it contain
    // `bg-accent`" is the whole question - and a word-boundary regex assembled
    // from a template literal is one backslash away from matching nothing at
    // all and passing forever, which is the worst thing a guard test can do.
    const BRANDABLE = ["accent", "kpi", "bg", "bg-subtle"];
    const PREFIXES = ["bg-", "text-", "border-"];
    for (const state of CONSOLE_STATES) {
      const tone = STATE_TONE[state];
      const classes = `${tone.chip} ${tone.dot} ${tone.text}`.split(/[\s/]+/);
      for (const token of BRANDABLE) {
        const spent = classes.filter((c) =>
          PREFIXES.some(
            (p) =>
              c === `${p}${token}` ||
              ["subtle", "text", "fg", "hover"].some((s) => c === `${p}${token}-${s}`),
          ),
        );
        expect([state, token, spent]).toEqual([state, token, []]);
      }
    }
  });

  it("has exactly five states - a sixth is a design decision, not a merge", () => {
    expect(CONSOLE_STATES).toHaveLength(5);
  });
});

describe("pipelineStage - the microcopy behind a row that is mid-flight", () => {
  it("gives every working status a sentence, not just a word", () => {
    for (const status of ["AWAITING_AUDIO", "TRANSCODING", "TRANSCRIBING", "ANALYZING", "SYNCING"]) {
      const stage = pipelineStage(status);
      expect([status, stage.phase]).toEqual([status, "working"]);
      // The point of the copy: a reader must be told what to expect. A label
      // alone ("Transcribing") is what this replaced.
      expect(stage.hint.length).toBeGreaterThan(40);
    }
  });

  it("marks the four FAILED_* statuses as errors and says what survived", () => {
    for (const status of ["FAILED_TRANSCODE", "FAILED_ASR", "FAILED_ANALYZE", "FAILED_CRM"]) {
      expect([status, pipelineStage(status).phase]).toEqual([status, "error"]);
    }
  });

  it("leaves a settled call without a hint - a row reporting a fact needs no sentence", () => {
    expect(pipelineStage("COMPLETE")).toMatchObject({ phase: "settled", hint: "" });
  });

  it("treats an unknown status as working rather than as an error", () => {
    // A newer API than this build is not a failure, and painting it orange
    // would alarm somebody about a status we simply have not shipped copy for.
    const stage = pipelineStage("SOME_FUTURE_STATE");
    expect(stage.phase).toBe("working");
    expect(stage.label).toBe("SOME_FUTURE_STATE");
  });
});

describe("typedWordFor - which confirmations demand DELETE", () => {
  it("defaults ON for any danger-toned dialog", () => {
    // The enforcement mechanism: a new destructive action gets the gate by
    // FORGETTING rather than by remembering.
    expect(typedWordFor({ title: "Delete it?", tone: "danger" })).toBe(CONFIRM_WORD);
  });

  it("stays off for an ordinary confirmation", () => {
    expect(typedWordFor({ title: "Continue?" })).toBeNull();
    expect(typedWordFor({ title: "Continue?", tone: "default" })).toBeNull();
  });

  it("lets a call site opt out deliberately, and only deliberately", () => {
    expect(typedWordFor({ title: "Turn it off?", tone: "danger", requireTyped: false })).toBeNull();
  });

  it("lets a call site ask for a different word", () => {
    expect(typedWordFor({ title: "Purge?", tone: "danger", requireTyped: "PURGE" })).toBe("PURGE");
  });

  it("is null with no dialog open", () => {
    expect(typedWordFor(null)).toBeNull();
  });
});
