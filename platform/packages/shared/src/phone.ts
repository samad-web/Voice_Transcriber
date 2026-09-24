import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
  type PhoneNumber,
} from "libphonenumber-js/max";
import examples from "libphonenumber-js/mobile/examples";

/**
 * PHONE NUMBERS, ONE RULE FOR THE WHOLE CONSOLE.
 *
 * Every phone field in the console is an `<PhoneInput>` (apps/web), and every
 * one of them validates through `checkPhone` below: the number must be a real,
 * dialable number under the numbering plan of the country its calling code
 * names - the exact national length, and a prefix that country actually
 * issues. "98765" is refused as too short for India; "+91 12345 67890" is
 * refused because no Indian number starts with 1.
 *
 * ── WHY A LIBRARY AND NOT A TABLE ────────────────────────────────────────────
 *
 * The marketing funnel keeps a hand table of 22 countries and their lengths
 * (funnel.ts). That is fine for a form whose audience is known; it is not for
 * a console whose clients call anywhere. Germany alone allows national numbers
 * from 4 to 13 digits depending on the area code. `libphonenumber-js/max` is
 * Google's libphonenumber metadata: the lengths AND the number patterns, per
 * country, kept current upstream.
 *
 * ── WHY IT IS NOT EXPORTED FROM THE INDEX ───────────────────────────────────
 *
 * The max metadata is ~150 KB. @aura/shared is CommonJS, so nothing
 * tree-shakes it, and exporting this from `index.ts` would ship it on every
 * page that imports a date formatter. Import it by path instead - the same
 * way the marketing site already imports `@aura/shared/dist/funnel`:
 *
 *     import { checkPhone } from "@aura/shared/dist/phone";
 *
 * ── WHAT IS STORED ──────────────────────────────────────────────────────────
 *
 * E.164 - "+919876543210". One spelling per number is what makes dedupe and
 * the missed-call match key work; a stored "098765 43210" and "+91-98765-43210"
 * are the same person to a human and two people to a unique index.
 */

export type { CountryCode };

/**
 * A number that passed `checkPhone`: E.164, valid for its country.
 *
 * Branded so a function that needs a checked number can say so in its
 * signature - a plain string from a form cannot be passed where an
 * `E164Phone` is expected without going through the check.
 */
export type E164Phone = string & { readonly __brand: "E164Phone" };

/** Where a workspace that has never chosen a country falls back to. */
export const DEFAULT_PHONE_COUNTRY: CountryCode = "IN";

/** Every country libphonenumber knows, ISO 3166-1 alpha-2. */
export const PHONE_COUNTRY_CODES: readonly CountryCode[] = getCountries();

/** Narrows an arbitrary string - a stored setting, a query param - to a known country. */
export function isPhoneCountry(value: unknown): value is CountryCode {
  return typeof value === "string" && isSupportedCountry(value);
}

/** `value` if it is a known country, else `fallback`. For settings read from storage. */
export function toPhoneCountry(value: unknown, fallback: CountryCode = DEFAULT_PHONE_COUNTRY): CountryCode {
  const upper = typeof value === "string" ? value.trim().toUpperCase() : value;
  return isPhoneCountry(upper) ? upper : fallback;
}

/** "+91" for IN. */
export function dialCode(country: CountryCode): string {
  return `+${getCountryCallingCode(country)}`;
}

let regionNames: Intl.DisplayNames | null | undefined;

/**
 * "India" for IN. English on purpose: the console is English, and the name
 * must come out the same on the server and in the browser.
 */
export function countryName(country: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(country) ?? country;
  } catch {
    return country;
  }
}

/**
 * The number as it reads BESIDE a country picker that already shows "+91":
 * "98765 43210", not the national "098765 43210". The trunk 0 is what you
 * dial from inside the country; next to the dial code it is a wrong digit.
 */
export function formatLocal(number: PhoneNumber): string {
  const intl = number.formatInternational();
  const prefix = `+${number.countryCallingCode}`;
  return intl.startsWith(prefix) ? intl.slice(prefix.length).trim() : number.formatNational();
}

