import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GoldenFixture,
  REQUIRED_FIXTURE_TAGS,
  type GoldenFixture as Fixture,
} from "./agent-eval";
import {
  bestInstant,
  resolveTimePhrase,
  type ResolverContext,
} from "./time-phrases";
import { isAmountActionable, resolveAmountPhrase } from "./amount-phrases";
import { intentSpec, isKnownIntent, verifyIntents } from "./transcript-agent";
import { prepareTranscript } from "./transcript-redaction";

/**
 * §13.1/§13.2's GOLDEN SET, RUN AS A TEST.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS GATES, AND WHAT IT CANNOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Everything between the model's answer and the plan: that an evidence quote
 * really appears in the transcript, that a PHRASE is what the model emitted
 * (never a timestamp), that the resolvers turn each phrase into the instant
 * and the amount the case says they should, and that redaction fires on the
 * cases that carry a secret.
 *
 * The planner's half lives in the worker's `golden-replay.test.ts`, because the
 * planner does - running it from here would mean a second copy of the worker's
 * resolve-and-plan sequence, and the copy is what would be green.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE FIXTURES THEMSELVES ARE CHECKED, NOT TRUSTED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A golden set is only worth what its labels are worth, and a mistyped quote
 * or an ISO string left in a `when_text` makes a case that passes while
 * testing nothing. So the suite asserts the SHAPE of every fixture before it
 * asserts anything about the code: every quote verifiable, every slot a
 * phrase, every intent type one the catalogue knows, every id matching its
 * filename.
 */

const DIR = join(__dirname, "fixtures", "transcript-agent");

interface Loaded {
  file: string;
  fixture: Fixture;
}

const LOADED: Loaded[] = readdirSync(DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    // Parsed through the schema, so a fixture that would be rejected at
    // runtime cannot sit in the folder looking like coverage.
    fixture: GoldenFixture.parse(JSON.parse(readFileSync(join(DIR, file), "utf8"))),
  }));

function contextFor(fixture: Fixture, tense: "past" | "future" | null): ResolverContext {
  return {
    reference: new Date(fixture.reference),
    timeZone: fixture.timeZone,
    // §18's calling hours, which is what a floor with no policy of its own
    // gets. The fixtures are deliberately written against the defaults: a case
    // that only resolves under one tenant's hours is that tenant's case.
    dayStartMinute: 9 * 60,
    dayEndMinute: 21 * 60,
    workingWeekdays: [1, 2, 3, 4, 5, 6],
    holidays: [],
    tense,
  };
}

/**
 * The intent of this type the PLAN would act on - never a superseded one.
 *
 * §6: "the last confirmed statement wins; earlier ones are recorded as
 * superseded." A change-of-mind case carries both readings, and looking the
 * expectation up by type alone would check the resolver against the time the
 * customer took back.
 */
function activeIntent(fixture: Fixture, type: string) {
  const active = fixture.understanding.intents.filter(
    (intent) => intent.type === type && intent.superseded !== true,
  );
  return active.at(-1) ?? null;
}

/** The tense the pipeline would use: the catalogue's direction, else the model's. */
function tenseFor(fixture: Fixture, type: string): "past" | "future" | null {
  const spec = isKnownIntent(type) ? intentSpec(type as never) : null;
  return spec?.timeDirection ?? fixture.understanding.tense ?? null;
}

describe("the golden set is a real set", () => {
  it("has fixtures at all - an empty folder would pass every assertion below", () => {
    expect(LOADED.length).toBeGreaterThanOrEqual(15);
  });

  it("names every file after the case inside it", () => {
    for (const { file, fixture } of LOADED) {
      expect(`${fixture.id}.json`).toBe(file);
    }
  });

  it("covers every category the spec asks for", () => {
    // §19's fixture line and §13.1's list, as `REQUIRED_FIXTURE_TAGS`. A
    // category that loses its last fixture fails HERE rather than quietly
    // reducing what the gate measures.
    const present = new Set(LOADED.flatMap(({ fixture }) => fixture.tags));
    const missing = REQUIRED_FIXTURE_TAGS.filter((tag) => !present.has(tag));
    expect(missing).toEqual([]);
  });

  it("uses only intent types the catalogue knows", () => {
    for (const { file, fixture } of LOADED) {
      for (const intent of fixture.understanding.intents) {
        expect({ file, type: intent.type, known: isKnownIntent(intent.type) }).toEqual({
          file,
          type: intent.type,
          known: true,
        });
      }
    }
  });

  it("agrees with itself about what the model said and what should happen", () => {
    // Every expected intent has to correspond to one the recorded understanding
    // actually contains (allowing for superseded ones being dropped), or the
    // case is asserting an outcome from an input that does not produce it.
    for (const { file, fixture } of LOADED) {
      const offered = fixture.understanding.intents
        .filter((intent) => intent.superseded !== true)
        .map((intent) => intent.type);
      for (const expected of fixture.expected.intents) {
        expect({ file, type: expected.type, offered: offered.includes(expected.type) }).toEqual({
          file,
          type: expected.type,
          offered: true,
        });
      }
    }
  });
});

describe("§6: every quote in a fixture is really in its transcript", () => {
  it("keeps every recorded intent through evidence verification", () => {
    // The check the pipeline applies for real. A fixture whose quote is a
    // paraphrase would have its intent DISCARDED at runtime, so the case would
    // be testing the discard path while claiming to test a booking.
    for (const { file, fixture } of LOADED) {
      const { kept, discarded } = verifyIntents(
        fixture.understanding.intents,
        fixture.transcript,
      );
      expect({ file, discarded: discarded.map((d) => d.quote) }).toEqual({
        file,
        discarded: [],
      });
      expect(kept).toHaveLength(fixture.understanding.intents.length);
    }
  });
});

