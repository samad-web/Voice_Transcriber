/**
 * Money and rates, for the operator's commercial dashboard (doc 49 P13c).
 *
 * ── EVERY AMOUNT ARRIVES IN MINOR UNITS ─────────────────────────────────────
 *
 * The API returns `minor` integers throughout - paise, fils - because that is
 * what the price list, the orders and the tax arithmetic are all integer-exact
 * in. Nothing here ever does float arithmetic on money; it formats and divides
 * once, at the last possible moment, for display only.
 *
 * ── AND ITS CURRENCY, WHICH IS NOT DECORATION ───────────────────────────────
 *
 * The API deliberately returns revenue grouped per currency and never summed
 * across them, because INR + AED is not money. These helpers take a currency
 * for the same reason: a formatter that assumed ₹ would print an AED figure
 * with a rupee sign, which is the quietest possible way to be wrong about
 * money.
 */

/** Minor units per major unit. Both live currencies are two-decimal. */
const EXPONENT = 2;

const SYMBOL: Record<string, string> = { INR: "₹", AED: "AED " };

/**
 * A money amount, in the currency it is denominated in.
 *
 * Whole units only - no paise. Every figure on this screen is a monthly
 * revenue total or an invoice amount, where two decimal places are noise that
 * costs the eye a comparison between tiles. `toLocaleString` with the Indian
 * grouping, because ₹12,69,900 is what an Indian operator reads fluently and
 * ₹1,269,900 is not.
 */
export function money(minor: number, currency: string | null): string {
  const code = currency || "INR";
  const major = Math.round(minor / 10 ** EXPONENT);
  const grouped = major.toLocaleString(code === "INR" ? "en-IN" : "en-AE");
  return `${SYMBOL[code] ?? `${code} `}${grouped}`;
}

/**
 * A compact money amount for a chart axis or a dense cell.
 *
 * Indian units - L for lakh, Cr for crore - for INR, because an operator
 * reading an Indian price list thinks in them and "1.2M" is a translation they
 * have to do in their head. k/M for anything else.
 */
export function moneyShort(minor: number, currency: string | null): string {
  const code = currency || "INR";
  const major = minor / 10 ** EXPONENT;
  const sym = SYMBOL[code] ?? `${code} `;
  const fmt = (n: number, suffix: string) =>
    `${sym}${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (code === "INR") {
    if (major >= 1e7) return fmt(major / 1e7, "Cr");
    if (major >= 1e5) return fmt(major / 1e5, "L");
    if (major >= 1e3) return fmt(major / 1e3, "k");
  } else {
    if (major >= 1e6) return fmt(major / 1e6, "M");
    if (major >= 1e3) return fmt(major / 1e3, "k");
  }
  return `${sym}${Math.round(major).toLocaleString(code === "INR" ? "en-IN" : "en-AE")}`;
}

/**
 * Basis points as a percentage.
 *
 * One decimal place, and the input is basis points precisely so that rounding
 * happens ONCE: the API computes in bp, this divides by 100, and nothing
 * rounds a percentage that was already rounded. Two roundings can move a
 * headline share by a whole point.
 */
export function pct(bp: number | null | undefined, digits = 1): string {
  if (bp === null || bp === undefined) return "—";
  return `${(bp / 100).toFixed(digits)}%`;
}

/**
 * A trend sentence for `StatCard`, or null when there is nothing to compare.
 *
 * Null for a null delta, which the API returns when the previous period was
 * zero. "+100%" for a first customer is flattering nonsense, and a tile that
 * simply omits the trend line is the honest rendering of "no basis for a
 * comparison".
 *
 * Glyph and words, never colour: green and red already mean answered and
 * missed in this console, so a coloured arrow here would claim a call state.
 */
export function trendFromBp(
  bp: number | null | undefined,
  against: string,
): { kind: "up" | "down" | "flat"; text: string } | null {
  if (bp === null || bp === undefined) return null;
  if (bp === 0) return { kind: "flat", text: `level with ${against}` };
  const glyph = bp > 0 ? "▲" : "▼";
  return {
    kind: bp > 0 ? "up" : "down",
    text: `${glyph} ${pct(Math.abs(bp), 0)} vs ${against}`,
  };
}

/** Whole minutes as hours and minutes, for a capture meter. */
export function hoursMinutes(minutes: number): string {
  const whole = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (whole === 0) return `${rest}m`;
  return rest === 0 ? `${whole}h` : `${whole}h ${rest}m`;
}

/** "3 days", "14 hours" - the age of the oldest unsettled order. */
export function ageFrom(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const hours = Math.floor((now - then) / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}
