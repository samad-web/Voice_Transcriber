import { describe, expect, it } from "vitest";
import { isOptOut, isProbableOptOut, normalizeMessage, readOptOut } from "./opt-out";

/**
 * The false-positive block is the point of this file.
 *
 * A keyword hunt passes every "does it detect an opt-out" test anybody writes.
 * It only fails on the sentences below - the ordinary things customers write to
 * a clinic, a dealership or a builder - and it fails by silently deleting the
 * customer from the conversation. So these come first.
 */
describe("messages that must NEVER be read as opt-outs", () => {
  const INNOCENT = [
    // The measured clinic rows that motivated the whole module.
    "is there any way to stop the pain?",
    "can I leave before 3pm?",
    "I need to leave the appointment early",
    // "cancel" in its ordinary English sense, which is the overwhelming majority.
    "I want to cancel my appointment",
    "please cancel my order",
    "can I cancel and rebook for Friday?",
    "cancel the second item only",
    // "remove" and "delete" about the ORDER, not about the list.
    "remove the extra cheese please",
    "can you delete the duplicate booking",
    "please remove one chair from the quote",
    // "stop" about the world.
    "the lift has stopped working",
    "we stop work at 6pm",
    "my car stopped in the middle of the road",
    // These four caught a real false positive in the first draft of the
    // ambiguous patterns, which matched a bare "please stop" and "stop this"
    // anywhere in a sentence. A trigger word is only about the conversation
    // when the message ENDS on it; past that, the continuation is the subject.
    "please stop by the shop tomorrow",
    "please stop this bleeding",
    "is 500 enough for the deposit?",
    "we want no more delays on this order",
    // "end" and "out"
    "when does the offer end?",
    "I am out of town this week",
    "the medicine is out of stock",
    // Ordinary business replies that happen to contain a trigger word.
    "ok stop worrying I will pay today",
    "no problem, send me the invoice",
  ];

  for (const message of INNOCENT) {
    it(`leaves alone: "${message}"`, () => {
      expect(isOptOut(message)).toBe(false);
      // And not even the conservative level, which would silence the bot on a
      // customer who is asking a question and waiting for an answer.
      expect(isProbableOptOut(message)).toBe(false);
    });
  }
});

describe("the bare keyword, which is the channel's own convention", () => {
  const BARE = ["STOP", "stop", "Stop.", "STOP!", " stop ", "unsubscribe", "OPTOUT", "Remove me"];

  for (const message of BARE) {
    it(`honours: "${message}"`, () => {
      // A template footer that says "Reply STOP to opt out" is a promise the
      // business made with Meta's approval. Ignoring it generates spam reports,
      // and a spam report costs the quality rating that gates every future
      // template approval - so this is not a preference.
      expect(isOptOut(message)).toBe(true);
    });
  }

  it("does not honour the same word inside a sentence", () => {
    // The entire distinction. "cancel" alone is the convention; "cancel my
    // order" is a Tuesday.
    expect(isOptOut("cancel")).toBe(false); // not in the keyword set - too dangerous in English
    expect(isOptOut("stop the car")).toBe(false);
    expect(isOptOut("unsubscribe me from the newsletter")).toBe(true); // has the object
  });
});

describe("a verb of cessation WITH an object of communication", () => {
  const REAL = [
    "please stop sending me messages",
    "stop messaging me",
    "stop texting me please",
    "don't contact me again",
    "dont send me any more offers",
    "I no longer wish to receive these",
    "I don't want to receive anything from you",
    "remove my number from your list",
    "please take me off your broadcast list",
    "delete me from your database",
    "unsubscribe me from all promotions",
    "stop all communication",
    "stop sending promotions",
    "not interested in receiving any more",
    // Bare "no more" is ambiguous and stays in the other tier; the object is
    // what makes this one certain.
    "no more messages please",
  ];

  for (const message of REAL) {
    it(`detects: "${message}"`, () => {
      expect(isOptOut(message)).toBe(true);
      expect(readOptOut(message)).toEqual({ level: "certain" });
    });
  }
});

describe("the ambiguous half stops the machine but does not silence the person", () => {
  const MAYBE = [
    "leave me alone",
    "enough",
    "that's enough",
    "stop it",
    "ok please stop",
    "don't disturb me",
    "not interested",
    "no more",
  ];

  for (const message of MAYBE) {
    it(`holds but does not record: "${message}"`, () => {
      // "Leave me alone" is usually an opt-out and occasionally an angry
      // customer who wants a HUMAN immediately. Silencing them on a guess is
      // the one outcome the person who knew the difference cannot undo.
      expect(isProbableOptOut(message)).toBe(true);
      expect(isOptOut(message)).toBe(false);
      expect(readOptOut(message)).toEqual({ level: "probable" });
    });
  }
});

describe("normalizeMessage", () => {
  it("folds case, accents and runs of whitespace", () => {
    expect(normalizeMessage("  STOP   SENDING  ")).toBe("stop sending");
    expect(normalizeMessage("Não")).toBe("nao");
  });

  it("survives an empty or whitespace-only message", () => {
    // Media-only messages arrive with no body at all.
    expect(normalizeMessage("")).toBe("");
    expect(isOptOut("")).toBe(false);
    expect(isProbableOptOut("   ")).toBe(false);
    expect(readOptOut("")).toEqual({ level: "none" });
  });
});

describe("the two levels agree with each other", () => {
  it("makes certain a strict subset of probable", () => {
    // A caller using isProbableOptOut alone as "should the machine go quiet"
    // must never be quieter than one using isOptOut.
    for (const message of ["stop", "stop messaging me", "leave me alone", "cancel my order"]) {
      if (isOptOut(message)) expect(isProbableOptOut(message)).toBe(true);
    }
  });
});
