import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAYPARTS,
  RESOLVER_VERSION,
  type ResolverContext,
  type TimeResolution,
  bestInstant,
  isActionable,
  normalisePhrase,
  resolveTimePhrase,
} from "./time-phrases";
import { instantToWallTime } from "./time";

/**
 * §3 M3 and §19: "a table-driven unit test suite with at least 200 phrase cases
 * across the supported languages."
 *
 * ── THE REFERENCE INSTANT ───────────────────────────────────────────────────
 *
 * Friday 9 October 2026, 12:00 noon IST. Chosen so that every interesting
 * boundary is reachable from one fixture:
 *
 *   · midday, so a morning time has PASSED and an evening one has not - which
 *     is what exercises the roll-forward rule;
 *   · a Friday, so "Friday" is today, "Monday" is three days off and "weekend"
 *     is tomorrow;
 *   · the 9th, so "the 5th" is next month and "the 15th" is this one;
 *   · October, so "month end" is the 31st and "next month" is November.
 */
const ZONE = "Asia/Kolkata";
const REFERENCE = new Date("2026-10-09T06:30:00.000Z"); // 12:00 IST, Friday

const TODAY = "2026-10-09";
const TOMORROW = "2026-10-10";
const YESTERDAY = "2026-10-08";

function ctx(partial: Partial<ResolverContext> = {}): ResolverContext {
  return { reference: REFERENCE, timeZone: ZONE, ...partial };
}

/** "2026-10-10 17:00" - what the assertions read, in the org's own clock. */
function wall(iso: string): string {
  return instantToWallTime(iso, ZONE).replace("T", " ");
}

function at(dateKey: string, minuteOfDay: number): string {
  const h = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const m = String(minuteOfDay % 60).padStart(2, "0");
  return `${dateKey} ${h}:${m}`;
}

type Expectation =
  | { kind: "exact"; at: string }
  | { kind: "window"; start: string; end: string }
  | { kind: "ambiguous"; readings: string[] }
  | { kind: "unresolved" };

function describeResolution(r: TimeResolution): Expectation {
  if (r.kind === "exact") return { kind: "exact", at: wall(r.at) };
  if (r.kind === "window") return { kind: "window", start: wall(r.start), end: wall(r.end) };
  if (r.kind === "ambiguous") {
    return { kind: "ambiguous", readings: r.readings.map((x) => wall(x.start)) };
  }
  return { kind: "unresolved" };
}

const DAY_START = 9 * 60;
const DAY_END = 21 * 60;

/** A whole-day reading: a phrase that named a day and no hour. */
function wholeDay(dateKey: string): Expectation {
  return { kind: "window", start: at(dateKey, DAY_START), end: at(dateKey, DAY_END) };
}

function exact(dateKey: string, minuteOfDay: number): Expectation {
  return { kind: "exact", at: at(dateKey, minuteOfDay) };
}

function window(dateKey: string, start: number, end: number): Expectation {
  return { kind: "window", start: at(dateKey, start), end: at(dateKey, end) };
}

// ────────────────────────────────────────────────────────────────────────────
//  The table. [phrase, expectation, optional tense hint]
// ────────────────────────────────────────────────────────────────────────────

type Case = [string, Expectation, ("past" | "future" | null)?];

