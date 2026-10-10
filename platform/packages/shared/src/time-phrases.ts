import { dayKeyIn, shiftDateKey, wallTimeToInstant, zonedParts } from "./time";

/**
 * TURNING "kal shaam 5 baje ke baad" INTO A TIMESTAMP, IN CODE
 * (Build docs/transcript-agent-build-plan §7.1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §1: "the model understands; code decides and acts." §20 states the
 * consequence as a definition of done: "date and time are resolved only by
 * deterministic code; the model never outputs final timestamps or amounts."
 *
 * That is not stylistic. A model asked for a timestamp has to do three things
 * at once - read the phrase, know what day it is, and do calendar arithmetic -
 * and it is reliably excellent at the first and unreliable at the other two.
 * The failure is also the worst possible shape: a confidently wrong ISO string.
 * "kal shaam 5 baje" resolved to the wrong DAY produces a booking a customer
 * was never offered and a telecaller who rings a day late, and nothing in the
 * output looks wrong. Whereas a phrase this file cannot read produces
 * `unresolved`, which becomes a clarification task - visible, cheap, correct.
 *
 * So the model returns the PHRASE (`when_text`, `by_text`) and this file turns
 * it into an instant, a window, or an honest refusal.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE FOUR OUTCOMES, AND WHY "AMBIGUOUS" IS ONE OF THEM
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   exact       one instant.  "kal 5 baje" -> tomorrow 17:00
 *   window      a span to propose slots inside. "shaam ko" -> 16:00-20:00
 *   ambiguous   more than one defensible reading. Never a guess.
 *   unresolved  nothing recognised.
 *
 * `ambiguous` exists because of one word. **"kal" means both yesterday and
 * tomorrow in Hindi**, and so does "parso" (day after / day before). Which one
 * is meant comes from the verb, and when the verb is absent - which it often is
 * in the fragment a model extracts - there is genuinely no answer. §7.1 is
 * explicit: "resolve using verb tense and context in the evidence, otherwise
 * mark ambiguous." An ambiguous result creates a clarification task and never
 * an action, so the cost of the honest answer is one question to a telecaller
 * and the cost of a guess is a 50 % chance of a callback scheduled into the
 * past.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE REFERENCE INSTANT IS ALWAYS A PARAMETER
 * ══════════════════════════════════════════════════════════════════════════
 *
 * No `new Date()` anywhere in this file. "Tomorrow" is relative to the END OF
 * THE CALL, not to whenever the worker happened to pick the job up - a call at
 * 23:50 whose transcript is analysed at 00:05 means a different "tomorrow" to
 * each of them, and the customer meant theirs. A resolver with a hidden clock
 * is also a resolver nobody can test at a day boundary.
 *
 * All arithmetic goes through `time.ts` (`zonedParts`, `wallTimeToInstant`,
 * `shiftDateKey`), which is DST-correct and already the authority for the
 * org's own clock (0132). This file never constructs a Date from parts itself.
 */

/** Bumped when a rule changes a resolution. Recorded on every decision (§9). */
export const RESOLVER_VERSION = "1.0.0";

// ── Configuration ───────────────────────────────────────────────────────────

export interface DaypartSpec {
  /** Stable key - what `callback_policy` stores and what tests assert on. */
  key: string;
  /** What the console calls it. */
  label: string;
  /** Minutes from local midnight. */
  startMinute: number;
  endMinute: number;
  /** Every word, in every supported language, that names this part of the day. */
  words: readonly string[];
}

/**
 * §18's defaults: morning 09-12, afternoon 12-16, evening 16-20.
 *
 * A TABLE and not a switch, because §7.1 requires it to be configurable per
 * org - a clinic's "evening" and a factory's are different hours and neither is
 * wrong. `daypart_config` overrides the minutes; the words stay here, because a
 * tenant renaming "shaam" is not a thing that happens and a tenant moving it an
 * hour later is.
 *
 * "raat" (night) is included with no daypart of its own: it maps to the END of
 * the evening window rather than to 22:00, because a callback at 22:00 is
 * outside every calling-hours policy this platform will accept and the
 * placement rules would move it anyway. Resolving it inside the window and
 * letting placement clamp it keeps one authority for "when may we ring".
 */
export const DEFAULT_DAYPARTS: readonly DaypartSpec[] = [
  {
    key: "morning",
    label: "Morning",
    startMinute: 9 * 60,
    endMinute: 12 * 60,
    words: ["morning", "subah", "subha", "sube", "savere", "saver"],
  },
  {
    key: "afternoon",
    label: "Afternoon",
    startMinute: 12 * 60,
    endMinute: 16 * 60,
    // "noon" and "midday" are deliberately NOT here: they name an INSTANT, and
    // a word that resolves to a four-hour window when the speaker said twelve
    // o'clock is a worse answer than no answer. They have their own rule below.
    words: ["afternoon", "dopahar", "dopeher", "dupahar", "lunch", "lunchtime"],
  },
  {
    key: "evening",
    label: "Evening",
    startMinute: 16 * 60,
    endMinute: 20 * 60,
    // No "am"/"pm" in any daypart's word list. They were here as a shortcut to
    // get "5 pm" right, and they made `daypartIn` match the English verb: "I am
    // free at 5" resolved to 05:00 because "am" was read as "morning". A
    // meridiem is only ever a meridiem when it sits next to a number, which is
    // what `meridiemIn` below requires.
    words: ["evening", "shaam", "sham", "shyam", "sandhya", "raat", "raat_ko", "night"],
  },
];

