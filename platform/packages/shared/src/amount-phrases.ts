import { DEFAULT_CURRENCY, MAX_MINOR, currencyExponent } from "./money";

/**
 * "aadha", "pachaas hazaar", "15k" -> an amount, IN CODE
 * (Build docs/transcript-agent-build-plan §7.2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE SAME RULE AS THE DATE RESOLVER, FOR THE SAME REASON
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §20: "the model never outputs final timestamps **or amounts**." A model
 * asked for a number from "aadha de dunga" will produce one, and it will be
 * confident, and it will be arithmetic performed on a figure it may have read
 * from the wrong place in the transcript. That number then becomes a
 * `payment_promise` the Finance Advisor chases and a `slipped_promise` alert
 * about a figure nobody agreed to.
 *
 * So the model returns `amount_text` and this file resolves it, against totals
 * the CONTEXT supplied - the deal value, the invoice balance, the quotation
 * total - never against a figure the model recalled.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  "AADHA" IS NOT A NUMBER AND MUST NOT RESOLVE TO ONE WITHOUT A TOTAL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §7.2: "if a total is unknown, mark `needs_human` or ask for clarification."
 * The outcome `needs_total` exists so that is a structural answer rather than a
 * convention somebody remembers: a fraction with no base comes back as a
 * fraction, with the fraction stated, and the caller cannot read an amount off
 * it because there is not one on the object.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  MINOR UNITS, AND WHY THAT IS NOT A CONTRADICTION
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `TRANSCRIPT_AGENT_DECISIONS.md` §4.1 records that money COLUMNS here are
 * `numeric`, against §2's "integer minor units". Both are true: the columns are
 * numeric and `money.ts` owns the integer arithmetic in JavaScript, so this
 * returns `amountMinor` and the writer converts with `toNumericString`. Doing
 * the arithmetic in paise is what keeps "half of 2,499.99" from being
 * 1249.9949999999999.
 */

/** Bumped when a rule changes a resolution. Recorded on every decision. */
export const AMOUNT_RESOLVER_VERSION = "1.0.0";

export interface AmountContext {
  /**
   * Totals the fraction words may refer to, most specific first. The caller
   * supplies whatever the lead actually has - an outstanding balance, a deal
   * value, a quotation total - and the FIRST one is used.
   *
   * Ordering is the caller's decision and it matters: "aadha" said on a call
   * about an overdue invoice means half the balance, not half the deal.
   */
  totalsMinor: readonly number[];
  currency?: string;
}

export type AmountResolution =
  | {
      kind: "exact";
      amountMinor: number;
      currency: string;
      matched: string;
    }
  | {
      kind: "fraction";
      /** 0.5 for "aadha". The amount, once a total is known. */
      fraction: number;
      amountMinor: number;
      currency: string;
      matched: string;
    }
  | {
      kind: "needs_total";
      fraction: number;
      reason: string;
      matched: string;
    }
  | {
      kind: "unresolved";
      reason: string;
      matched: string;
    };

/**
 * A TYPE GUARD, for the reason `isActionable` in `time-phrases.ts` gives: a
 * caller that has checked it must be able to reach `amountMinor` without a
 * cast, because a cast is where a `needs_total` resolution would get read as
 * if it carried an amount - and the whole point of that outcome is that it
 * does not.
 */
export function isAmountActionable(
  r: AmountResolution,
): r is Extract<AmountResolution, { kind: "exact" | "fraction" }> {
  return r.kind === "exact" || r.kind === "fraction";
}

export function amountMinorOf(r: AmountResolution): number | null {
  return r.kind === "exact" || r.kind === "fraction" ? r.amountMinor : null;
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The Indian numbering scale words, and the two English ones people also use.
 *
 * `hazaar` and `thousand` both appear because a Bangalore sales floor says both
 * in the same sentence. `k` is here as a multiplier rather than as a suffix
 * rule, so "15k" and "15 k" are the same phrase.
 */
const SCALES: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bcrores?\b|\bkaror\b|\bkarod\b|\bcr\b/, 10_000_000],
  [/\blakhs?\b|\blacs?\b|\blakhon\b|\bl\b/, 100_000],
  [/\bhazaa?r\b|\bhazzar\b|\bthousands?\b|\bk\b/, 1_000],
  [/\bhundreds?\b|\bsau\b/, 100],
];

