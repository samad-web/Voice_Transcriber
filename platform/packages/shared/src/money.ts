/**
 * Money arithmetic in integer minor units (Build docs/finance-section-build-plan §2).
 *
 * ── WHY THIS FILE EXISTS WHEN `quotations.ts` ALREADY DOES MONEY MATH ───────
 *
 * `quotations.ts` multiplies IEEE-754 doubles and `round2()`s the result. That
 * is correct for one invoice's lines, where a half-paise error rounds away at
 * the end - and it is the wrong tool for a LEDGER, where the same sum is
 * reached by two different routes and the two must agree exactly. 18% of
 * 1999.99 is 359.9982 in binary floating point; a hundred of those summed and
 * then rounded is not the same number as a hundred rounded and then summed,
 * and the ledger's whole promise is that debits equal credits.
 *
 * So: **every finance calculation happens in paise, as integers.** The spec's
 * §2 says store `BIGINT` minor units; DECISIONS.md §3.1 explains why the
 * COLUMNS stay `numeric` (every money column that already exists is numeric,
 * and a dashboard number has to join to an invoice to drill down) and why the
 * ARITHMETIC moved here instead. Postgres `numeric` is exact decimal, so
 * nothing is lost at rest; the danger was only ever in JavaScript.
 *
 * ── THE BOUNDARY RULE ──────────────────────────────────────────────────────
 *
 * node-postgres returns `numeric` as a STRING, precisely so a driver never
 * has to decide what to round. `toMinor()` parses that string digit by digit
 * and never constructs a fractional double on the way. `toNumericString()`
 * goes back. Between those two calls, money is `number` holding an integer
 * count of paise - and `assertSafe` refuses anything that could not survive
 * the trip, rather than rounding it silently.
 *
 * Nothing here knows about GST, deals or schedules. Tax lives in
 * `gstin.ts`/`quotations.ts`; this is addition, apportionment and formatting.
 */

/**
 * Currencies this product quotes in, with their minor-unit exponent.
 *
 * Needed because `× 100` is not a universal truth: JPY has no minor unit and
 * KWD has three, so a "paise" assumption would be off by a factor of a
 * thousand on a Kuwaiti invoice. INR is the only one the product sells in
 * today (§15), and the others are here so the schema's "multi-currency-ready"
 * claim means something.
 */
const CURRENCY_EXPONENT: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

/** The default, and the one this product actually bills in. */
export const DEFAULT_CURRENCY = "INR";

/** Minor units per major unit for a currency; 2 for anything unrecognised. */
export function currencyExponent(currency: string | null | undefined): number {
  if (!currency) return 2;
  const exponent = CURRENCY_EXPONENT[currency.toUpperCase()];
  return exponent === undefined ? 2 : exponent;
}

/**
 * The ceiling, in minor units, past which `number` stops being exact.
 *
 * `Number.MAX_SAFE_INTEGER` paise is about ₹90,071 crore. A value above it
 * THROWS rather than rounding: a total that silently loses its last digit is
 * the one failure mode this file exists to prevent, and a business invoicing
 * more than that has earned a bigint refactor.
 */
export const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export class MoneyRangeError extends Error {}

function assertSafe(minor: number, what: string): number {
  if (!Number.isFinite(minor)) throw new MoneyRangeError(`${what} is not a finite amount`);
  if (!Number.isInteger(minor)) throw new MoneyRangeError(`${what} is not a whole minor unit`);
  if (Math.abs(minor) > MAX_MINOR) throw new MoneyRangeError(`${what} exceeds the exact range`);
  return minor;
}

/**
 * Parse whatever the database or an API body hands us into minor units.
 *
 * Accepts the `numeric` strings node-postgres returns ("1999.99", "1e3",
 * "-0.5"), a plain `number` from a JSON body, and null/undefined/"" as zero.
 *
 * ── WHY THE STRING PATH DOES NOT MULTIPLY ──────────────────────────────────
 *
 * `Number("1999.99") * 100` is 199998.99999999997, and `Math.round` rescues
 * that one but not every one: the point of taking the string apart is that
 * there is no case left to get lucky with. The integer and fractional halves
 * are parsed separately, the fraction is padded or truncated to the currency's
 * exponent, and the two are combined with integer arithmetic only.
 *
 * A `number` input cannot be treated that way - it is already a double, and
 * whatever precision it lost it lost before we saw it - so it goes through
 * `Math.round` on its own decimal string, which is the best available reading
 * of a value that was mis-typed upstream. Prefer the string path.
 */