export interface ResolverContext {
  /** The call's END. See the header for why this and not "now". */
  reference: Date;
  /** The org's reporting timezone (0132). */
  timeZone: string;
  dayparts?: readonly DaypartSpec[];
  /**
   * The last minute of the working day. "after 5" means 17:00 until this.
   * Defaults to 21:00, matching §18's calling hours.
   */
  dayEndMinute?: number;
  /** The first minute of the working day, for "next working day" rules. */
  dayStartMinute?: number;
  /** ISO weekdays (1 = Monday) that are working days. Default Mon-Sat. */
  workingWeekdays?: readonly number[];
  /** `YYYY-MM-DD` dates nobody works. */
  holidays?: readonly string[];
  /**
   * What the UNDERSTANDING step read off the verb: was the speaker talking
   * about the past or the future? §7.1's tie-break for "kal".
   *
   * `null` is the honest default and it produces `ambiguous`, not a guess.
   */
  tense?: "past" | "future" | null;
}

interface Settled {
  dayparts: readonly DaypartSpec[];
  dayEndMinute: number;
  dayStartMinute: number;
  workingWeekdays: readonly number[];
  holidays: ReadonlySet<string>;
  tense: "past" | "future" | null;
  timeZone: string;
  reference: Date;
  today: string;
}

function settle(ctx: ResolverContext): Settled {
  return {
    dayparts: ctx.dayparts ?? DEFAULT_DAYPARTS,
    dayEndMinute: ctx.dayEndMinute ?? 21 * 60,
    dayStartMinute: ctx.dayStartMinute ?? 9 * 60,
    workingWeekdays: ctx.workingWeekdays ?? [1, 2, 3, 4, 5, 6],
    holidays: new Set(ctx.holidays ?? []),
    tense: ctx.tense ?? null,
    timeZone: ctx.timeZone,
    reference: ctx.reference,
    today: dayKeyIn(ctx.reference, ctx.timeZone) ?? "1970-01-01",
  };
}

// ── The result ──────────────────────────────────────────────────────────────

export interface ResolvedReading {
  dateKey: string;
  /** Minutes from local midnight. Null for a whole-day reading. */
  minuteOfDay: number | null;
  /** Both set for a window; equal to `minuteOfDay` for an exact time. */
  startMinute: number;
  endMinute: number;
  at: string;
  start: string;
  end: string;
}

export type TimeResolution =
  | ({
      kind: "exact";
      /** Which rules fired, for the audit trail and for debugging a bad read. */
      matched: readonly string[];
    } & ResolvedReading)
  | ({
      kind: "window";
      matched: readonly string[];
    } & ResolvedReading)
  | {
      kind: "ambiguous";
      /** Every defensible reading, in the order the rules produced them. */
      readings: readonly ResolvedReading[];
      reason: string;
      matched: readonly string[];
    }
  | {
      kind: "unresolved";
      reason: string;
      matched: readonly string[];
    };

/**
 * Is this a reading a planner may act on without asking anybody?
 *
 * ── A TYPE GUARD, NOT A BOOLEAN ────────────────────────────────────────────
 *
 * Declared as a predicate so a caller that has checked it can reach `.at`,
 * `.start` and `.end` without a cast. A plain `boolean` return reads the same
 * and forces every call site to assert the narrowing itself - and a cast is
 * exactly where an `ambiguous` resolution would get read as if it had a single
 * instant, which is the one thing §7.1 forbids.
 */
export function isActionable(
  resolution: TimeResolution,
): resolution is Extract<TimeResolution, { kind: "exact" | "window" }> {
  return resolution.kind === "exact" || resolution.kind === "window";
}

// ── Normalisation ───────────────────────────────────────────────────────────

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/**
 * One spelling per idea, before any rule runs.
 *
 * Romanised Hindi has no orthography - "shaam", "sham", "shyam" and "saam" are
 * the same word typed by four people, and an ASR engine picks whichever it
 * likes. Matching the variants in each rule's regex would mean every rule
 * carrying every spelling, so they are collapsed once, here, and the rules read
 * one form.
 *
 * Devanagari numerals are mapped because Sarvam returns them for Hindi audio.
 */
