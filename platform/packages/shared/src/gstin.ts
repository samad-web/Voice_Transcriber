/**
 * GSTIN and PAN, validated the way the GST portal validates them (doc 27 §4.3).
 *
 * ── THE THREE CHECKS, AND WHY ALL THREE ───────────────────────────────────
 *
 * A GSTIN is 15 characters: a 2-digit state code, the holder's 10-character
 * PAN, an entity number, a literal `Z`, and a mod-36 check character.
 *
 *   1. The FORMAT regex catches a mistyped length or a letter where a digit
 *      belongs. It is also the migration's CHECK, as a backstop.
 *   2. The CHECKSUM catches a single wrong character or two swapped ones - the
 *      two ways a number copied off a letterhead actually goes wrong. The regex
 *      cannot, and a GSTIN that passes the regex with a wrong checksum is a
 *      number that will be rejected the day an invoice carrying it is filed.
 *   3. The STATE PREFIX must equal the chosen state's GST code. A GSTIN is
 *      registered per state, so "27..." with the state set to Karnataka is not
 *      a typo in either field, it is a contradiction - and the one that decides
 *      whether an invoice charges CGST+SGST or IGST.
 *
 * The checksum lives here, in code, not in a CHECK constraint. A regex CHECK is
 * the floor; this is the rule.
 */

/** GST state and union-territory codes, as the GST portal assigns them. */
export const GST_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  // 25 (Daman and Diu) merged into 26 in January 2020; kept out of the picker
  // because no new registration can carry it.
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

const STATE_CODES = new Set(GST_STATES.map((s) => s.code));

export function isGstStateCode(code: string | null | undefined): boolean {
  return typeof code === "string" && STATE_CODES.has(code);
}

export function gstStateName(code: string | null | undefined): string | null {
  return GST_STATES.find((s) => s.code === code)?.name ?? null;
}

/** Same pattern as the migration's CHECK. */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The check character for the first 14 characters of a GSTIN.
 *
 * Mod-36 with alternating weights 1 and 2 from the left, each product folded
 * back into base 36 (quotient + remainder), exactly as the GST portal computes
 * it. Returns null for input with a character outside 0-9A-Z.
 */
export function gstinCheckChar(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36];
}

/** Upper-cased and stripped of spaces, the way people paste it. */
export function normaliseGstin(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export type GstinProblem = "format" | "checksum" | "state";

/**
 * Why a GSTIN is not acceptable, or null when it is.
 *
 * `stateCode` is the state chosen on the same form; pass null to skip the
 * prefix check (a caller that has no state yet).
 */
export function gstinProblem(gstin: string, stateCode: string | null): GstinProblem | null {
  if (!GSTIN_PATTERN.test(gstin)) return "format";
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return "checksum";
  if (stateCode !== null && gstin.slice(0, 2) !== stateCode) return "state";
  return null;
}

/** The sentence each problem is shown as, beside the field. */
export const GSTIN_PROBLEM_TEXT: Record<GstinProblem, string> = {
  format: "A GSTIN is 15 characters, like 27ABCDE1234F1Z5.",
  checksum: "This GSTIN's last character doesn't match the rest. Check it for a typo.",
  state: "The first two digits of a GSTIN are its state code, and they don't match the state you chose.",
};

/**
 * The PAN inside a GSTIN: characters 3 to 12. The form fills PAN from this and
 * makes it read-only whenever a GSTIN is present, so the two cannot disagree.
 */
export function panFromGstin(gstin: string): string | null {
  if (!GSTIN_PATTERN.test(gstin)) return null;
  return gstin.slice(2, 12);
}
