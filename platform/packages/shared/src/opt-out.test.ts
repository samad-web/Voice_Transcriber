import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { ConversationChannel } from "./conversations";
import { OptOutChannel, isOptOut, isProbableOptOut, normalizeMessage, readOptOut } from "./opt-out";

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

/**
 * THE CHECK/ZOD DRIFT TRAP, PINNED.
 *
 * `messaging_opt_outs.channel` has a CHECK constraint in SQL and, since the
 * call-suppression work, a zod enum here. Widening one and not the other throws
 * 23514 at runtime and reads like a bug in the caller - which is what happened
 * to `notifications.kind`, in both directions at once, and it broke lead
 * routing while every type-check and lint stayed green.
 *
 * So it is pinned twice, because the two pins fail in different directions:
 *
 *   - the literal below, transcribed by hand from the migration, which fails
 *     when the ENUM is widened without the constraint;
 *   - the constraint's own values, read out of the .sql, which fails when the
 *     CONSTRAINT is widened without the enum.
 *
 * Either one alone leaves a hole, and the hole is the 23514. Reading the SQL
 * follows the pattern call-issues.test.ts and call-escalations.test.ts already
 * use for exactly this job - each keeps its own copy of the walk-up and the
 * parse, which is the convention here rather than an accident.
 */
describe("the channel enum and the database CHECK are the same set", () => {
  /**
   * Verbatim from `0158_call_suppression_and_dnc.sql`:
   *
   *     ALTER TABLE messaging_opt_outs DROP CONSTRAINT IF EXISTS messaging_opt_outs_channel_check;
   *     ALTER TABLE messaging_opt_outs ADD CONSTRAINT messaging_opt_outs_channel_check
   *       CHECK (channel IN ('whatsapp', 'sms', 'email', 'call', 'instagram', 'facebook'));
   *
   * Change this list ONLY while changing that statement, and vice versa.
   *
   * 'instagram' and 'facebook' joined when 0158 closed the live 23514 described
   * on `OptOutChannel` - an Instagram "unsubscribe" used to throw and the
   * request was lost. This constant listing only four is what caught that the
   * two sides had moved apart, which is the whole reason it is transcribed by
   * hand next to a reader that parses the real migration.
   */
  const CHANNELS_IN_DB_CHECK = [
    "whatsapp",
    "sms",
    "email",
    "call",
    "instagram",
    "facebook",
  ];

  /** Same walk-up as call-escalations.test.ts - the package compiles as CommonJS. */
  const MIGRATIONS_DIR = (() => {
    let dir = resolve(process.cwd());
    for (let up = 0; up < 6; up++) {
      const candidate = join(dir, "packages", "db", "migrations");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error("packages/db/migrations not found above " + process.cwd());
  })();

  /**
   * Every migration, comments stripped, whitespace flattened, in APPLY order -
   * so the last named CHECK on the column is the one the live database holds.
   * 0111 declared this constraint inline and 0158 replaced it with a named one;
   * taking the last match is what makes the next widening work the same way.
   */
  const CHANNEL_CHECK_IN_SQL = (() => {
    const flat = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n")
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ");
    const all = [
      ...flat.matchAll(
        /ADD CONSTRAINT messaging_opt_outs_channel_check CHECK \(channel IN \(([^)]*)\)/g,
      ),
    ];
    if (all.length === 0) return null;
    return Array.from(all[all.length - 1][1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
  })();

  it("matches the messaging_opt_outs_channel_check values exactly", () => {
    expect([...OptOutChannel.options].sort()).toEqual([...CHANNELS_IN_DB_CHECK].sort());
  });

  it("matches the CHECK the migrations actually declare", () => {
    // Null would mean the named constraint has vanished from the tree - a
    // renumbered or reverted 0158 - which must fail rather than quietly skip.
    // A skipped assertion is how the tenant-isolation suite rotted unseen.
    expect(CHANNEL_CHECK_IN_SQL, "no ADD CONSTRAINT messaging_opt_outs_channel_check").not.toBeNull();
    expect(CHANNEL_CHECK_IN_SQL).toEqual([...CHANNELS_IN_DB_CHECK].sort());
    expect(CHANNEL_CHECK_IN_SQL).toEqual([...OptOutChannel.options].sort());
  });

  it("includes 'call', which is the whole point of 0158", () => {
    // A tenant's customer saying "stop calling me" has to land somewhere, and
    // the dialer's suppression predicate reads this channel and no other.
    expect(OptOutChannel.options).toContain("call");
    expect(OptOutChannel.safeParse("call").success).toBe(true);
  });

  it("rejects a channel the column would refuse", () => {
    expect(OptOutChannel.safeParse("telegram").success).toBe(false);
    expect(OptOutChannel.safeParse("voice").success).toBe(false);
    expect(OptOutChannel.safeParse("").success).toBe(false);
  });

  /**
   * The messaging half of this set is a subset of the inbox's channels, because
   * an opt-out arrives on a thread. 'call' is the one value with no thread
   * behind it - it is recorded from a call disposition or by hand.
   */
  it("spells its messaging channels the way the inbox spells them", () => {
    for (const channel of OptOutChannel.options) {
      if (channel === "call") continue;
      expect(ConversationChannel.options).toContain(channel);
    }
  });

  /**
   * And the direction that is still broken, stated rather than asserted away.
   *
   * `recordOptOut` in conversations.service.ts inserts the inbound message's
   * channel into this column, so an Instagram or Messenger user typing
   * "unsubscribe" hits the CHECK and 23514s. That predates this enum and fixing
   * it is a decision about those two channels - widen the constraint, or
   * suppress them somewhere else - so it is pinned here as a known gap instead
   * of being silently widened by the dialer's migration.
   */
  it("covers every ConversationChannel, so no inbox can drop an opt-out", () => {
    const missing = ConversationChannel.options.filter(
      (c) => !(OptOutChannel.options as readonly string[]).includes(c),
    );
    // Empty, and it must stay empty. `recordOptOut` inserts an inbound
    // message's channel into messaging_opt_outs.channel unfiltered, so any
    // ConversationChannel value absent from the CHECK is a 23514 that throws
    // away somebody's request to be left alone. 'instagram' and 'facebook' were
    // exactly that bug until 0158; a seventh inbox channel would be the next
    // one, and this is the assertion that catches it before production does.
    expect(missing).toEqual([]);
  });
});