const SPELLING: ReadonlyArray<readonly [RegExp, string]> = [
  // ── Devanagari ────────────────────────────────────────────────────────────
  //
  // Sarvam returns Devanagari for Hindi audio, not romanisation, so a resolver
  // that only reads "kal" reads nothing at all for a Hindi-language workspace -
  // and reads it SILENTLY, falling through to a time-only resolution on the
  // wrong day. These are the relative days, the dayparts and the clock word;
  // everything else a phrase needs is already a numeral.
  //
  // No word boundaries: `\b` is defined on ASCII word characters, so `\bकल\b`
  // does not mean what it looks like it means. Devanagari is written without
  // internal spaces at these joins anyway, and the substitutions are
  // distinctive enough that a substring match is safe.
  [/आज/g, "aaj"],
  [/कल/g, "kal"],
  [/परसों|परसो/g, "parso"],
  [/सुबह/g, "subah"],
  [/दोपहर/g, "dopahar"],
  [/शाम/g, "shaam"],
  [/रात/g, "raat"],
  [/बजे/g, "baje"],
  [/बाद/g, "baad"],
  [/पहले/g, "pehle"],
  [/तारीख/g, "taarikh"],
  [/हफ्ते|हफ्ता/g, "hafte"],
  [/महीने|महीना/g, "mahine"],
  [/दिन/g, "din"],
  [/घंटे|घंटा/g, "ghante"],
  [/मिनट/g, "minute"],
  [/अभी/g, "abhi"],
  [/सोमवार/g, "somwar"],
  [/मंगलवार/g, "mangalwar"],
  [/बुधवार/g, "budhwar"],
  [/गुरुवार|बृहस्पतिवार/g, "guruwar"],
  [/शुक्रवार/g, "shukrawar"],
  [/शनिवार/g, "shanivar"],
  [/रविवार|इतवार/g, "ravivar"],
  [/करना|करो|कीजिए/g, "karna"],
  // ── romanised ─────────────────────────────────────────────────────────────
  [/\bkl\b/g, "kal"],
  [/\bparson\b/g, "parso"],
  [/\bparsoon\b/g, "parso"],
  [/\bsham\b/g, "shaam"],
  [/\bshyam\b/g, "shaam"],
  [/\bsaam\b/g, "shaam"],
  [/\bsubha\b/g, "subah"],
  [/\bsube\b/g, "subah"],
  [/\bsavere\b/g, "subah"],
  [/\bsaver\b/g, "subah"],
  [/\bdopeher\b/g, "dopahar"],
  [/\bdupahar\b/g, "dopahar"],
  [/\bbaadmein\b/g, "baad mein"],
  [/\bbd\b/g, "baad"],
  [/\bbajay\b/g, "baje"],
  [/\bbaj\b/g, "baje"],
  [/\bbjae\b/g, "baje"],
  [/\bbje\b/g, "baje"],
  [/\bhafta\b/g, "hafte"],
  [/\bhafté\b/g, "hafte"],
  [/\bsaptah\b/g, "hafte"],
  [/\btarikh\b/g, "taarikh"],
  [/\bmahina\b/g, "mahine"],
  [/\bmaheene\b/g, "mahine"],
  [/\bmahiney\b/g, "mahine"],
  [/\bo'?clock\b/g, "baje"],
  [/\bo clock\b/g, "baje"],
];

export function normalisePhrase(raw: string): string {
  let text = raw
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks so "shaám" matches "shaam". Devanagari is handled
    // by the digit map and the word table; this is for Latin diacritics only.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‐-―]/g, "-")
    // `\p{M}` is load-bearing and is the whole reason Devanagari works.
    // Vowel signs are MARKS, not letters: "शाम" is श + ा + म and the ा is
    // U+093E, category Mc. A class of `[^\p{L}\p{N}…]` strips it, leaving
    // "शम" - which matches nothing, on every Hindi phrase, silently.
    //
    // `/` is kept for "15/10". Stripping it turned a date into two numbers and
    // the phrase resolved to nothing at all.
    .replace(/[^\p{L}\p{M}\p{N}:.\-/\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  for (const [re, to] of SPELLING) text = text.replace(re, to);
  return text;
}

// ── Number words ────────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  one: 1, ek: 1,
  two: 2, do: 2,
  three: 3, teen: 3,
  four: 4, char: 4, chaar: 4,
  five: 5, paanch: 5, panch: 5,
  six: 6, chah: 6, cheh: 6, chhe: 6,
  seven: 7, saat: 7,
  eight: 8, aath: 8,
  nine: 9, nau: 9,
  ten: 10, das: 10, dus: 10,
  eleven: 11, gyarah: 11,
  twelve: 12, barah: 12,
  thirteen: 13, terah: 13,
  fourteen: 14, chaudah: 14,
  fifteen: 15, pandrah: 15,
  twenty: 20, bees: 20,
  thirty: 30, tees: 30,
};

function numberFrom(token: string | undefined): number | null {
  if (!token) return null;
  if (/^\d+$/.test(token)) return Number(token);
  const word = NUMBER_WORDS[token];
  return word ?? null;
}

const NUM = "(\\d{1,2}|" + Object.keys(NUMBER_WORDS).join("|") + ")";

// ── Weekdays ────────────────────────────────────────────────────────────────

/** ISO weekday (1 = Monday) for every name in every supported language. */
const WEEKDAY_WORDS: Record<string, number> = {
  monday: 1, mon: 1, somwar: 1, somvar: 1, peer: 1,
  tuesday: 2, tue: 2, tues: 2, mangalwar: 2, mangalvar: 2,
  wednesday: 3, wed: 3, budhwar: 3, budhvar: 3, buddhwar: 3,
  thursday: 4, thu: 4, thurs: 4, guruwar: 4, guruvar: 4, brihaspativar: 4,
  friday: 5, fri: 5, shukrawar: 5, shukravar: 5, jumma: 5,
  saturday: 6, sat: 6, shanivar: 6, shaniwar: 6,
  sunday: 7, sun: 7, ravivar: 7, raviwar: 7, itwar: 7, aitwar: 7,
};

const MONTH_WORDS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

// ── Day resolution ──────────────────────────────────────────────────────────

interface DayOutcome {
  /** One key, or two when the phrase is genuinely two-way ("kal"). */
  dateKeys: readonly string[];
  matched: string;
  ambiguousReason?: string;
}

function weekdayOf(dateKey: string): number {
  const parts = zonedParts(`${dateKey}T12:00:00Z`, "UTC");
  return parts?.weekday ?? 1;
}

function isWorkingDay(dateKey: string, s: Settled): boolean {
  if (s.holidays.has(dateKey)) return false;
  return s.workingWeekdays.includes(weekdayOf(dateKey));
}

/** The next working day strictly after `dateKey`. Bounded, so a misconfigured
 *  org with no working days at all cannot hang the worker. */
export function nextWorkingDay(dateKey: string, s: Settled | ResolverContext): string {
  const settled = "today" in s ? s : settle(s);
  let candidate = dateKey;
  for (let i = 0; i < 14; i += 1) {
    candidate = shiftDateKey(candidate, 1);
    if (isWorkingDay(candidate, settled)) return candidate;
  }
  return shiftDateKey(dateKey, 1);
}

/** The next occurrence of an ISO weekday, strictly after today unless `inclusive`. */
function nextWeekday(from: string, weekday: number, inclusive: boolean): string {
  const start = inclusive ? 0 : 1;
  for (let i = start; i <= 7 + start; i += 1) {
    const candidate = shiftDateKey(from, i);
    if (weekdayOf(candidate) === weekday) return candidate;
  }
  return from;
}

function lastDayOfMonth(dateKey: string): string {
  const [y, m] = dateKey.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(y!, m!, 0));
  return last.toISOString().slice(0, 10);
}

/**
 * Resolve the DAY the phrase names, or null when it names none.
 *
 * Order matters and is the opposite of obvious: the most specific patterns are
 * tried first, because "next monday" contains "monday" and "day after tomorrow"
 * contains "tomorrow". A rule list ordered by how easy the regex was to write
 * is a rule list that reads "next monday" as "monday".
 */
function resolveDay(text: string, s: Settled): DayOutcome | null {
  const today = s.today;

  // ── explicit calendar dates ───────────────────────────────────────────────
  // "on 15th", "15 October", "October 15", "15/10", "2026-10-15".
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return { dateKeys: [`${iso[1]}-${iso[2]}-${iso[3]}`], matched: "iso-date" };

  const dayMonth = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${Object.keys(MONTH_WORDS).join("|")})\\b`,
  ).exec(text);
  if (dayMonth) {
    const key = monthDayKey(today, MONTH_WORDS[dayMonth[2]!]!, Number(dayMonth[1]));
    if (key) return { dateKeys: [key], matched: "day-month" };
  }

  const monthDay = new RegExp(
    `\\b(${Object.keys(MONTH_WORDS).join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
  ).exec(text);
  if (monthDay) {
    const key = monthDayKey(today, MONTH_WORDS[monthDay[1]!]!, Number(monthDay[2]));
    if (key) return { dateKeys: [key], matched: "month-day" };
  }

  const slash = /\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/.exec(text);
  if (slash) {
    // Day-first. India writes 15/10 and never 10/15, and guessing per value
    // ("if the first is > 12 it must be the day") silently flips on the 5th of
    // May. One convention, stated.
    const year = slash[3] ? normaliseYear(slash[3]) : Number(today.slice(0, 4));
    const key = ymdKey(year, Number(slash[2]), Number(slash[1]));
    if (key) return { dateKeys: [key], matched: "numeric-date" };
  }

  // ── "after the 15th" / "15 taarikh ke baad" ──────────────────────────────
  //
  // A date floor, not a date. §10A.1 classifies it `far_future` and parks it
  // until the day arrives, so the resolution is "that day" and the planner
  // reads the `after` flag off the TIME half.
  //
  // EVERY BRANCH DEMANDS AN ORDINAL, "the", OR "taarikh". A bare
  // `after\s+(\d+)` read "after 2 hours" as the 2nd of next month - a phrase
  // meaning two hours from now became a callback five weeks away, and nothing
  // about the stored timestamp looked wrong. The marker is what distinguishes a
  // DATE from a DURATION, and there is no safe default when it is absent.
  const afterDate =
    /\bafter\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text) ??
    /\bafter\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(text) ??
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+taarikh\s+(?:ke\s+)?baad\b/.exec(text);
  if (afterDate) {
    const key = dayOfMonthKey(today, Number(afterDate[1]), s);
    if (key) return { dateKeys: [key], matched: "after-day-of-month" };
  }

  // ── month end ────────────────────────────────────────────────────────────
  // `month[\s-]*end` and not `month\s*end`: "month-end" is how people write
  // it, the hyphen survives normalisation, and `\s*` does not match one.
  if (/\b(?:month[\s-]*end|end\s+of\s+(?:the\s+)?month|mahine\s+ke\s+(?:end|aakhir|ant))\b/.test(text)) {
    return { dateKeys: [lastDayOfMonth(today)], matched: "month-end" };
  }
  if (/\b(?:next\s+month|agle\s+mahine|agle\s+month)\b/.test(text)) {
    // The 1st of next month, which is the earliest thing "next month" can mean.
    // A customer who said it meant "not now"; the day-before heads-up in
    // §10A.1 is what makes the imprecision survivable.
    const first = `${lastDayOfMonth(today).slice(0, 7)}-01`;
    return { dateKeys: [shiftDateKey(lastDayOfMonth(first), 1)], matched: "next-month" };
  }

  // ── "the 15th", "15 taarikh ko" ──────────────────────────────────────────
  //
  // Two forms, and the second is the common one on an Indian floor: "das
  // taarikh ko", "10 taarikh ko aana". It is accepted WITHOUT an ordinal
  // suffix because `taarikh` itself is the marker - the word means "date", so
  // "10 taarikh" cannot be a duration the way a bare "after 10" can. That is
  // the same test the `after` branch above applies, satisfied by a different
  // token.
  const dayOfMonth =
    /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)\b/.exec(text) ??
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+taarikh\b/.exec(text);
  if (dayOfMonth) {
    const key = dayOfMonthKey(today, Number(dayOfMonth[1]), s);
    if (key) return { dateKeys: [key], matched: "day-of-month" };
  }

  // ── weekdays, most specific first ────────────────────────────────────────
  const weekdayNames = Object.keys(WEEKDAY_WORDS).join("|");

  const nextNamed = new RegExp(`\\b(?:next|agle|aane\\s+wale)\\s+(${weekdayNames})\\b`).exec(text);
  if (nextNamed) {
    return {
      dateKeys: [nextWeekday(today, WEEKDAY_WORDS[nextNamed[1]!]!, false)],
      matched: "next-weekday",
    };
  }

  const thisNamed = new RegExp(`\\b(?:this|is|iss)\\s+(${weekdayNames})\\b`).exec(text);
  if (thisNamed) {
    return {
      dateKeys: [nextWeekday(today, WEEKDAY_WORDS[thisNamed[1]!]!, true)],
      matched: "this-weekday",
    };
  }

  const bareNamed = new RegExp(`\\b(${weekdayNames})\\b`).exec(text);
  if (bareNamed) {
    // A bare weekday is the NEXT one, including today. "Friday ko aadha de
    // dunga" said on a Friday morning means today.
    return {
      dateKeys: [nextWeekday(today, WEEKDAY_WORDS[bareNamed[1]!]!, true)],
      matched: "weekday",
    };
  }

  // ── weekend / week ───────────────────────────────────────────────────────
  if (/\b(?:this\s+weekend|weekend|is\s+weekend)\b/.test(text)) {
    return { dateKeys: [nextWeekday(today, 6, true)], matched: "weekend" };
  }
  if (/\b(?:next\s+week|agle\s+hafte|agle\s+week)\b/.test(text)) {
    // §18: "next week" = Monday 10:00. The day half here, the time half below.
    return { dateKeys: [nextWeekday(today, 1, false)], matched: "next-week" };
  }

  // ── "in N days" / "N din baad" ───────────────────────────────────────────
  const inDays =
    new RegExp(`\\b(?:in|after)\\s+${NUM}\\s+(?:days?|din)\\b`).exec(text) ??
    new RegExp(`\\b${NUM}\\s+din\\s+(?:baad|ke\\s+baad)\\b`).exec(text);
  if (inDays) {
    const n = numberFrom(inDays[1]);
    if (n !== null) return { dateKeys: [shiftDateKey(today, n)], matched: "in-n-days" };
  }

  const inWeeks =
    new RegExp(`\\b(?:in|after)\\s+${NUM}\\s+(?:weeks?|hafte)\\b`).exec(text) ??
    new RegExp(`\\b${NUM}\\s+hafte\\s+(?:baad|ke\\s+baad)\\b`).exec(text);
  if (inWeeks) {
    const n = numberFrom(inWeeks[1]);
    if (n !== null) return { dateKeys: [shiftDateKey(today, n * 7)], matched: "in-n-weeks" };
  }

  // ── day after / day before, which is two-way in Hindi ────────────────────
  if (/\bday\s+after\s+tomorrow\b/.test(text)) {
    return { dateKeys: [shiftDateKey(today, 2)], matched: "day-after-tomorrow" };
  }
  if (/\bday\s+before\s+yesterday\b/.test(text)) {
    return { dateKeys: [shiftDateKey(today, -2)], matched: "day-before-yesterday" };
  }
  if (/\bparso\b/.test(text)) {
    return twoWay(today, 2, s, "parso", '"parso" is both the day after tomorrow and the day before yesterday');
  }

  // ── tomorrow / yesterday / today ─────────────────────────────────────────
  if (/\b(?:tomorrow|tomorow|tmrw)\b/.test(text)) {
    return { dateKeys: [shiftDateKey(today, 1)], matched: "tomorrow" };
  }
  if (/\byesterday\b/.test(text)) {
    return { dateKeys: [shiftDateKey(today, -1)], matched: "yesterday" };
  }
  if (/\bkal\b/.test(text)) {
    return twoWay(today, 1, s, "kal", '"kal" is both tomorrow and yesterday');
  }
  if (/\b(?:today|aaj|aj)\b/.test(text)) {
    return { dateKeys: [today], matched: "today" };
  }

  // ── "next working day" ───────────────────────────────────────────────────
  if (/\b(?:next\s+(?:working|business)\s+day|agle\s+kaam\s+ke\s+din)\b/.test(text)) {
    return { dateKeys: [nextWorkingDay(today, s)], matched: "next-working-day" };
  }

  return null;
}