export function toMinor(value: string | number | null | undefined, currency = DEFAULT_CURRENCY): number {
  if (value === null || value === undefined || value === "") return 0;
  const exponent = currencyExponent(currency);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MoneyRangeError("amount is not a finite number");
    // `toFixed` on a double is itself a rounding decision, which is exactly
    // why a numeric column should reach this function as a string.
    return assertSafe(Math.round(value * 10 ** exponent), "amount");
  }

  const text = value.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new MoneyRangeError(`not an amount: ${value}`);
  }
  const [, sign, whole, fraction = "", exp] = match;

  // Exponent notation is rare from Postgres but legal in numeric output, and
  // it is simpler to normalise it by shifting the decimal point than to add a
  // branch to the combination below.
  let digits = `${whole}${fraction}`;
  let pointFromRight = fraction.length - (exp ? Number(exp) : 0);
  if (pointFromRight < 0) {
    digits += "0".repeat(-pointFromRight);
    pointFromRight = 0;
  }
  // And the other direction: "1e-2" is one digit with the point two places to
  // its left, so the digit string has to be padded to reach it. Without this
  // the slice below takes "1" as the FRACTION's leading digit and reads 0.01
  // as 0.10 - a factor of ten, on the one input shape nobody tests by hand.
  if (pointFromRight > digits.length) {
    digits = "0".repeat(pointFromRight - digits.length) + digits;
  }

  const wholePart = digits.slice(0, digits.length - pointFromRight) || "0";
  const fractionPart = digits.slice(digits.length - pointFromRight);

  const padded = (fractionPart + "0".repeat(exponent)).slice(0, exponent);
  // Anything past the currency's exponent is sub-paise. It is TRUNCATED, not
  // rounded: these digits only ever arrive from a numeric column with more
  // scale than the currency has, and rounding a tenth of a paise up would
  // invent money that no payment instrument can move.
  const minor = Number(wholePart) * 10 ** exponent + Number(padded || "0");
  return assertSafe(sign === "-" ? -minor : minor, "amount");
}

/**
 * Minor units back to the decimal string a `numeric` column takes.
 *
 * A STRING, not a number, so the value handed to `client.query` is the exact
 * one computed here. Binding a double would re-introduce the problem this
 * file removes, one parameter before the database.
 */
export function toNumericString(minor: number, currency = DEFAULT_CURRENCY): string {
  assertSafe(minor, "amount");
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(minor);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** exponent);
  const fraction = String(abs % 10 ** exponent).padStart(exponent, "0");
  return `${sign}${whole}.${fraction}`;
}

/** Minor units as a major-unit `number`, for a JSON response. */
export function toMajor(minor: number, currency = DEFAULT_CURRENCY): number {
  return Number(toNumericString(minor, currency));
}

/** Sum, in minor units, refusing to overflow the exact range quietly. */
export function sumMinor(values: readonly number[]): number {
  return assertSafe(
    values.reduce((total, v) => total + assertSafe(v, "amount"), 0),
    "total",
  );
}

/**
 * `amount × rate` where rate is a percentage, rounded half-up to the minor
 * unit. Used for tax, gateway fees, incentive percentages and the forecast's
 * collection probabilities.
 *
 * Half-up, not banker's rounding: it is what every Indian invoice, every GST
 * portal and `quotations.ts` already do, and a finance module that rounded a
 * different way from the invoice beside it would be unexplainable.
 */
export function percentOf(minor: number, percent: number): number {
  assertSafe(minor, "amount");
  if (!Number.isFinite(percent)) throw new MoneyRangeError("percent is not finite");
  const product = (minor * percent) / 100;
  return assertSafe(Math.sign(product) * Math.round(Math.abs(product)), "amount");
}

/**
 * Split `minor` into `parts` pieces that sum to EXACTLY `minor`.
 *
 * ₹100 in three is 3333/3333/3334 paise, never 3333×3 - the remainder has to
 * land somewhere, and the alternative is a payment schedule whose instalments
 * do not add up to the deal. The spare minor units go to the EARLIEST parts,
 * so the customer's last instalment is never the odd one and a schedule reads
 * the way a human would write it.
 */
export function splitEvenly(minor: number, parts: number): number[] {
  assertSafe(minor, "amount");
  if (!Number.isInteger(parts) || parts < 1) throw new MoneyRangeError("parts must be >= 1");
  const base = Math.trunc(minor / parts);
  let remainder = minor - base * parts;
  const step = remainder < 0 ? -1 : 1;
  return Array.from({ length: parts }, () => {
    if (remainder === 0) return base;
    remainder -= step;
    return base + step;
  });
}

/**
 * Apportion `minor` across `weights` so the pieces sum to exactly `minor`.
 *
 * The largest-remainder method: floor every share, then hand the leftover
 * minor units to whichever weights were cut hardest. Used wherever a total has
 * to be attributed without inventing or losing money - a document discount
 * across lines, a settlement's fee across its payments, CAC across the
 * campaigns that earned it.
 *
 * All-zero (or empty) weights fall back to an even split rather than throwing:
 * a cost with no driver to attribute it by is a real situation, and dropping
 * the money would make the column stop reconciling.
 */