/** A typical mobile number for `country`, as typed beside its dial code: "81234 56789" for IN. */
export function examplePhone(country: CountryCode): string | null {
  const example = getExampleNumber(country, examples);
  return example ? formatLocal(example) : null;
}

export interface PhoneCountry {
  iso: CountryCode;
  name: string;
  /** "+91" */
  dial: string;
}

let catalogue: PhoneCountry[] | null = null;

/** Every country, sorted by name. Built once per process. */
export function phoneCountries(): readonly PhoneCountry[] {
  if (!catalogue) {
    catalogue = PHONE_COUNTRY_CODES.map((iso) => ({ iso, name: countryName(iso), dial: dialCode(iso) })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    );
  }
  return catalogue;
}

/**
 * Countries matching a search: "ind", "IN", "+91" and "91" all find India.
 * An exact ISO code or dial code ranks first, then names that start with the
 * query, then names that merely contain it.
 */
export function searchPhoneCountries(query: string, list: readonly PhoneCountry[] = phoneCountries()): PhoneCountry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const dial = q.replace(/^\+/, "");
  const rank = (c: PhoneCountry): number => {
    const name = c.name.toLowerCase();
    if (c.iso.toLowerCase() === q || (/^\d+$/.test(dial) && c.dial === `+${dial}`)) return 0;
    if (name.startsWith(q)) return 1;
    if (/^\d+$/.test(dial) && c.dial.startsWith(`+${dial}`)) return 2;
    if (name.includes(q)) return 3;
    return -1;
  };
  return list
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name, "en"))
    .map((x) => x.c);
}

/** Why a number was refused. Stable codes; the text is `problem.message`. */
export type PhoneProblem = "required" | "not_a_number" | "too_short" | "too_long" | "invalid_length" | "invalid" | "wrong_country";

export type PhoneCheck =
  | { ok: true; empty: false; e164: E164Phone; country: CountryCode; national: string; international: string }
  | { ok: true; empty: true; e164: null }
  | { ok: false; empty: boolean; problem: PhoneProblem; message: string };

/** "an Indian" is beyond a generic formatter; "a number in India" is not. */
function lengthMessage(problem: "too_short" | "too_long" | "invalid_length", country: CountryCode): string {
  const example = examplePhone(country);
  const where = `${countryName(country)} (${dialCode(country)})`;
  const hint = example ? ` For example: ${example}.` : "";
  if (problem === "too_short") return `Too short for a number in ${where}.${hint}`;
  if (problem === "too_long") return `Too long for a number in ${where}.${hint}`;
  return `That is not the right number of digits for ${where}.${hint}`;
}

/**
 * Is `raw` a valid phone number for `country`?
 *
 * `raw` may be national ("98765 43210", "098765 43210") or international
 * ("+91 98765 43210", "0091 98765 43210"). An international number is checked
 * against its OWN calling code, and must then share `country`'s calling code -
 * so with India selected, "+971 50 123 4567" is refused as the wrong country
 * rather than quietly saved as a UAE number the form never showed. The
 * PhoneInput avoids ever hitting that by switching its country when a "+"
 * number is typed or pasted.
 *
 * Countries that share a calling code (+1: the US, Canada and the Caribbean;
 * +44: the UK and the Crown dependencies; +7) accept each other's numbers:
 * the user chose "+1", and a Toronto number IS a +1 number. `country` in the
 * result is the one the number actually belongs to.
 *
 * Any valid number type is accepted - mobile, fixed line, toll free - because
 * a business's contacts are not all mobiles.
 */