/**
 * Hindi and English number words up to 99, plus the ones that turn up in
 * amounts specifically ("sava", "dedh", "dhai").
 *
 * Not a general number parser: an amount phrase on a sales call is a round
 * figure nearly every time, and a parser that handles "sattavan hazaar
 * chhiyasi" would be a lot of surface for a case that does not occur. The
 * long tail resolves as `unresolved` and becomes a clarification, which is the
 * right answer for a number nobody can read back.
 */
const NUMBER_WORDS: Record<string, number> = {
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  twentyfive: 25, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
  // Hindi
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chah: 6,
  cheh: 6, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10, dus: 10, gyarah: 11,
  barah: 12, pandrah: 15, bees: 20, pachchees: 25, pachees: 25, tees: 30,
  chalees: 40, pachaas: 50, pachas: 50, saath: 60, sattar: 70, assi: 80,
  nabbe: 90, sau: 100,
  // The fractional multipliers people say instead of a decimal.
  dedh: 1.5, dhai: 2.5, sava: 1.25, paune: 0.75,
};

/**
 * Fraction words. "aadha" is the one §7.2 names and the one that matters.
 *
 * `pura` / `full` is here as fraction 1: "pura de dunga" is a commitment to
 * the whole balance, and resolving it to "unresolved" would drop a promise the
 * business most wants recorded.
 */
/**
 * LONGEST AND MOST SPECIFIC FIRST, and that ordering is the whole correctness
 * of this table.
 *
 * "teen chauthai" (three quarters) CONTAINS "chauthai" (a quarter). Ordered the
 * other way round - which is the order they were first written in, shortest
 * idea first - the resolver takes three quarters of a balance to be one
 * quarter of it, silently, and the promise recorded is a third of the promise
 * made. Same shape as "three quarters" containing "quarter".
 */
const FRACTIONS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(?:three\s+fourths?|three\s+quarters?|teen\s+chauthai)\b/, 0.75],
  [/\b(?:two\s+thirds?)\b/, 2 / 3],
  [/\b(?:one\s+third|tihai)\b/, 1 / 3],
  [/\b(?:one\s+fourth|a\s+quarter|quarters?|chauthai|chautha)\b/, 0.25],
  [/\b(?:aadha|adha|aadhi|adhi|half)\b/, 0.5],
  [/\b(?:pura|poora|puri|full|whole|complete|entire|saara|sara)\b/, 1],
];

/**
 * The `\b` sits INSIDE the word alternatives, not after the group.
 *
 * `(?:%|percent|…)\b` does not match "20%" at the end of a string: `%` is not a
 * word character, so there is no boundary after it, and the whole phrase
 * resolved to `unresolved` while "20 percent" resolved fine. The boundary is
 * only meaningful for the spelled-out forms.
 */
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*(?:%|(?:percent|per\s*cent|pratishat|fisadi)\b)/;

// ── Normalisation ───────────────────────────────────────────────────────────

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

