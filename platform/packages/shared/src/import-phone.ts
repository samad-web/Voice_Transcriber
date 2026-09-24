import { checkPhone, countryName, splitPhone, type CountryCode, type E164Phone } from "./phone";

/**
 * THE PHONE CELL OF A CSV IMPORT, READ THE WAY THE CONSOLE READS A PHONE FIELD.
 *
 * Imported by path, never from the index - it pulls in `./phone`, whose ~150 KB
 * of libphonenumber metadata must not ride along on every page that imports a
 * date formatter (see phone.ts, "WHY IT IS NOT EXPORTED FROM THE INDEX"):
 *
 *     import { importPhone } from "@aura/shared/dist/import-phone";
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `contacts.phone_hash` is sha256 over the DIGITS OF THE E.164 NUMBER
 * ("919876543210"): the console's lead/contact forms normalise through
 * `checkPhone` against the workspace's country first (console-phone.ts), and
 * crm-ingest's `phoneParts` hashes what that produced. The importer used to hash
 * the digits exactly as typed - "9876543210", no country code - so every
 * imported contact hashed differently from the same person's lead, call and
 * console-created duplicate, and dedupe matched none of them. Same input to the
 * same hash, or the key is not a key.
 *
 * ── WHAT IT ACCEPTS BEYOND THE CONSOLE FORM ─────────────────────────────────
 *
 * A console field has a country picker; a spreadsheet does not, and it mangles
 * numbers in two predictable ways. Both are read back rather than refused:
 *
 *  - An explicit "+971 50 123 4567" names its own country. The form refuses it
 *    under India only because the person could have picked UAE instead; a CSV
 *    cell has no picker, and the "+" already said which country it is. The
 *    E.164 is what the console would store had they picked UAE, so the hash
 *    still agrees.
 *  - Excel stores "+91 98765 43210" as the NUMBER 919876543210 and drops the
 *    "+". Retried as "+<digits>" against the workspace's OWN country only - a
 *    bare "971501234567" is not unambiguous enough to guess a foreign country
 *    for, while one that starts with the workspace's own code is what it looks
 *    like. The retry runs only after the plain national read failed, so a
 *    valid national number is never reinterpreted.
 *
 * Anything else that fails is an ERROR for the row, never a quietly different
 * hash: a key that matches nobody is how the old behaviour lost every match.
 */

/**
 * Below this many digits a cell is junk ("n/a", "-", "0"), not a number. Same
 * floor as crm-ingest.service.ts `MIN_PHONE_DIGITS`, for the same reason: a
 * short digit string that became a dedupe key would merge every future junk
 * row onto one contact. `checkPhone` already refuses these - the floor is here
 * so the refusal says "too few digits" rather than a numbering-plan message
 * about a cell that was never a phone number.
 */
export const IMPORT_MIN_PHONE_DIGITS = 6;

export type ImportPhoneResult = { ok: true; e164: E164Phone | null } | { ok: false; message: string };

/** A phone cell as E.164, or null when blank, or the reason it is not a number for `country`. */
export function importPhone(raw: string | null | undefined, country: CountryCode): ImportPhoneResult {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, e164: null };

  const refuse = (why: string): ImportPhoneResult => ({
    ok: false,
    message: `"${text}" is not a valid phone number for ${countryName(country)} - ${why}`,
  });

  const digits = text.replace(/\D+/gu, "");
  if (digits.length < IMPORT_MIN_PHONE_DIGITS) return refuse("too few digits.");

  const check = checkPhone(text, country);
  if (check.ok) return { ok: true, e164: check.empty ? null : check.e164 };

  // An explicit "+"/"00" number that is valid under its OWN calling code.
  if (check.problem === "wrong_country") {
    const own = splitPhone(text, country).country;
    const again = checkPhone(text, own);
    if (again.ok && !again.empty) return { ok: true, e164: again.e164 };
  }

  // The spreadsheet that ate the "+": digits only, workspace's own code.
  if (/^[\d\s().-]+$/u.test(text) && digits.length >= 8 && digits.length <= 15) {
    const retry = checkPhone(`+${digits}`, country);
    if (retry.ok && !retry.empty) return { ok: true, e164: retry.e164 };
  }

  return refuse(check.message);
}