export function checkPhone(raw: string | null | undefined, country: CountryCode, opts: { required?: boolean } = {}): PhoneCheck {
  const text = (raw ?? "").trim();
  if (!/\d/.test(text)) {
    if (text === "" || text === "+") {
      return opts.required
        ? { ok: false, empty: true, problem: "required", message: "Enter a phone number." }
        : { ok: true, empty: true, e164: null };
    }
    return { ok: false, empty: false, problem: "not_a_number", message: "Enter digits only, like 98765 43210." };
  }
  // Letters are never part of a number here (no vanity numbers, no "ext.").
  if (/[a-z]/i.test(text)) {
    return { ok: false, empty: false, problem: "not_a_number", message: "A phone number can only contain digits, spaces and + ( ) -." };
  }
  const international = normaliseInternationalPrefix(text);

  const length = validatePhoneNumberLength(international, country);
  const parsed = parsePhoneNumberFromString(international, country);
  const owner: CountryCode = parsed?.country ?? country;
  if (length === "TOO_SHORT" || length === "TOO_LONG" || length === "INVALID_LENGTH") {
    const problem = length === "TOO_SHORT" ? "too_short" : length === "TOO_LONG" ? "too_long" : "invalid_length";
    return { ok: false, empty: false, problem, message: lengthMessage(problem, parsed?.country ?? callingCodeCountry(international) ?? country) };
  }
  if (length === "NOT_A_NUMBER" || length === "INVALID_COUNTRY" || !parsed) {
    return { ok: false, empty: false, problem: "not_a_number", message: "Enter a phone number, like 98765 43210." };
  }
  if (parsed.countryCallingCode !== getCountryCallingCode(country)) {
    return {
      ok: false,
      empty: false,
      problem: "wrong_country",
      message: `This is a ${dialCode(owner)} number, but ${countryName(country)} (${dialCode(country)}) is selected. Choose ${countryName(owner)} from the list.`,
    };
  }
  if (!parsed.isValid()) {
    // The country's possible lengths are the union over every number type -
    // India allows 8 to 13 digits across landlines and toll-free - so an
    // 11-digit Indian mobile is "a possible length" and only the pattern
    // check catches it. Say WHY it failed where that can be worked out.
    const shape = lengthShape(String(parsed.nationalNumber), owner);
    if (shape) return { ok: false, empty: false, problem: shape, message: lengthMessage(shape, owner) };
    return {
      ok: false,
      empty: false,
      problem: "invalid",
      message: `That is not a valid number in ${countryName(owner)}. Check the first digits.`,
    };
  }
  return {
    ok: true,
    empty: false,
    e164: parsed.number as E164Phone,
    country: owner,
    national: formatLocal(parsed),
    international: parsed.formatInternational(),
  };
}

/** True when `value` is already a valid E.164 number ("+919876543210"). */
export function isE164Phone(value: unknown): value is E164Phone {
  if (typeof value !== "string" || !/^\+[1-9]\d{6,14}$/.test(value)) return false;
  return parsePhoneNumberFromString(value)?.isValid() === true;
}

/**
 * The E.164 form of `raw` if it is valid for `country`, else null. For a
 * server that received a number from a console form.
 */
export function toE164(raw: string | null | undefined, country: CountryCode): E164Phone | null {
  const check = checkPhone(raw, country);
  return check.ok && !check.empty ? check.e164 : null;
}

/** "+91 98765 43210" for a stored "+919876543210"; anything unparseable comes back as stored. */
export function formatPhoneForDisplay(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  const parsed = parsePhoneNumberFromString(normaliseInternationalPrefix(text));
  return parsed?.isValid() ? parsed.formatInternational() : text;
}

/** "0091…" → "+91…". Leaves anything else alone. */
function normaliseInternationalPrefix(text: string): string {
  return text.replace(/^\s*00(?=[1-9])/, "+");
}

/** The main country for a "+" number's calling code, before it is complete enough to parse. */
function callingCodeCountry(text: string): CountryCode | undefined {
  if (!text.startsWith("+")) return undefined;
  const typer = new AsYouType();
  typer.input(text);
  return typer.getCountry() ?? mainCountryForCallingCode(typer.getCallingCode());
}