/**
 * The two-way Hindi relative days.
 *
 * `tense` from the understanding step decides; an IMPERATIVE in the phrase
 * itself decides too, and that is the common case for a callback - "kal call
 * karna" is unambiguously a request however absent the verb tense was. With
 * neither, both readings come back and the planner raises a clarification.
 */
function twoWay(
  today: string,
  offset: number,
  s: Settled,
  matched: string,
  reason: string,
): DayOutcome {
  if (s.tense === "future") return { dateKeys: [shiftDateKey(today, offset)], matched };
  if (s.tense === "past") return { dateKeys: [shiftDateKey(today, -offset)], matched };
  return {
    dateKeys: [shiftDateKey(today, offset), shiftDateKey(today, -offset)],
    matched,
    ambiguousReason: reason,
  };
}

/**
 * Markers that settle the tense from the phrase alone.
 *
 * All of them are requests ("ring me", "call karna", "de dunga"), so they mean
 * FUTURE. There is no past-marker list, deliberately: a phrase a model
 * extracted as `when_text` for a callback is a request by construction, and a
 * list of past markers would only ever fire on a misextraction - where
 * `ambiguous` is the answer anyway.
 */
const FUTURE_MARKERS =
  /\b(?:karna|karo|kijiye|kijiyega|karenge|karoge|call\s+me|ring\s+me|phone\s+me|call\s+back|callback|dunga|dungi|denge|doonga|milunga|aaunga|aaungi|rahunga|rahungi|will|shall|later|baad\s+mein)\b/;