describe("§7: the model emits phrases, never resolved values", () => {
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

  it("has no timestamp in any time slot", () => {
    // The rule the schema enforces by naming (`when_text`, not `when`) and the
    // fixtures have to honour too: a case with an ISO string in `when_text`
    // would pass the resolver gate below while proving the resolver does
    // nothing.
    for (const { file, fixture } of LOADED) {
      for (const intent of fixture.understanding.intents) {
        for (const slot of ["when_text", "by_text"] as const) {
          const value = intent.slots[slot];
          if (value) expect({ file, slot, iso: ISO.test(value) }).toEqual({ file, slot, iso: false });
        }
      }
    }
  });

  it("has no bare minor-unit integer in an amount slot", () => {
    for (const { file, fixture } of LOADED) {
      for (const intent of fixture.understanding.intents) {
        const value = intent.slots.amount_text;
        if (!value) continue;
        // "250000" as a slot would mean the model did the lakh conversion,
        // which is the resolver's job and the one §7 names outright.
        expect({ file, value, bare: /^\d{5,}$/.test(value.trim()) }).toEqual({
          file,
          value,
          bare: false,
        });
      }
    }
  });
});

describe("§7.1: the date resolver produces what each case says it should", () => {
  it("resolves every asserted dueAt to the instant the case names", () => {
    for (const { file, fixture } of LOADED) {
      for (const expected of fixture.expected.intents) {
        if (!expected.dueAt) continue;
        const intent = activeIntent(fixture, expected.type);
        const phrase = intent?.slots.when_text ?? intent?.slots.by_text ?? null;
        expect({ file, type: expected.type, phrase: phrase !== null }).toEqual({
          file,
          type: expected.type,
          phrase: true,
        });

        const resolved = resolveTimePhrase(
          phrase ?? "",
          contextFor(fixture, tenseFor(fixture, expected.type)),
        );
        const actual = bestInstant(resolved)?.toISOString() ?? null;
        expect({ file, type: expected.type, at: actual }).toEqual({
          file,
          type: expected.type,
          at: expected.dueAt,
        });
      }
    }
  });

  it("produces the resolution SHAPE each case names, where it names one", () => {
    // Exact versus window is not cosmetic: §10A.1 gives a window callback a
    // different lifecycle, and §8.1 refuses to book an appointment from one.
    for (const { file, fixture } of LOADED) {
      for (const expected of fixture.expected.intents) {
        if (!expected.resolution) continue;
        const intent = activeIntent(fixture, expected.type);
        const phrase = intent?.slots.when_text ?? intent?.slots.by_text ?? "";
        const resolved = resolveTimePhrase(phrase, contextFor(fixture, tenseFor(fixture, expected.type)));
        expect({ file, type: expected.type, kind: resolved.kind }).toEqual({
          file,
          type: expected.type,
          kind: expected.resolution,
        });
      }
    }
  });
});

describe("§7.2: the amount resolver produces what each case says it should", () => {
  it("resolves every asserted amount to the minor units the case names", () => {
    for (const { file, fixture } of LOADED) {
      for (const expected of fixture.expected.intents) {
        if (expected.amountMinor === null || expected.amountMinor === undefined) continue;
        const intent = activeIntent(fixture, expected.type);
        const phrase = intent?.slots.amount_text ?? "";
        const resolved = resolveAmountPhrase(phrase, { totalsMinor: [] });
        const actual = isAmountActionable(resolved) ? resolved.amountMinor : null;
        expect({ file, type: expected.type, amountMinor: actual }).toEqual({
          file,
          type: expected.type,
          amountMinor: expected.amountMinor,
        });
      }
    }
  });
});

describe("§14: redaction and injection, on the cases that carry them", () => {
  it("masks what each privacy case says must be masked", () => {
    for (const { file, fixture } of LOADED) {
      if (!fixture.privacy) continue;
      const prepared = prepareTranscript(fixture.transcript);
      const fired = Object.entries(prepared.counts)
        .filter(([, count]) => count > 0)
        .map(([kind]) => kind)
        .sort();
      expect({ file, fired }).toEqual({ file, fired: [...fixture.privacy.masked].sort() });
    }
  });

  it("lets nothing a privacy case forbids reach the model's input", () => {
    // The assertion that matters. `counts` could be right while the number
    // itself survived somewhere the masker did not look, and what goes to the
    // provider is `forModel`.
    for (const { file, fixture } of LOADED) {
      if (!fixture.privacy) continue;
      const prepared = prepareTranscript(fixture.transcript);
      for (const secret of fixture.privacy.mustNotLeak) {
        expect({ file, secret, leaked: prepared.forModel.includes(secret) }).toEqual({
          file,
          secret,
          leaked: false,
        });
      }
    }
  });

  it("detects an injection exactly on the cases that have one", () => {
    for (const { file, fixture } of LOADED) {
      const prepared = prepareTranscript(fixture.transcript);
      const declared = fixture.privacy?.injection ?? false;
      // Both directions. A detector that fires on every transcript would pass
      // the injection case and make every other case a false positive, which
      // in production means every call routed to review.
      expect({ file, detected: prepared.injection.length > 0 }).toEqual({
        file,
        detected: declared,
      });
    }
  });
});