const CASES: Case[] = [
  // ── today ────────────────────────────────────────────────────────────────
  ["today", wholeDay(TODAY)],
  ["aaj", wholeDay(TODAY)],
  ["aj", wholeDay(TODAY)],
  ["Today", wholeDay(TODAY)],
  ["today please", wholeDay(TODAY)],
  ["aaj hi", wholeDay(TODAY)],
  ["today at 5", exact(TODAY, 17 * 60)],
  ["aaj 5 baje", exact(TODAY, 17 * 60)],
  ["aaj shaam", window(TODAY, 16 * 60, 20 * 60)],
  ["aaj shaam ko", window(TODAY, 16 * 60, 20 * 60)],
  ["today evening", window(TODAY, 16 * 60, 20 * 60)],
  ["today at 4:30", exact(TODAY, 16 * 60 + 30)],
  ["aaj dopahar", window(TODAY, 12 * 60, 16 * 60)],
  ["aaj raat", window(TODAY, 16 * 60, 20 * 60)],

  // ── tomorrow ─────────────────────────────────────────────────────────────
  ["tomorrow", wholeDay(TOMORROW)],
  ["tomorow", wholeDay(TOMORROW)],
  ["tmrw", wholeDay(TOMORROW)],
  ["tomorrow morning", window(TOMORROW, 9 * 60, 12 * 60)],
  ["tomorrow at 11", exact(TOMORROW, 11 * 60)],
  ["tomorrow at 3", exact(TOMORROW, 15 * 60)],
  ["tomorrow evening", window(TOMORROW, 16 * 60, 20 * 60)],
  ["tomorrow after 5", window(TOMORROW, 17 * 60, DAY_END)],
  ["kal", { kind: "ambiguous", readings: [at(TOMORROW, DAY_START), at(YESTERDAY, DAY_START)] }],
  ["kal", wholeDay(TOMORROW), "future"],
  ["kal", wholeDay(YESTERDAY), "past"],
  ["kal call karna", wholeDay(TOMORROW)],
  ["kal call karo", wholeDay(TOMORROW)],
  ["kal phone karna", wholeDay(TOMORROW)],
  ["kl call karna", wholeDay(TOMORROW)],
  ["kal shaam 5 baje call karna", exact(TOMORROW, 17 * 60)],
  ["kal shaam 5 baje", exact(TOMORROW, 17 * 60), "future"],
  ["kal shaam 5 baje ke baad", window(TOMORROW, 17 * 60, DAY_END), "future"],
  ["kal subah 10 baje", exact(TOMORROW, 10 * 60), "future"],
  ["kal dopahar 2 baje", exact(TOMORROW, 14 * 60), "future"],
  ["kal 11 baje", exact(TOMORROW, 11 * 60), "future"],
  ["kal shaam ko", window(TOMORROW, 16 * 60, 20 * 60), "future"],
  ["kal sham ko call karna", window(TOMORROW, 16 * 60, 20 * 60)],
  ["kal savere", window(TOMORROW, 9 * 60, 12 * 60), "future"],
  ["kal subah", window(TOMORROW, 9 * 60, 12 * 60), "future"],

  // ── yesterday ────────────────────────────────────────────────────────────
  ["yesterday", wholeDay(YESTERDAY)],
  ["yesterday evening", window(YESTERDAY, 16 * 60, 20 * 60)],
  ["day before yesterday", wholeDay("2026-10-07")],

  // ── day after ────────────────────────────────────────────────────────────
  ["day after tomorrow", wholeDay("2026-10-11")],
  ["day after tomorrow at 4", exact("2026-10-11", 16 * 60)],
  ["parso", { kind: "ambiguous", readings: [at("2026-10-11", DAY_START), at("2026-10-07", DAY_START)] }],
  ["parso", wholeDay("2026-10-11"), "future"],
  ["parson", wholeDay("2026-10-11"), "future"],
  ["parso call karna", wholeDay("2026-10-11")],
  ["parso 4 baje", exact("2026-10-11", 16 * 60), "future"],

  // ── weekdays ─────────────────────────────────────────────────────────────
  ["monday", wholeDay("2026-10-12")],
  ["next monday", wholeDay("2026-10-12")],
  ["next Monday at 11", exact("2026-10-12", 11 * 60)],
  ["somwar", wholeDay("2026-10-12")],
  ["somwar ko", wholeDay("2026-10-12")],
  ["agle somwar", wholeDay("2026-10-12")],
  ["tuesday", wholeDay("2026-10-13")],
  ["tues", wholeDay("2026-10-13")],
  ["mangalwar", wholeDay("2026-10-13")],
  ["wednesday", wholeDay("2026-10-14")],
  ["budhwar", wholeDay("2026-10-14")],
  ["thursday", wholeDay("2026-10-15")],
  ["guruwar", wholeDay("2026-10-15")],
  ["friday", wholeDay(TODAY)],
  ["shukrawar", wholeDay(TODAY)],
  ["next friday", wholeDay("2026-10-16")],
  ["saturday", wholeDay("2026-10-10")],
  ["shanivar", wholeDay("2026-10-10")],
  ["sunday", wholeDay("2026-10-11")],
  ["ravivar", wholeDay("2026-10-11")],
  ["itwar", wholeDay("2026-10-11")],
  ["this monday", wholeDay("2026-10-12")],
  ["friday ko aadha de dunga", wholeDay(TODAY)],
  ["monday morning", window("2026-10-12", 9 * 60, 12 * 60)],
  ["monday at 10", exact("2026-10-12", 10 * 60)],
  ["tuesday evening", window("2026-10-13", 16 * 60, 20 * 60)],

  // ── weekend / week ───────────────────────────────────────────────────────
  ["this weekend", wholeDay("2026-10-10")],
  ["weekend", wholeDay("2026-10-10")],
  ["next week", wholeDay("2026-10-12")],
  ["agle hafte", wholeDay("2026-10-12")],
  ["agle week", wholeDay("2026-10-12")],
  ["next week monday", wholeDay("2026-10-12")],
  ["in 2 weeks", wholeDay("2026-10-23")],
  ["do hafte baad", wholeDay("2026-10-23")],

  // ── relative days ────────────────────────────────────────────────────────
  ["in two days", wholeDay("2026-10-11")],
  ["in 2 days", wholeDay("2026-10-11")],
  ["do din baad", wholeDay("2026-10-11")],
  ["teen din baad", wholeDay("2026-10-12")],
  ["in 5 days", wholeDay("2026-10-14")],
  ["in 7 days", wholeDay("2026-10-16")],
  ["after 3 days", wholeDay("2026-10-12")],
  ["ek din baad", wholeDay(TOMORROW)],
  ["next working day", wholeDay("2026-10-10")],

  // ── explicit dates ───────────────────────────────────────────────────────
  ["2026-10-15", wholeDay("2026-10-15")],
  ["15 october", wholeDay("2026-10-15")],
  ["october 15", wholeDay("2026-10-15")],
  ["15th october", wholeDay("2026-10-15")],
  ["oct 20", wholeDay("2026-10-20")],
  ["20 oct", wholeDay("2026-10-20")],
  ["15/10", wholeDay("2026-10-15")],
  ["15-10-2026", wholeDay("2026-10-15")],
  ["1 november", wholeDay("2026-11-01")],
  ["jan 20", wholeDay("2027-01-20")],
  ["20 january", wholeDay("2027-01-20")],
  ["december 1", wholeDay("2026-12-01")],
  ["the 15th", wholeDay("2026-10-15")],
  ["on the 15th", wholeDay("2026-10-15")],
  ["the 5th", wholeDay("2026-11-05")],
  ["on the 25th", wholeDay("2026-10-25")],
  ["after the 15th", wholeDay("2026-10-15")],
  ["15 taarikh ke baad", wholeDay("2026-10-15")],
  ["15 tarikh ke baad", wholeDay("2026-10-15")],
  // "N taarikh ko" with NO ordinal suffix - the common form on an Indian
  // floor, and one the resolver read as nothing at all until it was added.
  // `taarikh` is the marker that makes it a date rather than a duration, which
  // is why these resolve while "2 ghante baad" below stays a duration.
  ["15 taarikh ko", wholeDay("2026-10-15")],
  ["15 tarikh ko", wholeDay("2026-10-15")],
  ["15 taarikh", wholeDay("2026-10-15")],
  ["15 तारीख को", wholeDay("2026-10-15")],
  ["5 taarikh ko", wholeDay("2026-11-05")],
  ["15 taarikh ko shaam 6 baje", exact("2026-10-15", 18 * 60)],
  ["the 15th at 4", exact("2026-10-15", 16 * 60)],
  ["31 february", { kind: "unresolved" }],

  // ── month end / next month ───────────────────────────────────────────────
  ["month end", wholeDay("2026-10-31")],
  ["month-end", wholeDay("2026-10-31")],
  ["end of the month", wholeDay("2026-10-31")],
  ["end of month", wholeDay("2026-10-31")],
  ["mahine ke end", wholeDay("2026-10-31")],
  ["mahine ke aakhir", wholeDay("2026-10-31")],
  ["next month", wholeDay("2026-11-01")],
  ["agle mahine", wholeDay("2026-11-01")],

  // ── clock times, no day ──────────────────────────────────────────────────
  ["5 baje", exact(TODAY, 17 * 60)],
  ["5 bajay", exact(TODAY, 17 * 60)],
  ["paanch baje", exact(TODAY, 17 * 60)],
  ["at 5", exact(TODAY, 17 * 60)],
  ["at 5 o'clock", exact(TODAY, 17 * 60)],
  ["at 6", exact(TODAY, 18 * 60)],
  ["at 7", exact(TODAY, 19 * 60)],
  ["at 8", exact(TOMORROW, 8 * 60)],
  ["at 9", exact(TOMORROW, 9 * 60)],
  ["at 10", exact(TOMORROW, 10 * 60)],
  ["17:00", exact(TODAY, 17 * 60)],
  ["19:30", exact(TODAY, 19 * 60 + 30)],
  ["4:30", exact(TODAY, 16 * 60 + 30)],
  ["4:30 pm", exact(TODAY, 16 * 60 + 30)],
  ["4.30 pm", exact(TODAY, 16 * 60 + 30)],
  ["5 pm", exact(TODAY, 17 * 60)],
  ["5 p.m.", exact(TODAY, 17 * 60)],
  ["9 am", exact(TOMORROW, 9 * 60)],
  ["11 am", exact(TOMORROW, 11 * 60)],
  ["11:15 am", exact(TOMORROW, 11 * 60 + 15)],
  ["12 pm", exact(TODAY, 12 * 60)],
  ["noon", exact(TODAY, 12 * 60)],
  ["at noon", exact(TODAY, 12 * 60)],
  ["midday", exact(TODAY, 12 * 60)],
  ["saat baje", exact(TODAY, 19 * 60)],
  ["aath baje", exact(TOMORROW, 8 * 60)],
  ["das baje", exact(TOMORROW, 10 * 60)],
  ["gyarah baje", exact(TOMORROW, 11 * 60)],
  ["barah baje", exact(TODAY, 12 * 60)],
  ["3 baje", exact(TODAY, 15 * 60)],
  ["subah 10 baje", exact(TOMORROW, 10 * 60)],
  ["subah 8 baje", exact(TOMORROW, 8 * 60)],
  ["shaam 6 baje", exact(TODAY, 18 * 60)],
  ["shaam 7 baje", exact(TODAY, 19 * 60)],
  ["dopahar 1 baje", exact(TODAY, 13 * 60)],
  ["dopahar 3 baje", exact(TODAY, 15 * 60)],
  ["raat 8 baje", exact(TODAY, 20 * 60)],

  // ── dayparts, no day ─────────────────────────────────────────────────────
  ["shaam ko", window(TODAY, 16 * 60, 20 * 60)],
  ["sham ko", window(TODAY, 16 * 60, 20 * 60)],
  ["in the evening", window(TODAY, 16 * 60, 20 * 60)],
  ["evening", window(TODAY, 16 * 60, 20 * 60)],
  ["dopahar", window(TODAY, 12 * 60, 16 * 60)],
  ["in the afternoon", window(TODAY, 12 * 60, 16 * 60)],
  ["subah", window(TOMORROW, 9 * 60, 12 * 60)],
  ["morning", window(TOMORROW, 9 * 60, 12 * 60)],
  ["in the morning", window(TOMORROW, 9 * 60, 12 * 60)],
  ["raat ko", window(TODAY, 16 * 60, 20 * 60)],

  // ── "after N" ────────────────────────────────────────────────────────────
  ["after 5", window(TODAY, 17 * 60, DAY_END)],
  ["after 5 pm", window(TODAY, 17 * 60, DAY_END)],
  ["5 baje ke baad", window(TODAY, 17 * 60, DAY_END)],
  ["5 baje baad", window(TODAY, 17 * 60, DAY_END)],
  ["after 6", window(TODAY, 18 * 60, DAY_END)],
  ["6 baje ke baad", window(TODAY, 18 * 60, DAY_END)],
  ["after 7", window(TODAY, 19 * 60, DAY_END)],
  ["after lunch", window(TODAY, 13 * 60, 16 * 60)],
  ["lunch ke baad", window(TODAY, 13 * 60, 16 * 60)],
  ["khane ke baad", window(TODAY, 13 * 60, 16 * 60)],

  // ── "before N" ───────────────────────────────────────────────────────────
  ["before 6", window(TODAY, DAY_START, 18 * 60)],
  ["6 baje se pehle", window(TODAY, DAY_START, 18 * 60)],
  ["before 11 am", window(TOMORROW, DAY_START, 11 * 60)],

  // ── windows ──────────────────────────────────────────────────────────────
  ["between 2 and 4", window(TODAY, 14 * 60, 16 * 60)],
  ["between 2 and 4 pm", window(TODAY, 14 * 60, 16 * 60)],
  ["between 10 and 11 am", window(TOMORROW, 10 * 60, 11 * 60)],
  ["2 se 4 ke beech", window(TODAY, 14 * 60, 16 * 60)],
  ["2 se 4 beech", window(TODAY, 14 * 60, 16 * 60)],
  ["between 5 and 7", window(TODAY, 17 * 60, 19 * 60)],

  // ── durations from the call ──────────────────────────────────────────────
  ["in 30 minutes", exact(TODAY, 12 * 60 + 30)],
  ["in 15 mins", exact(TODAY, 12 * 60 + 15)],
  ["30 minute baad", exact(TODAY, 12 * 60 + 30)],
  ["in 2 hours", exact(TODAY, 14 * 60)],
  ["do ghante baad", exact(TODAY, 14 * 60)],
  ["ek ghanta baad", exact(TODAY, 13 * 60)],
  ["in an hour", { kind: "unresolved" }],
  ["half an hour", exact(TODAY, 12 * 60 + 30)],
  ["aadhe ghante baad", exact(TODAY, 12 * 60 + 30)],
  ["right now", exact(TODAY, 12 * 60 + 15)],
  ["abhi", exact(TODAY, 12 * 60 + 15)],
  ["turant", exact(TODAY, 12 * 60 + 15)],
  ["asap", exact(TODAY, 12 * 60 + 15)],
  ["thodi der mein", exact(TODAY, 12 * 60 + 15)],

  // ── combinations ─────────────────────────────────────────────────────────
  ["monday between 2 and 4", window("2026-10-12", 14 * 60, 16 * 60)],
  ["tomorrow between 10 and 11 am", window(TOMORROW, 10 * 60, 11 * 60)],
  ["next monday after 5", window("2026-10-12", 17 * 60, DAY_END)],
  ["the 15th between 2 and 4", window("2026-10-15", 14 * 60, 16 * 60)],
  ["15 october shaam 6 baje", exact("2026-10-15", 18 * 60)],
  ["agle somwar subah 10 baje", exact("2026-10-12", 10 * 60)],
  ["month end 4 baje", exact("2026-10-31", 16 * 60)],
  ["kal dopahar ke baad", window(TOMORROW, 12 * 60, 16 * 60), "future"],

  // ── mixed Hindi-English, as spoken ───────────────────────────────────────
  ["kal evening 6 baje", exact(TOMORROW, 18 * 60), "future"],
  ["tomorrow shaam ko", window(TOMORROW, 16 * 60, 20 * 60)],
  ["monday ko 11 baje", exact("2026-10-12", 11 * 60)],
  ["shaam me 5 baje call karna", exact(TODAY, 17 * 60)],
  ["aaj hi 6 baje", exact(TODAY, 18 * 60)],
  ["please call at 4 tomorrow", exact(TOMORROW, 16 * 60)],
  ["ring me after 6 today", window(TODAY, 18 * 60, DAY_END)],

  // ── nothing to read ──────────────────────────────────────────────────────
  ["", { kind: "unresolved" }],
  ["   ", { kind: "unresolved" }],
  ["later", { kind: "unresolved" }],
  ["baad mein", { kind: "unresolved" }],
  ["sometime", { kind: "unresolved" }],
  ["whenever you are free", { kind: "unresolved" }],
  ["kabhi bhi", { kind: "unresolved" }],
  ["soon", { kind: "unresolved" }],
  ["jaldi", { kind: "unresolved" }],
  ["after i talk to my husband", { kind: "unresolved" }],
  ["after diwali", { kind: "unresolved" }],
  ["next quarter", { kind: "unresolved" }],

  // ── the near-misses that must NOT become dates ───────────────────────────
  //
  // Every one of these is a real misparse that a looser rule produced.
  ["after 2 hours", exact(TODAY, 14 * 60)],
  ["after 3 hours", exact(TODAY, 15 * 60)],
  ["after 15 days", wholeDay("2026-10-24")],
  ["after 20 minutes", exact(TODAY, 12 * 60 + 20)],
  ["i am free at 5", exact(TODAY, 17 * 60)],
  ["i am busy tomorrow", wholeDay(TOMORROW)],
  ["we may call", { kind: "unresolved" }],
  ["afternoon", window(TODAY, 12 * 60, 16 * 60)],
];