/** The country a calling code is "named after" - US for +1, GB for +44, RU for +7. */
export function mainCountryForCallingCode(code: string | undefined): CountryCode | undefined {
  if (!code) return undefined;
  const MAIN: Record<string, CountryCode> = { "1": "US", "7": "RU", "44": "GB", "47": "NO", "61": "AU", "262": "RE", "290": "SH", "358": "FI", "590": "GP", "599": "CW", "212": "MA" };
  return MAIN[code] ?? PHONE_COUNTRY_CODES.find((c) => getCountryCallingCode(c) === code);
}

/**
 * Splits a stored value into what the input shows: the country, and the
 * national part.
 *
 * A stored value is E.164 once it has been through this input, but rows saved
 * before it are free text - "98765 43210", "+91-98765-43210", "09876543210".
 * Anything that parses keeps its own country and is shown formatted; anything
 * that does not is shown exactly as stored under `fallback`, so a legacy value
 * is never silently rewritten or lost - the field shows it, flags it, and the
 * user fixes it.
 */
export function splitPhone(value: string | null | undefined, fallback: CountryCode): { country: CountryCode; national: string } {
  const text = (value ?? "").trim();
  if (!text) return { country: fallback, national: "" };
  const intl = normaliseInternationalPrefix(text);
  const parsed: PhoneNumber | undefined = parsePhoneNumberFromString(intl, fallback);
  if (parsed) {
    const country = parsed.country ?? (intl.startsWith("+") ? mainCountryForCallingCode(parsed.countryCallingCode) : undefined) ?? fallback;
    if (getCountryCallingCode(country) === parsed.countryCallingCode) {
      return { country, national: parsed.isValid() ? formatLocal(parsed) : String(parsed.nationalNumber) };
    }
  }
  if (intl.startsWith("+")) {
    const country = callingCodeCountry(intl);
    if (country) {
      const code = getCountryCallingCode(country);
      return { country, national: intl.replace(/[^\d]/g, "").slice(code.length) };
    }
  }
  return { country: fallback, national: text };
}

/**
 * What the national field shows while typing: "98765 43210" for "9876543210"
 * in IN. Only ever adds spacing and punctuation, never removes a digit.
 */
export function formatNationalAsYouType(national: string, country: CountryCode): string {
  const digits = national.replace(/[^\d]/g, "");
  if (!digits) return "";
  return new AsYouType(country).input(digits);
}

/**
 * Would these digits already be too long for `country`? The input refuses the
 * keystroke that makes a number longer than any number in that country, so
 * the length limit is felt while typing rather than read after.
 */
export function isTooLongForCountry(national: string, country: CountryCode): boolean {
  const digits = national.replace(/[^\d]/g, "");
  if (!digits) return false;
  if (validatePhoneNumberLength(digits, country) === "TOO_LONG") return true;
  // One digit past a complete number, where no longer number exists: India's
  // "9876543210" + "1". Germany's variable lengths are why this asks whether
  // the number could still grow instead of stopping at the first valid length.
  return (
    isValidFor(digits.slice(0, -1), country) && !isValidFor(digits, country) && !canGrowValid(digits, country)
  );
}

function isValidFor(digits: string, country: CountryCode): boolean {
  return digits.length > 0 && parsePhoneNumberFromString(digits, country)?.isValid() === true;
}

/** Could appending up to three digits make `digits` a valid number? */
function canGrowValid(digits: string, country: CountryCode): boolean {
  const example = getExampleNumber(country, examples);
  const tail = example ? String(example.nationalNumber) : "";
  if (tail.length > digits.length && isValidFor(digits + tail.slice(digits.length), country)) return true;
  for (let k = 1; k <= 3; k++) {
    for (let d = 0; d <= 9; d++) {
      if (isValidFor(digits + String(d).repeat(k), country)) return true;
    }
  }
  return false;
}

/** Too short (it could still become a number) or too long (a shorter one is), else null. */
function lengthShape(nationalDigits: string, country: CountryCode): "too_short" | "too_long" | null {
  for (let k = 1; k <= 3 && k < nationalDigits.length; k++) {
    if (isValidFor(nationalDigits.slice(0, -k), country)) return "too_long";
  }
  return canGrowValid(nationalDigits, country) ? "too_short" : null;
}