function monthDayKey(today: string, month: number, day: number): string | null {
  const year = Number(today.slice(0, 4));
  const thisYear = ymdKey(year, month, day);
  if (!thisYear) return null;
  // A month that has already passed means next year. "Call me in January"
  // said in December is not a request for eleven months ago.
  return thisYear >= today ? thisYear : ymdKey(year + 1, month, day);
}

function dayOfMonthKey(today: string, day: number, s: Settled): string | null {
  void s;
  const [y, m] = today.split("-").map(Number);
  const thisMonth = ymdKey(y!, m!, day);
  if (thisMonth && thisMonth >= today) return thisMonth;
  const next = shiftDateKey(lastDayOfMonth(today), 1);
  const [ny, nm] = next.split("-").map(Number);
  return ymdKey(ny!, nm!, day);
}

function ymdKey(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject 31 February rather than letting it roll into March: a date nobody
  // said is worse than no date.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function normaliseYear(raw: string): number {
  const n = Number(raw);
  if (raw.length === 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

// ── Time resolution ─────────────────────────────────────────────────────────

interface TimeOutcome {
  startMinute: number;
  endMinute: number;
  /** True when the phrase named one instant rather than a span. */
  exact: boolean;
  matched: string;
  /** "after 5" - the span runs to the end of the working day. */
  openEnded?: boolean;
}

/**
 * The 12-hour problem: "5 baje" is 17:00 on a telecalling floor and 05:00
 * never.
 *
 * Bare hours 1-7 are read as PM, 8-11 as AM, 12 as noon. That is not a guess
 * about English, it is a fact about when a business rings a customer: nobody
 * asks to be called at five in the morning, and "call me at 9" means the
 * morning. An explicit daypart word always wins over this, and so does an
 * explicit am/pm.
 */
function disambiguateHour(hour: number, daypartKey: string | null, explicit: "am" | "pm" | null): number {
  if (hour === 0) return 0;
  if (explicit === "am") return hour === 12 ? 0 : hour;
  if (explicit === "pm") return hour === 12 ? 12 : hour + 12;
  if (daypartKey === "morning") return hour === 12 ? 0 : hour;
  if (daypartKey === "afternoon") return hour >= 1 && hour <= 6 ? hour + 12 : hour;
  if (daypartKey === "evening") return hour >= 1 && hour <= 11 ? hour + 12 : hour;
  if (hour >= 1 && hour <= 7) return hour + 12;
  if (hour === 12) return 12;
  return hour;
}

function daypartIn(text: string, s: Settled): DaypartSpec | null {
  // Longest word first, so "lunchtime" is not matched as "lunch" inside a
  // different daypart, and "afternoon" is not matched by "noon".
  const entries = s.dayparts
    .flatMap((part) => part.words.map((word) => ({ part, word })))
    .sort((a, b) => b.word.length - a.word.length);
  for (const { part, word } of entries) {
    if (new RegExp(`\\b${word.replace(/_/g, "\\s+")}\\b`).test(text)) return part;
  }
  return null;
}

/**
 * A meridiem is only a meridiem when it sits next to a number.
 *
 * `/\bam\b/` over free text matches the English verb, and "I am free at 5"
 * then resolves to 05:00 - a callback eleven hours before the one the customer
 * asked for, stored as a perfectly ordinary timestamp. Requiring the adjacent
 * number is the whole fix, and it costs nothing: nobody writes a meridiem
 * without one.
 */
function meridiemIn(text: string): "am" | "pm" | null {
  const m = /\b\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/.exec(text);
  if (!m) return null;
  return m[1]!.startsWith("a") ? "am" : "pm";
}

function resolveTime(text: string, s: Settled): TimeOutcome | null {
  const part = daypartIn(text, s);
  const daypartKey = part?.key ?? null;
  const explicitMeridiem = meridiemIn(text);

  // ── noon and midnight name an instant, not a part of the day ─────────────
  if (/\bmidnight\b/.test(text)) {
    return { startMinute: 0, endMinute: 0, exact: true, matched: "midnight" };
  }
  if (/(?:^|[^a-z])(?:noon|midday)\b/.test(text)) {
    return { startMinute: 12 * 60, endMinute: 12 * 60, exact: true, matched: "noon" };
  }

  // ── "between 2 and 4" / "2 se 4 ke beech" ────────────────────────────────
  const between =
    new RegExp(`\\bbetween\\s+${NUM}(?::(\\d{2}))?\\s*(?:and|to|-)\\s*${NUM}(?::(\\d{2}))?`).exec(
      text,
    ) ??
    new RegExp(`\\b${NUM}(?::(\\d{2}))?\\s+se\\s+${NUM}(?::(\\d{2}))?\\s+(?:ke\\s+)?beech`).exec(
      text,
    );
  if (between) {
    const a = numberFrom(between[1]);
    const b = numberFrom(between[3]);
    if (a !== null && b !== null) {
      const start = disambiguateHour(a, daypartKey, explicitMeridiem) * 60 + Number(between[2] ?? 0);
      let end = disambiguateHour(b, daypartKey, explicitMeridiem) * 60 + Number(between[4] ?? 0);
      // "between 11 and 1" - the second hour is after the first, so it rolled.
      if (end <= start) end += 12 * 60;
      return { startMinute: start, endMinute: Math.min(end, 24 * 60), exact: false, matched: "between" };
    }
  }

  // ── "after 5" / "5 baje ke baad" / "after lunch" ─────────────────────────
  //
  // The lookahead is the fix for "after 3 days", which this rule read as
  // 15:00 on the day the DAY rule had already resolved - producing a window on
  // the right day at an hour nobody mentioned. "after N <unit>" is a duration
  // and belongs to the rules below; only a bare "after N" is a clock.
  const afterClock =
    new RegExp(
      `\\bafter\\s+${NUM}(?::(\\d{2}))?\\s*(?:baje)?\\b(?!\\s*(?:days?|din|weeks?|hafte|months?|mahine|minutes?|mins?|minute|hours?|hrs?|ghante|ghanta|st|nd|rd|th))`,
    ).exec(text) ??
    new RegExp(`\\b${NUM}(?::(\\d{2}))?\\s*baje\\s+(?:ke\\s+)?baad\\b`).exec(text);
  if (afterClock) {
    const n = numberFrom(afterClock[1]);
    // "after 15 days" already consumed the day half; a bare "after 15" is not
    // an hour. Guard it here so "after the 15th" cannot become 15:00.
    if (n !== null && n <= 12) {
      const start = disambiguateHour(n, daypartKey, explicitMeridiem) * 60 + Number(afterClock[2] ?? 0);
      return {
        startMinute: start,
        endMinute: Math.max(start + 60, s.dayEndMinute),
        exact: false,
        matched: "after-clock",
        openEnded: true,
      };
    }
  }

  if (/\b(?:after\s+lunch|lunch\s+ke\s+baad|khane\s+ke\s+baad)\b/.test(text)) {
    const afternoon = s.dayparts.find((p) => p.key === "afternoon");
    const start = (afternoon?.startMinute ?? 12 * 60) + 60;
    return {
      startMinute: start,
      endMinute: afternoon?.endMinute ?? 16 * 60,
      exact: false,
      matched: "after-lunch",
    };
  }

  // ── "before 5" / "5 baje se pehle" ───────────────────────────────────────
  const beforeClock =
    new RegExp(`\\bbefore\\s+${NUM}(?::(\\d{2}))?\\s*(?:baje)?\\b`).exec(text) ??
    new RegExp(`\\b${NUM}(?::(\\d{2}))?\\s*baje\\s+se\\s+pehle\\b`).exec(text);
  if (beforeClock) {
    const n = numberFrom(beforeClock[1]);
    if (n !== null && n <= 12) {
      const end = disambiguateHour(n, daypartKey, explicitMeridiem) * 60 + Number(beforeClock[2] ?? 0);
      return {
        startMinute: Math.min(s.dayStartMinute, Math.max(0, end - 60)),
        endMinute: end,
        exact: false,
        matched: "before-clock",
      };
    }
  }

  // ── a clock time: "5 baje", "at 4:30", "17:00", "5 o'clock", "4.30 pm" ───
  //
  // The dot-separated form is tried FIRST and only when a meridiem is present.
  // "4.30" on its own is as likely to be a quantity or a sloppy date, but
  // "4.30 pm" is unmistakable - and without this branch the generic
  // number-plus-meridiem rule below matched the MINUTES ("30 pm"), found 30 out
  // of hour range, and resolved the whole phrase to nothing.
  const clock =
    (explicitMeridiem ? /\b(\d{1,2})[.](\d{2})\s*[ap]\.?m\.?/.exec(text) : null) ??
    /\b(\d{1,2}):(\d{2})\b/.exec(text) ??
    new RegExp(`\\b(?:at|ko|around|approx|about|takreeban|lagbhag)?\\s*${NUM}(?::(\\d{2}))?\\s*baje\\b`).exec(
      text,
    ) ??
    new RegExp(`\\bat\\s+${NUM}(?::(\\d{2}))?\\b`).exec(text) ??
    (explicitMeridiem ? new RegExp(`\\b${NUM}(?::(\\d{2}))?\\s*[ap]\\.?m\\.?\\b`).exec(text) : null);
  if (clock) {
    const n = numberFrom(clock[1]);
    const minute = Number(clock[2] ?? 0);
    if (n !== null && n <= 23 && minute < 60) {
      // A 24-hour reading ("17:00", "19:30") is already unambiguous.
      const hour = n > 12 ? n : disambiguateHour(n, daypartKey, explicitMeridiem);
      const at = hour * 60 + minute;
      return { startMinute: at, endMinute: at, exact: true, matched: "clock" };
    }
  }

  // ── "in N minutes / hours" ───────────────────────────────────────────────
  const inMinutes =
    new RegExp(`\\b(?:in|after)\\s+${NUM}\\s*(?:minutes?|mins?|minute|minut)\\b`).exec(text) ??
    new RegExp(`\\b${NUM}\\s*(?:minute|min)\\s+(?:baad|mein|me)\\b`).exec(text);
  if (inMinutes) {
    const n = numberFrom(inMinutes[1]);
    if (n !== null) {
      const at = referenceMinute(s) + n;
      return { startMinute: at, endMinute: at, exact: true, matched: "in-n-minutes" };
    }
  }

  const inHours =
    new RegExp(`\\b(?:in|after)\\s+${NUM}\\s*(?:hours?|hrs?|ghante|ghanta)\\b`).exec(text) ??
    new RegExp(`\\b${NUM}\\s*(?:ghante|ghanta|hour)\\s+(?:baad|mein|me)\\b`).exec(text);
  if (inHours) {
    const n = numberFrom(inHours[1]);
    if (n !== null) {
      const at = referenceMinute(s) + n * 60;
      return { startMinute: at, endMinute: at, exact: true, matched: "in-n-hours" };
    }
  }

  if (/\b(?:half\s+an\s+hour|aadhe\s+ghante|adhe\s+ghante)\b/.test(text)) {
    const at = referenceMinute(s) + 30;
    return { startMinute: at, endMinute: at, exact: true, matched: "half-hour" };
  }

  // ── a bare daypart: "shaam ko", "in the evening" ─────────────────────────
  if (part) {
    return {
      startMinute: part.startMinute,
      endMinute: part.endMinute,
      exact: false,
      matched: `daypart:${part.key}`,
    };
  }

  // ── "right now" / "abhi" ─────────────────────────────────────────────────
  if (/\b(?:right\s+now|abhi|turant|immediately|asap|thodi\s+der\s+mein)\b/.test(text)) {
    const at = referenceMinute(s) + 15;
    return { startMinute: at, endMinute: at, exact: true, matched: "now" };
  }

  return null;
}

function referenceMinute(s: Settled): number {
  const parts = zonedParts(s.reference, s.timeZone);
  return parts ? parts.hour * 60 + parts.minute : s.dayStartMinute;
}

// ── Assembly ────────────────────────────────────────────────────────────────

function reading(dateKey: string, startMinute: number, endMinute: number, s: Settled): ResolvedReading {
  // Minutes beyond midnight roll the day forward. "in 3 hours" at 23:00 is
  // 02:00 tomorrow, and a reading of 26:00 on today's date is not a timestamp.
  const dayShift = Math.floor(startMinute / (24 * 60));
  const day = dayShift === 0 ? dateKey : shiftDateKey(dateKey, dayShift);
  const start = startMinute - dayShift * 24 * 60;
  const endShift = Math.floor(endMinute / (24 * 60));
  const endDay = endShift === 0 ? dateKey : shiftDateKey(dateKey, endShift);
  const end = endMinute - endShift * 24 * 60;

  const startIso = instantAt(day, start, s);
  const endIso = instantAt(endDay, end, s);
  return {
    dateKey: day,
    minuteOfDay: start === end ? start : null,
    startMinute: start,
    endMinute: end,
    at: startIso,
    start: startIso,
    end: endIso,
  };
}

function instantAt(dateKey: string, minuteOfDay: number, s: Settled): string {
  const hour = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;
  const wall = `${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return wallTimeToInstant(wall, s.timeZone) ?? new Date(`${wall}:00Z`).toISOString();
}

/**
 * THE ENTRY POINT. A phrase in, one of four outcomes out.
 *
 * ── THE DAY DEFAULT, AND WHY IT ROLLS FORWARD ───────────────────────────────
 *
 * A phrase with a time and no day ("at 5", "shaam ko") means TODAY if that is
 * still ahead of the call, and tomorrow if it is not. A customer who says "call
 * me at 5" at 18:00 means tomorrow, and resolving it to 17:00 today produces a
 * callback that is overdue the moment it is created - which then escalates to a
 * manager for a commitment nobody missed.
 *
 * A phrase with a day and no time gets no time at all: `minuteOfDay` is null
 * and the span is the whole working day. Inventing an hour is the one thing
 * §7.1 forbids - the caller (§10A.6's vague-request rules) owns that default,
 * because it is a business policy and not a reading of the words.
 */
export function resolveTimePhrase(raw: string, ctx: ResolverContext): TimeResolution {
  const s = settle(ctx);
  const text = normalisePhrase(raw);
  if (!text) return { kind: "unresolved", reason: "empty phrase", matched: [] };

  // The imperative settles "kal" without the understanding step having to.
  const withTense: Settled =
    s.tense === null && FUTURE_MARKERS.test(text) ? { ...s, tense: "future" } : s;

  const day = resolveDay(text, withTense);
  const time = resolveTime(text, withTense);
  const matched = [day?.matched, time?.matched].filter((m): m is string => Boolean(m));

  if (!day && !time) {
    return { kind: "unresolved", reason: "no date or time recognised", matched };
  }

  // ── an ambiguous DAY poisons the whole reading ───────────────────────────
  if (day && day.dateKeys.length > 1) {
    const readings = day.dateKeys.map((key) =>
      time
        ? reading(key, time.startMinute, time.endMinute, withTense)
        : reading(key, withTense.dayStartMinute, withTense.dayEndMinute, withTense),
    );
    return {
      kind: "ambiguous",
      readings,
      reason: day.ambiguousReason ?? "more than one reading",
      matched,
    };
  }

  const refMinute = referenceMinute(withTense);

  if (!day && time) {
    // Time only: today, unless it has already passed - and "passed" is a
    // DIFFERENT question for an instant and for a window.
    //
    //   exact:  rolled only when the moment is strictly behind us. A call
    //           ending at 12:00 where the customer said "12 pm" means the
    //           minute they are on the edge of; `<=` would make "call me at
    //           noon" unreachable for anybody who says it at noon.
    //   window: rolled when the window has CLOSED, boundary included. At
    //           12:00 "call me in the morning" is tomorrow's morning - a
    //           09:00-12:00 slot with nothing left in it is not a slot.
    const passed = time.exact ? time.startMinute < refMinute : time.endMinute <= refMinute;
    const rolled = passed ? shiftDateKey(withTense.today, 1) : withTense.today;
    const r = reading(rolled, time.startMinute, time.endMinute, withTense);
    return time.exact
      ? { kind: "exact", matched, ...r }
      : { kind: "window", matched, ...r };
  }

  const dateKey = day!.dateKeys[0]!;

  if (!time) {
    // Day only. No hour is invented - see the header.
    const r = reading(dateKey, withTense.dayStartMinute, withTense.dayEndMinute, withTense);
    return { kind: "window", matched, ...r, minuteOfDay: null };
  }

  const r = reading(dateKey, time.startMinute, time.endMinute, withTense);
  return time.exact ? { kind: "exact", matched, ...r } : { kind: "window", matched, ...r };
}

/**
 * The single best instant inside a resolution - what a callback's `due_at`
 * becomes (§10A.1's "a window with a due time at the best point inside it").
 *
 * For an exact time that is the time. For a window it is the START, not the
 * middle: a customer who said "after 5" is available from 5, and ringing at
 * 18:00 because that was the midpoint of 16:00-20:00 wastes two hours of a hot
 * lead's patience. For an open-ended window ("after 5") the start is the only
 * thing the customer actually told us.
 */
export function bestInstant(resolution: TimeResolution): Date | null {
  if (resolution.kind === "exact") return new Date(resolution.at);
  if (resolution.kind === "window") return new Date(resolution.start);
  return null;
}