const SPELLING: ReadonlyArray<readonly [RegExp, string]> = [
  // Magnitudes and fractions in Devanagari - Sarvam's output for Hindi audio.
  [/लाख/g, "lakh"],
  [/करोड़|करोड/g, "crore"],
  [/हज़ार|हजार/g, "hazaar"],
  [/सौ/g, "sau"],
  [/आधा|आधी/g, "aadha"],
  [/पूरा|पूरी/g, "pura"],
  [/प्रतिशत/g, "pratishat"],
  // The number words too. Without these, "दो लाख" resolves to a magnitude with
  // no quantity - which is `unresolved`, on every Hindi-script amount.
  [/एक/g, "ek"],
  [/दो/g, "do"],
  [/तीन/g, "teen"],
  [/चार/g, "char"],
  [/पाँच|पांच/g, "paanch"],
  [/छह|छै/g, "chah"],
  [/सात/g, "saat"],
  [/आठ/g, "aath"],
  [/नौ/g, "nau"],
  [/दस/g, "das"],
  [/पंद्रह/g, "pandrah"],
  [/बीस/g, "bees"],
  [/पच्चीस/g, "pachchees"],
  [/तीस/g, "tees"],
  [/चालीस/g, "chalees"],
  [/पचास/g, "pachaas"],
  [/डेढ़|डेढ/g, "dedh"],
  [/ढाई/g, "dhai"],
  [/सवा/g, "sava"],
  [/रुपये|रुपए|रूपये|रुपया/g, "rupees"],
  // `\brs\b\.?` and not `\brs\.?\b`: the trailing boundary after a full stop
  // never matches, so "Rs. 500" became "rupees. 500" and the marker was lost.
  [/\brs\b\.?/g, "rupees"],
  [/\binr\b/g, "rupees"],
  [/₹/g, " rupees "],
  [/\btwenty\s*five\b/g, "twentyfive"],
];

export function normaliseAmountPhrase(raw: string): string {
  let text = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // Keep `%`, `₹` and the decimal point; drop everything else that is not a
    // letter, a mark, a digit or a separator. The thousands commas are dropped
    // with it, which is why `digitGroups` below reassembles them first.
    .replace(/[^\p{L}\p{M}\p{N}.,%₹\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  for (const [re, to] of SPELLING) text = text.replace(re, to);
  // Indian digit grouping: 1,25,000 and 125,000 both mean 125000. Done BEFORE
  // the decimal point is read, so "1,25,000.50" survives intact.
  text = text.replace(/(\d),(?=\d)/g, "$1");
  // Split a magnitude suffix off the digits it is stuck to. `\b` does not fire
  // between "15" and "k" - both are word characters - so `\bk\b` never matched
  // "15k" and the commonest way anybody writes fifteen thousand resolved to
  // nothing. One space makes every scale rule below work unchanged.
  text = text.replace(/(\d)\s*(crores?|cr|lakhs?|lacs?|k|l)\b/g, "$1 $2");
  return text.replace(/\s+/g, " ").trim();
}

// ── Resolution ──────────────────────────────────────────────────────────────

function roundMinor(value: number): number {
  // Round half away from zero, not JavaScript's half-up-toward-+Infinity.
  // Every amount here is positive, so they agree - but the next person to pass
  // a credit note through this should not have to discover that.
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  return rounded;
}

function minorFrom(major: number, currency: string): number | null {
  const scale = 10 ** currencyExponent(currency);
  const minor = roundMinor(major * scale);
  if (!Number.isFinite(minor) || Math.abs(minor) > MAX_MINOR) return null;
  return minor;
}

/** The leading quantity in the phrase: a numeral, a number word, or null. */
function quantityIn(text: string): { value: number; matched: string } | null {
  const numeral = /\b(\d+(?:\.\d+)?)\b/.exec(text);
  if (numeral) return { value: Number(numeral[1]), matched: "numeral" };

  // Longest word first, so "twentyfive" is not read as "twenty".
  const words = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length);
  for (const word of words) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      return { value: NUMBER_WORDS[word]!, matched: `word:${word}` };
    }
  }
  return null;
}

function scaleIn(text: string): { multiplier: number; matched: string } | null {
  for (const [re, multiplier] of SCALES) {
    if (re.test(text)) return { multiplier, matched: `scale:${multiplier}` };
  }
  return null;
}