export function apportion(minor: number, weights: readonly number[]): number[] {
  assertSafe(minor, "amount");
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new MoneyRangeError("weights must be finite and non-negative");
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return splitEvenly(minor, weights.length);

  const exact = weights.map((w) => (minor * w) / totalWeight);
  const floored = exact.map((v) => Math.trunc(v));
  let remainder = minor - floored.reduce((a, b) => a + b, 0);
  const step = remainder < 0 ? -1 : 1;

  const order = exact
    .map((value, index) => ({ index, fraction: Math.abs(value - floored[index]) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of order) {
    if (remainder === 0) break;
    floored[index] += step;
    remainder -= step;
  }
  return floored;
}

/**
 * Indian digit grouping - 12,34,567 rather than 1,234,567 (§11's
 * "Indian digit grouping option").
 *
 * Hand-rolled instead of `Intl.NumberFormat('en-IN')` because this runs in
 * three places - the API, a Next server component and the browser - and
 * `Intl`'s ICU data differs between a Node build and a browser. A number that
 * reads 1,234,567 on the server and 12,34,567 after hydration is a React
 * hydration mismatch, which is a class of bug this console already has one
 * live instance of and does not need a second.
 */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${tail}`;
}

export interface FormatMoneyOptions {
  currency?: string;
  /** Western grouping (1,234,567) instead of Indian. Default: Indian for INR. */
  grouping?: "indian" | "western";
  /** Drop the minor units entirely - for an axis label or a KPI tile. */
  whole?: boolean;
  /** Prefix with the currency symbol. Default true. */
  symbol?: boolean;
  /**
   * `-₹500` (the default) or `(₹500)`. Accounting parentheses are offered
   * because §11 asks for "negative numbers clear", and a minus sign in front
   * of a right-aligned column of rupees is the easiest character on a screen
   * to miss.
   */
  negative?: "sign" | "parentheses";
}

const SYMBOLS: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  AED: "AED ",
  JPY: "¥",
};

/**
 * One formatter, used by every finance surface (§11: "consistent number
 * formatting"). Takes MINOR units, so a caller cannot format a value it has
 * not converted.
 */
export function formatMoney(minor: number, options: FormatMoneyOptions = {}): string {
  const currency = options.currency ?? DEFAULT_CURRENCY;
  const exponent = currencyExponent(currency);
  const grouping = options.grouping ?? (currency === "INR" ? "indian" : "western");
  const negative = options.negative ?? "sign";
  const symbol = options.symbol === false ? "" : (SYMBOLS[currency] ?? `${currency} `);

  assertSafe(minor, "amount");
  const abs = Math.abs(minor);
  const rounded = options.whole ? Math.round(abs / 10 ** exponent) * 10 ** exponent : abs;
  const whole = String(Math.floor(rounded / 10 ** exponent));
  const grouped =
    grouping === "indian" ? groupIndian(whole) : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction =
    options.whole || exponent === 0
      ? ""
      : `.${String(rounded % 10 ** exponent).padStart(exponent, "0")}`;

  const body = `${symbol}${grouped}${fraction}`;
  if (minor >= 0) return body;
  return negative === "parentheses" ? `(${body})` : `-${body}`;
}

/**
 * ₹1.2 L / ₹3.4 Cr for a chart axis or a tile that has no room for digits.
 *
 * Lakh and crore rather than K/M, because the people reading these dashboards
 * talk in lakhs and crores, and "₹0.12M" is a translation they would have to
 * do in their head.
 */
export function formatMoneyCompact(minor: number, currency = DEFAULT_CURRENCY): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const sign = minor < 0 ? "-" : "";
  const major = Math.abs(minor) / 10 ** currencyExponent(currency);
  if (major >= 1e7) return `${sign}${symbol}${trim(major / 1e7)} Cr`;
  if (major >= 1e5) return `${sign}${symbol}${trim(major / 1e5)} L`;
  if (major >= 1e3) return `${sign}${symbol}${trim(major / 1e3)} K`;
  return `${sign}${symbol}${trim(major)}`;
}

function trim(value: number): string {
  // One decimal below 100, none above: "₹12.3 L" and "₹123 L" are both read at
  // a glance, "₹123.4 L" is a number somebody has to focus on.
  const text = value < 100 ? value.toFixed(1) : value.toFixed(0);
  return text.replace(/\.0$/, "");
}

/**
 * A ratio for a rate metric (collection rate, margin, fee %), or null when
 * the denominator is zero.
 *
 * Null rather than 0, and that distinction is the whole reason this is a
 * function: a month with no billing has NO collection rate, and showing 0%
 * tells an owner they collected nothing when there was nothing to collect.
 * Every rate in `finance-metrics.ts` returns null the same way, and the
 * dashboards render null as "—".
 */
export function ratio(numerator: number, denominator: number): number | null {
  // `> 0`, not merely non-zero. A NEGATIVE denominator is reachable here - a
  // month whose refunds exceeded its receipts has negative collections - and
  // `(collected - costs) / collected` on a negative base yields a POSITIVE
  // margin for a business that lost money, which is the worst possible answer
  // to give an owner. "Cannot tell" is the honest one.
  //
  // These are also exactly the semantics `call-insights.ts` has had since it
  // shipped; that file now re-exports this function rather than keeping a
  // second copy of it.
  return denominator > 0 && Number.isFinite(numerator) ? numerator / denominator : null;
}

/** `ratio` as a percentage rounded to one decimal, or null. */
export function percentage(numerator: number, denominator: number): number | null {
  const r = ratio(numerator, denominator);
  return r === null ? null : Math.round(r * 1000) / 10;
}