describe("resolveTimePhrase - the phrase table", () => {
  // The count the spec asks for, asserted so it cannot quietly shrink.
  it("covers at least 200 phrases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(200);
  });

  for (const [phrase, expectation, tense] of CASES) {
    const label = tense ? `${phrase}  [tense: ${tense}]` : phrase;
    it(`reads ${JSON.stringify(label)}`, () => {
      const result = resolveTimePhrase(phrase, ctx({ tense: tense ?? null }));
      expect(describeResolution(result)).toEqual(expectation);
    });
  }
});

describe("the model never produces the timestamp (§20)", () => {
  it("returns `unresolved` rather than a guess for a phrase it cannot read", () => {
    for (const phrase of ["after diwali", "when my salary comes", "once i decide"]) {
      const result = resolveTimePhrase(phrase, ctx());
      expect(result.kind).toBe("unresolved");
      expect(isActionable(result)).toBe(false);
      expect(bestInstant(result)).toBeNull();
    }
  });

  it("returns BOTH readings for an ambiguous day, never one of them", () => {
    const result = resolveTimePhrase("kal 5 baje", ctx());
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.readings).toHaveLength(2);
    expect(result.reason).toMatch(/tomorrow and yesterday/);
    // An ambiguous reading is never actionable - §7.1: "ambiguous results
    // create a clarification task, never a guess."
    expect(isActionable(result)).toBe(false);
    expect(bestInstant(result)).toBeNull();
  });

  it("records which rules fired, so a bad read can be explained", () => {
    const result = resolveTimePhrase("kal shaam 5 baje call karna", ctx());
    expect(result.matched).toContain("kal");
    expect(result.matched).toContain("clock");
  });

  it("pins the resolver version, which travels on every decision", () => {
    expect(RESOLVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("the reference instant is the call's end, never `now`", () => {
  it("resolves `tomorrow` against the call, not against the worker's clock", () => {
    // A call that ended at 23:50 and is analysed at 00:05 the next day. The
    // customer's "tomorrow" is the 10th; the worker's would be the 11th.
    const lateCall = new Date("2026-10-09T18:20:00.000Z"); // 23:50 IST on the 9th
    const result = resolveTimePhrase("tomorrow at 11", {
      reference: lateCall,
      timeZone: ZONE,
    });
    expect(describeResolution(result)).toEqual(exact(TOMORROW, 11 * 60));
  });

  it("rolls a time that has already passed to the next day", () => {
    const morning = new Date("2026-10-09T03:30:00.000Z"); // 09:00 IST
    // At 09:00, "at 10" is still today.
    expect(
      describeResolution(resolveTimePhrase("at 10", { reference: morning, timeZone: ZONE })),
    ).toEqual(exact(TODAY, 10 * 60));
    // At noon it is not.
    expect(describeResolution(resolveTimePhrase("at 10", ctx()))).toEqual(
      exact(TOMORROW, 10 * 60),
    );
  });

  it("rolls a duration past midnight onto the next day", () => {
    const nearMidnight = new Date("2026-10-09T17:45:00.000Z"); // 23:15 IST
    const result = resolveTimePhrase("in 2 hours", {
      reference: nearMidnight,
      timeZone: ZONE,
    });
    expect(describeResolution(result)).toEqual(exact(TOMORROW, 1 * 60 + 15));
  });

  it("reads the same phrase differently in a different zone", () => {
    // 06:30 UTC is 12:00 in Kolkata and 07:30 in London, so "at 10" has
    // happened in one and has not in the other.
    expect(describeResolution(resolveTimePhrase("at 10", ctx()))).toEqual(
      exact(TOMORROW, 10 * 60),
    );
    const london = resolveTimePhrase("at 10", { reference: REFERENCE, timeZone: "Europe/London" });
    expect(london.kind).toBe("exact");
    if (london.kind !== "exact") throw new Error("unreachable");
    expect(instantToWallTime(london.at, "Europe/London")).toBe("2026-10-09T10:00");
  });
});

describe("the daypart table is configuration, not a switch (§7.1)", () => {
  it("honours an org that works later", () => {
    const lateDayparts = DEFAULT_DAYPARTS.map((part) =>
      part.key === "evening"
        ? { ...part, startMinute: 18 * 60, endMinute: 22 * 60 }
        : part,
    );
    const result = resolveTimePhrase("shaam ko", ctx({ dayparts: lateDayparts }));
    expect(describeResolution(result)).toEqual(window(TODAY, 18 * 60, 22 * 60));
  });

  it("lets the daypart decide the 12-hour reading", () => {
    // "10 baje" is 10:00 with "subah" and 22:00 with a late "shaam".
    const lateDayparts = DEFAULT_DAYPARTS.map((part) =>
      part.key === "evening" ? { ...part, startMinute: 18 * 60, endMinute: 23 * 60 } : part,
    );
    expect(describeResolution(resolveTimePhrase("subah 10 baje", ctx()))).toEqual(
      exact(TOMORROW, 10 * 60),
    );
    expect(
      describeResolution(resolveTimePhrase("shaam 10 baje", ctx({ dayparts: lateDayparts }))),
    ).toEqual(exact(TODAY, 22 * 60));
  });

  it('reads "after N" to the end of the configured working day', () => {
    const result = resolveTimePhrase("after 5", ctx({ dayEndMinute: 19 * 60 }));
    expect(describeResolution(result)).toEqual(window(TODAY, 17 * 60, 19 * 60));
  });

  it("skips holidays and non-working days when asked for the next working day", () => {
    const result = resolveTimePhrase("next working day", ctx({ holidays: ["2026-10-10"] }));
    // Saturday the 10th is a holiday and Sunday is not a working day.
    expect(describeResolution(result)).toEqual(wholeDay("2026-10-12"));
  });

  it("does not hang when an org has no working days at all", () => {
    const result = resolveTimePhrase("next working day", ctx({ workingWeekdays: [] }));
    expect(result.kind).toBe("window");
  });
});

describe("normalisePhrase", () => {
  it("collapses the romanisations of one word", () => {
    for (const spelling of ["sham", "shyam", "saam", "shaam"]) {
      expect(normalisePhrase(`${spelling} ko`)).toBe("shaam ko");
    }
    for (const spelling of ["subha", "sube", "savere"]) {
      expect(normalisePhrase(spelling)).toBe("subah");
    }
  });

  it("maps Devanagari numerals", () => {
    expect(normalisePhrase("५ baje")).toBe("5 baje");
    expect(normalisePhrase("१० baje")).toBe("10 baje");
  });

  it("strips Latin diacritics and punctuation but keeps the clock colon", () => {
    expect(normalisePhrase("at 4:30 p.m.!")).toBe("at 4:30 p.m.");
    expect(normalisePhrase("shaám")).toBe("shaam");
  });

  it("reads a Devanagari clock time end to end", () => {
    expect(describeResolution(resolveTimePhrase("कल ५ baje", ctx({ tense: "future" })))).toEqual(
      exact(TOMORROW, 17 * 60),
    );
  });
});

describe("bestInstant (§10A.1's due time)", () => {
  it("is the instant for an exact time", () => {
    const result = resolveTimePhrase("at 5", ctx());
    expect(bestInstant(result)?.toISOString()).toBe(new Date("2026-10-09T11:30:00.000Z").toISOString());
  });

  it("is the START of a window, not its midpoint", () => {
    // A customer who said "after 5" is available from 5. Ringing at 18:00
    // because that is the middle of 16:00-20:00 wastes two hours.
    const result = resolveTimePhrase("after 5", ctx());
    expect(wall(bestInstant(result)!.toISOString())).toBe(at(TODAY, 17 * 60));
  });

  it("is null for anything a person has to look at", () => {
    expect(bestInstant(resolveTimePhrase("kal", ctx()))).toBeNull();
    expect(bestInstant(resolveTimePhrase("sometime", ctx()))).toBeNull();
  });
});