/**
 * THE ENTRY POINT.
 *
 * ── A FRACTION OF A MAGNITUDE IS NOT A FRACTION OF THE TOTAL ────────────────
 *
 * "aadha lakh" (half a lakh) is an ABSOLUTE amount and needs no total;
 * "aadha de dunga" (I'll give half) is relative and does. Getting it wrong in
 * either direction invents a number: reading "aadha lakh" as half the deal
 * value, or refusing "aadha" for want of a total it never needed.
 *
 * ── AND THE FRACTION IS STRIPPED BEFORE THE REST IS READ ────────────────────
 *
 * This is the part that is easy to get wrong, and did get wrong. A first
 * version asked three independent questions of the whole phrase - "is there a
 * fraction", "is there a magnitude", "is there a number" - and then branched on
 * the combination. "three quarters" answers YES to both the first and the
 * third, because "three" is a number word; the fraction branches were guarded
 * on `!quantity`, so none of them fired, and the phrase fell through to the
 * plain-number branch, which saw 3 with no magnitude and refused. Three
 * quarters of a balance became `unresolved`, and so did "one third" and "two
 * thirds".
 *
 * So the fraction is matched first and REMOVED, and the remainder is what the
 * magnitude and quantity questions are asked about. Then:
 *
 *   "aadha"            nothing left        -> relative, needs a total
 *   "aadha lakh"       a magnitude         -> absolute: half of 100,000
 *   "aadha do lakh"    a magnitude + 2     -> absolute: half of 200,000
 *   "three quarters"   nothing left        -> relative
 */
export function resolveAmountPhrase(raw: string, ctx: AmountContext): AmountResolution {
  const currency = ctx.currency ?? DEFAULT_CURRENCY;
  const text = normaliseAmountPhrase(raw);
  if (!text) return { kind: "unresolved", reason: "empty phrase", matched: "" };

  const fraction = FRACTIONS.find(([re]) => re.test(text));

  if (fraction) {
    const rest = text.replace(fraction[0], " ").replace(/\s+/g, " ").trim();
    const restScale = scaleIn(rest);
    const restQuantity = quantityIn(rest);

    if (restScale) {
      const base = (restQuantity?.value ?? 1) * restScale.multiplier;
      const minor = minorFrom(fraction[1] * base, currency);
      if (minor === null) return OUT_OF_RANGE;
      return { kind: "exact", amountMinor: minor, currency, matched: "fraction-of-scale" };
    }
    // A number beside the fraction with no magnitude is not an amount
    // ("half of the 2 instalments"), so the fraction stays relative.
    return fractionOf(fraction[1], ctx, currency, "fraction");
  }

  // ── a percentage is always relative ──────────────────────────────────────
  const percent = PERCENT.exec(text);
  if (percent) return fractionOf(Number(percent[1]) / 100, ctx, currency, "percent");

  // ── a number, with or without a magnitude ────────────────────────────────
  const scale = scaleIn(text);
  const quantity = quantityIn(text);
  if (quantity) {
    // A bare number with no magnitude word and no currency marker is not an
    // amount. "call me at 5" has a 5 in it; so does "5 baje". An amount phrase
    // has to say it is money - a magnitude, a rupee marker, or a figure big
    // enough that nothing else it could plausibly be.
    const saysMoney = scale !== null || /\brupees\b/.test(text) || quantity.value >= 100;
    if (!saysMoney) {
      return {
        kind: "unresolved",
        reason: "a bare small number is not an amount",
        matched: quantity.matched,
      };
    }
    const minor = minorFrom(quantity.value * (scale?.multiplier ?? 1), currency);
    if (minor === null) return OUT_OF_RANGE;
    return {
      kind: "exact",
      amountMinor: minor,
      currency,
      matched: [quantity.matched, scale?.matched].filter(Boolean).join("+"),
    };
  }

  return { kind: "unresolved", reason: "no amount recognised", matched: "" };
}

const OUT_OF_RANGE: AmountResolution = {
  kind: "unresolved",
  reason: "amount out of range",
  matched: "overflow",
};

function fractionOf(
  fraction: number,
  ctx: AmountContext,
  currency: string,
  matched: string,
): AmountResolution {
  const total = ctx.totalsMinor.find((t) => Number.isFinite(t) && t > 0);
  if (total === undefined) {
    return {
      kind: "needs_total",
      fraction,
      // Phrased for the clarification task a person will read.
      reason: "the call gave a share, not an amount, and there is no total on this lead to take it of",
      matched,
    };
  }
  return {
    kind: "fraction",
    fraction,
    amountMinor: roundMinor(total * fraction),
    currency,
    matched,
  };
}
