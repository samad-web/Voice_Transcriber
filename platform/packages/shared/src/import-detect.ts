import { z } from "zod";

import { isCalendarDate } from "./call-insights";
import { GSTIN_PATTERN, PAN_PATTERN } from "./gstin";
import { toMinor } from "./money";

/**
 * Import structure and content detection
 * (Build docs/indian-business-finance-documents-cycles-import §3).
 *
 * ── DETECT, SUGGEST, CONFIRM - AND THE CONFIRM IS NOT OPTIONAL ──────────────
 *
 * §3's own framing: "'Automatically' works best as detect, suggest and
 * confirm, not silent import. Finance data wrongly imported is hard to unwind."
 *
 * Every function here therefore returns a SUGGESTION with its confidence and
 * its reasons, never a decision. Nothing in this file writes anything, and
 * nothing in it is allowed to resolve an ambiguity by picking the likelier
 * option: `detectDateOrder` returns `ambiguous` rather than guessing `dmy`
 * because the whole file reads the same either way and a wrong guess moves
 * every payment in it by up to eleven months.
 *
 * ── IT IS ALL PURE, WHICH IS WHAT MAKES IT TESTABLE AT ALL ──────────────────
 *
 * The parsing happens in the BROWSER (see `apps/web/.../import`), the
 * validation happens in the API, and both call these functions. A detector
 * that reached a database could not be used by the first and a detector in the
 * console could not be trusted by the second.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Structure: which row is the header, and which rows are not data
// ─────────────────────────────────────────────────────────────────────────────

/** How many leading rows `detectHeaderRow` will look through. */
export const MAX_HEADER_SCAN_ROWS = 25;

export interface HeaderDetection {
  /** Zero-based row index, or null when nothing in the file looks like a header. */
  index: number | null;
  /** 0-1. Below ~0.5 the console should make the person confirm it. */
  confidence: number;
  reason: string;
}

const isBlankCell = (cell: string | null | undefined): boolean => !cell || cell.trim() === "";

export function isBlankRow(cells: readonly (string | null)[]): boolean {
  return cells.every(isBlankCell);
}

/**
 * Words that mark a row as a total rather than a record.
 *
 * Anchored, not substring-matched: a customer called "Grand Total Traders" is
 * a real contact, and a vendor named "Subtotal Systems" would otherwise vanish
 * from every import. `isTotalRow` checks whether a cell IS one of these (give
 * or take punctuation and a colon), not whether it contains one.
 */
const TOTAL_WORDS = [
  "total",
  "totals",
  "grand total",
  "sub total",
  "subtotal",
  "sum",
  "closing balance",
  "opening balance",
  "balance c/f",
  "balance b/f",
  "carried forward",
  "brought forward",
  "net total",
  "grand totals",
];

const normalizeCell = (cell: string): string =>
  cell
    .trim()
    .toLowerCase()
    .replace(/[:\-–—_.*]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Is this a total or subtotal row that should be dropped?
 *
 * Requires the total word in a cell AND at least one numeric cell, so a
 * genuinely empty "Total" separator row and a data row whose first column
 * happens to read "Sum" are both handled correctly. A row reading only
 * "Total" with no figures is blank-ish and is caught by `isBlankRow` or by
 * required-field validation instead.
 */
export function isTotalRow(cells: readonly (string | null)[]): boolean {
  const present = cells.filter((c): c is string => !isBlankCell(c));
  if (present.length === 0) return false;
  const hasTotalWord = present.some((c) => TOTAL_WORDS.includes(normalizeCell(c)));
  if (!hasTotalWord) return false;
  // A total row is mostly empty with a number or two in it. Requiring that it
  // be mostly empty is what stops a one-column list of the word "Total" from
  // eating a legitimate single-column import.
  return present.length <= Math.max(3, Math.ceil(cells.length / 2));
}

/**
 * Which row is the header?
 *
 * ── WHY NOT "THE FIRST ROW" ─────────────────────────────────────────────────
 *
 * §3: "find the real header row (skipping title rows and merged cells)". Real
 * files from a bank or from Tally open with a title, the account number, a
 * date range and a blank line before the column names. Taking row 0 gives a
 * mapping step whose column list is ["HDFC BANK LTD", "", "", ""], and the
 * person's first experience of the feature is a wall of unmappable columns.
 *
 * The signal that works: a header row has several non-empty cells, they are
 * mostly short text, and they are mostly NOT numbers - while the row under it
 * usually does contain numbers. A merged title cell looks like one filled cell
 * in a row of blanks, which scores near zero.
 */
export function detectHeaderRow(grid: readonly (readonly (string | null)[])[]): HeaderDetection {
  if (grid.length === 0) return { index: null, confidence: 0, reason: "The file has no rows." };

  let best: { index: number; score: number } | null = null;
  const limit = Math.min(grid.length, MAX_HEADER_SCAN_ROWS);

  for (let i = 0; i < limit; i += 1) {
    const row = grid[i];
    const filled = row.filter((c): c is string => !isBlankCell(c));
    if (filled.length < 2) continue;

    const numeric = filled.filter((c) => looksNumeric(c)).length;
    const longCells = filled.filter((c) => c.trim().length > 60).length;
    // Density: a header spans most of the used width. A stray note in column F
    // is two filled cells in a wide row and scores badly.
    const density = filled.length / Math.max(1, row.length);
    const textShare = (filled.length - numeric) / filled.length;

    let score = textShare * 0.55 + Math.min(density, 1) * 0.3;
    // A row whose successor has numbers in it is very likely a header.
    const next = grid[i + 1];
    if (next && next.some((c) => c !== null && !isBlankCell(c) && looksNumeric(c))) score += 0.15;
    // Penalties: long prose cells are a title or a note, duplicate labels are
    // a second header band from a merged cell.
    if (longCells > 0) score -= 0.3;
    const distinct = new Set(filled.map((c) => normalizeCell(c))).size;
    if (distinct < filled.length) score -= 0.15;
    // Earlier rows win ties: the first plausible header is the header.
    score -= i * 0.004;

    if (!best || score > best.score) best = { index: i, score };
  }

  if (!best || best.score <= 0) {
    return { index: null, confidence: 0, reason: "No row in this file looks like a row of column names." };
  }
  const confidence = Math.max(0, Math.min(1, best.score));
  return {
    index: best.index,
    confidence,
    reason:
      best.index === 0
        ? "The first row holds the column names."
        : `Rows 1-${best.index} look like a title block, so row ${best.index + 1} is being read as the column names.`,
  };
}

function looksNumeric(cell: string): boolean {
  const trimmed = cell.trim();
  if (trimmed === "") return false;
  return /^[₹$€£\s]*[-(]?[\d,.\s]+\)?\s*(cr|dr)?$/i.test(trimmed) && /\d/.test(trimmed);
}

/**
 * The grid reduced to a header row and the data rows under it.
 *
 * Blank and total rows are dropped here rather than during validation, so the
 * dry-run counts a person reads ("120 new, 15 updates") are counts of real
 * records. A file whose last row is "Total 4,52,000" should not report one
 * error; it should report nothing, because that row was never data.
 */
export interface SplitGrid {
  headers: string[];
  rows: string[][];
  /** Source row numbers, 1-based, for every kept row - for the error report. */
  sourceRowNumbers: number[];
  skippedBlank: number;
  skippedTotals: number;
  header: HeaderDetection;
}

export function splitGrid(
  grid: readonly (readonly (string | null)[])[],
  opts: { headerRow?: number } = {},
): SplitGrid {
  const header =
    opts.headerRow === undefined
      ? detectHeaderRow(grid)
      : { index: opts.headerRow, confidence: 1, reason: "Chosen by hand." };

  if (header.index === null || !grid[header.index]) {
    return {
      headers: [],
      rows: [],
      sourceRowNumbers: [],
      skippedBlank: 0,
      skippedTotals: 0,
      header,
    };
  }

  const headers = dedupeHeaders(grid[header.index].map((c) => (c ?? "").trim()));
  const rows: string[][] = [];
  const sourceRowNumbers: number[] = [];
  let skippedBlank = 0;
  let skippedTotals = 0;

  for (let i = header.index + 1; i < grid.length; i += 1) {
    const raw = grid[i];
    if (isBlankRow(raw)) {
      skippedBlank += 1;
      continue;
    }
    if (isTotalRow(raw)) {
      skippedTotals += 1;
      continue;
    }
    rows.push(headers.map((_, col) => (raw[col] ?? "").trim()));
    sourceRowNumbers.push(i + 1);
  }

  return { headers, rows, sourceRowNumbers, skippedBlank, skippedTotals, header };
}

/**
 * Make every header unique and non-empty.
 *
 * A sheet with two columns called "Amount" (gross and net, say) would otherwise
 * have the second silently shadow the first in every row object, and the
 * mapping step would offer one column where the file has two. An unnamed
 * column becomes "Column 4" so it can still be mapped or ignored by name.
 */
export function dedupeHeaders(headers: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((raw, i) => {
    const base = raw.trim() === "" ? `Column ${i + 1}` : raw.trim();
    const key = base.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Content patterns - §3's "GSTIN, PAN, phone numbers, dates, ₹ amounts, IFSC"
// ─────────────────────────────────────────────────────────────────────────────

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
/** A UPI handle, which is how a great many small payments are referenced. */
export const UPI_PATTERN = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z]{1,64}$/;

export const CellKind = z.enum([
  "empty",
  "gstin",
  "pan",
  "ifsc",
  "upi",
  "phone",
  "date",
  "amount",
  "number",
  "text",
]);
export type CellKind = z.infer<typeof CellKind>;

/**
 * What one cell looks like.
 *
 * Order matters: the specific identifier patterns are tried before the generic
 * ones, because a GSTIN is also "text" and a PAN is also "text", and the whole
 * point is to recognise the specific thing. `amount` before `number` for the
 * same reason - a cell reading "₹1,02,500" is a number too, but saying so
 * loses the fact that somebody wrote it as money.
 */
export function classifyCell(raw: string | null | undefined): CellKind {
  if (raw === null || raw === undefined) return "empty";
  const value = raw.trim();
  if (value === "") return "empty";

  const upper = value.toUpperCase().replace(/\s+/g, "");
  if (GSTIN_PATTERN.test(upper)) return "gstin";
  if (PAN_PATTERN.test(upper)) return "pan";
  if (IFSC_PATTERN.test(upper)) return "ifsc";
  if (UPI_PATTERN.test(value) && !value.includes(" ")) return "upi";

  if (looksLikeDate(value)) return "date";
  if (looksLikePhone(value)) return "phone";
  if (looksLikeMoney(value)) return "amount";
  if (looksNumeric(value)) return "number";
  return "text";
}

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(digits)) return false;
  const bare = digits.replace(/^\+/, "");
  // 10 digits (Indian mobile), or 11-13 with a country code. Narrow on
  // purpose: a 10-digit invoice number is indistinguishable from a mobile
  // number, so this only claims a cell that also starts the way an Indian
  // mobile does, or that carries a plus.
  if (digits.startsWith("+")) return bare.length >= 10 && bare.length <= 15;
  if (bare.length === 10) return /^[6-9]/.test(bare);
  if (bare.length === 11) return bare.startsWith("0") && /^0[6-9]/.test(bare);
  if (bare.length === 12) return bare.startsWith("91") && /^91[6-9]/.test(bare);
  return false;
}

function looksLikeMoney(value: string): boolean {
  if (/[₹$€£]/.test(value)) return true;
  if (/\b(cr|dr)\b/i.test(value) && /\d/.test(value)) return true;
  if (/^\(.*\)$/.test(value.trim()) && /\d/.test(value)) return true;
  // A grouped number is money by convention: 1,02,500 or 102,500.
  return /^-?\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(value.trim());
}

function looksLikeDate(value: string): boolean {
  const trimmed = value.trim();
  if (isCalendarDate(trimmed)) return true;
  // dd/mm/yyyy and friends, with 2- or 4-digit years.
  if (/^\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}$/.test(trimmed)) return true;
  // "17 Sep 2026", "17-Sep-26", "Sep 17, 2026".
  if (/^\d{1,2}[\s\-]?[A-Za-z]{3,9}[\s\-]?\d{2,4}$/.test(trimmed)) return true;
  if (/^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}$/.test(trimmed)) return true;
  return false;
}

/** The share of non-empty cells in a column that look like `kind`. */
export function columnKindShare(values: readonly (string | null)[], kind: CellKind): number {
  const present = values.filter((v) => classifyCell(v) !== "empty");
  if (present.length === 0) return 0;
  return present.filter((v) => classifyCell(v) === kind).length / present.length;
}

/** The kind most of a column's cells are, and how dominant it is. */
export function dominantKind(values: readonly (string | null)[]): { kind: CellKind; share: number } {
  const counts = new Map<CellKind, number>();
  let present = 0;
  for (const value of values) {
    const kind = classifyCell(value);
    if (kind === "empty") continue;
    present += 1;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (present === 0) return { kind: "empty", share: 1 };
  let bestKind: CellKind = "text";
  let bestCount = -1;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      bestKind = kind;
      bestCount = count;
    }
  }
  return { kind: bestKind, share: bestCount / present };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates: the ambiguity that matters more than anything else here
// ─────────────────────────────────────────────────────────────────────────────

export const DateOrder = z.enum(["iso", "dmy", "mdy", "ambiguous", "conflict"]);
export type DateOrder = z.infer<typeof DateOrder>;

export interface DateOrderDetection {
  order: DateOrder;
  /** Which values forced the conclusion - shown in the console's preview. */
  evidence: string[];
  message: string;
}

/**
 * Is a column of dates dd/mm or mm/dd?
 *
 * ── THIS IS THE MOST DANGEROUS QUESTION IN THE WHOLE IMPORT ─────────────────
 *
 * §3 lists it under validation as "Date format ambiguity (dd/mm/yyyy vs
 * mm/dd/yyyy)" and it deserves its own detector. A file of Indian bank dates
 * read as American moves 05/09/2026 from 5 September to 9 May - four months -
 * and every figure derived from it (aging, days-to-collect, a period lock, a
 * GST return's month) is then wrong in a way no later check can catch, because
 * the result is a perfectly valid date.
 *
 * The only reliable evidence is a value whose first or second component
 * exceeds 12. One such value settles the whole column. So:
 *
 *   - any first component > 12            -> it must be dd/mm
 *   - any second component > 12           -> it must be mm/dd
 *   - both appear                         -> `conflict`; the column is not one
 *                                            format and nothing may be assumed
 *   - neither appears                     -> `ambiguous`; ASK
 *
 * `ambiguous` is not a failure to detect, it is the correct answer: a column of
 * twelve dates all under the 12th genuinely cannot be read either way, and the
 * person who exported it knows which it is.
 */
export function detectDateOrder(values: readonly (string | null)[]): DateOrderDetection {
  const parts: Array<{ raw: string; a: number; b: number }> = [];
  let isoCount = 0;
  let namedMonth = 0;

  for (const value of values) {
    if (value === null || value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    if (isCalendarDate(trimmed)) {
      isoCount += 1;
      continue;
    }
    if (/[A-Za-z]{3}/.test(trimmed) && looksLikeDate(trimmed)) {
      // "17 Sep 2026" names its month, so it carries no ambiguity at all.
      namedMonth += 1;
      continue;
    }
    const match = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/.exec(trimmed);
    if (!match) continue;
    const a = Number(match[1]);
    const b = Number(match[2]);
    // A 4-digit first component is yyyy/mm/dd, which is unambiguous.
    if (match[1].length === 4) {
      isoCount += 1;
      continue;
    }
    parts.push({ raw: trimmed, a, b });
  }

  if (parts.length === 0) {
    if (isoCount + namedMonth > 0) {
      return {
        order: "iso",
        evidence: [],
        message: "Every date in this column names its month unambiguously.",
      };
    }
    return { order: "ambiguous", evidence: [], message: "No dates were found in this column." };
  }

  const dayFirst = parts.filter((p) => p.a > 12);
  const monthFirst = parts.filter((p) => p.b > 12);

  if (dayFirst.length > 0 && monthFirst.length > 0) {
    return {
      order: "conflict",
      evidence: [dayFirst[0].raw, monthFirst[0].raw],
      message:
        `This column mixes date formats: ${dayFirst[0].raw} can only be day-first and ` +
        `${monthFirst[0].raw} can only be month-first. Fix the file before importing it.`,
    };
  }
  if (dayFirst.length > 0) {
    return {
      order: "dmy",
      evidence: dayFirst.slice(0, 3).map((p) => p.raw),
      message: `Read as day/month/year, because ${dayFirst[0].raw} has no other reading.`,
    };
  }
  if (monthFirst.length > 0) {
    return {
      order: "mdy",
      evidence: monthFirst.slice(0, 3).map((p) => p.raw),
      message: `Read as month/day/year, because ${monthFirst[0].raw} has no other reading.`,
    };
  }
  return {
    order: "ambiguous",
    evidence: parts.slice(0, 3).map((p) => p.raw),
    message:
      "Every date in this column could be read either way (no day is past the 12th). " +
      "Confirm whether these are day/month or month/day.",
  };
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * One date cell as `YYYY-MM-DD`, or null.
 *
 * `order` must be `iso`, `dmy` or `mdy` - a caller holding `ambiguous` has not
 * yet asked the person, and parsing anyway is the bug this module exists to
 * prevent. Passing `ambiguous` returns null for every two-number date rather
 * than quietly choosing, so the rows land in the error report instead of in
 * the database.
 */
export function parseDateCell(raw: string | null | undefined, order: DateOrder): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (isCalendarDate(value)) return value;

  // "17 Sep 2026", "17-Sep-26", "Sep 17, 2026" - the month is named, so the
  // order argument is irrelevant and these always parse.
  const named =
    /^(\d{1,2})[\s\-]*([A-Za-z]{3,9})[\s\-,]*(\d{2,4})$/.exec(value) ??
    (() => {
      const m = /^([A-Za-z]{3,9})[\s\-]+(\d{1,2}),?[\s\-]+(\d{2,4})$/.exec(value);
      return m ? ([m[0], m[2], m[1], m[3]] as unknown as RegExpExecArray) : null;
    })();
  if (named) {
    const month = MONTH_NAMES[named[2].toLowerCase()];
    if (month) return assemble(Number(named[1]), month, Number(named[3]));
    return null;
  }

  const match = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/.exec(value);
  if (!match) return null;
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];

  if (match[1].length === 4) return assemble(c, b, a);
  if (order === "dmy") return assemble(a, b, c);
  if (order === "mdy") return assemble(b, a, c);
  if (order === "iso") {
    // An ISO-declared column still has to cope with a stray dd/mm/yyyy. Only
    // accept it where it can only be read one way.
    if (a > 12) return assemble(a, b, c);
    if (b > 12) return assemble(b, a, c);
    return null;
  }
  return null;
}

function assemble(day: number, month: number, year: number): string | null {
  let y = year;
  // A two-digit year: 00-69 is this century, 70-99 the last. The same window
  // every spreadsheet uses, which matters because the alternative makes a
  // 1998-dated loan document arrive as 2098.
  if (year < 100) y = year < 70 ? 2000 + year : 1900 + year;
  if (y < 1900 || y > 2200) return null;
  const key = `${String(y).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isCalendarDate(key) ? key : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Amounts
// ─────────────────────────────────────────────────────────────────────────────

export interface AmountCell {
  /** Minor units (paise). Negative for a debit or a bracketed figure. */
  minor: number;
  /** What made it negative, where something did. */
  negativeBecause: "sign" | "brackets" | "debit_marker" | null;
  /** `Cr`/`Dr` as found, which a bank statement row needs kept. */
  marker: "cr" | "dr" | null;
}

/**
 * A money cell as minor units.
 *
 * ── EVERY SHAPE AN INDIAN STATEMENT ACTUALLY USES ───────────────────────────
 *
 *   1,02,500.50     Indian grouping (2,2,3), which `Number()` rejects outright
 *   102,500.50      Western grouping
 *   ₹ 1,02,500      a symbol, with or without a space
 *   (1,234.00)      brackets for negative, which accountants use everywhere
 *   1,234.00 Dr     a debit marker, which is how bank statements sign things
 *   1.02.500,50     European grouping, which arrives from some gateways
 *   -               a dash meaning nil, which Tally prints for a zero
 *
 * The parse deliberately goes through `toMinor`, which reads the digits as a
 * string: a float multiplication would make ₹1,02,500.55 into 10250054.999999
 * and this repo's money rule is that paise arithmetic never touches a double.
 */
export function parseAmountCell(
  raw: string | null | undefined,
  currency = "INR",
): AmountCell | null {
  if (raw === null || raw === undefined) return null;
  let value = String(raw).trim();
  if (value === "" || value === "-" || value === "–" || value === "—") return null;

  let negativeBecause: AmountCell["negativeBecause"] = null;
  let marker: AmountCell["marker"] = null;

  const markerMatch = /\b(cr|dr)\b\.?$/i.exec(value);
  if (markerMatch) {
    marker = markerMatch[1].toLowerCase() as "cr" | "dr";
    value = value.slice(0, markerMatch.index).trim();
  } else {
    const leading = /^(cr|dr)\b\.?/i.exec(value);
    if (leading) {
      marker = leading[1].toLowerCase() as "cr" | "dr";
      value = value.slice(leading[0].length).trim();
    }
  }

  if (/^\(.*\)$/.test(value)) {
    negativeBecause = "brackets";
    value = value.slice(1, -1).trim();
  }

  value = value.replace(/[₹$€£]/g, "").replace(/\s| /g, "");
  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("-")) {
    negativeBecause = negativeBecause ?? "sign";
    value = value.slice(1);
  }

  // European grouping: dots every three digits and a comma for the decimal.
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(value)) {
    value = value.replace(/\./g, "").replace(",", ".");
  } else {
    value = value.replace(/,/g, "");
  }

  if (!/^\d+(\.\d+)?$/.test(value)) return null;

  if (marker === "dr" && negativeBecause === null) negativeBecause = "debit_marker";

  let minor: number;
  try {
    minor = toMinor(value, currency);
  } catch {
    return null;
  }
  return { minor: negativeBecause ? -minor : minor, negativeBecause, marker };
}

// ─────────────────────────────────────────────────────────────────────────────
// Which kind of file is this?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a file turned out to be.
 *
 * The three `unsupported` kinds are deliberate. §3 asks detection to recognise
 * "sales/invoices, payments, expenses, leads, call logs, employees, ledger,
 * bank statement" - and this product can import six of those. Recognising a
 * call log and SAYING it is a call log that cannot be imported yet is worth
 * far more than failing to recognise it: the person learns the feature saw
 * their file correctly, and does not spend ten minutes mapping a payroll sheet
 * onto contact columns.
 */
export const DetectedKind = z.enum([
  "contact",
  "account",
  "deal",
  "payment",
  "expense",
  "bank_txn",
  // Recognised, not importable.
  "invoice",
  "ledger",
  "call_log",
  "employee",
  "unknown",
]);
export type DetectedKind = z.infer<typeof DetectedKind>;

export const IMPORTABLE_KINDS: readonly DetectedKind[] = [
  "contact",
  "account",
  "deal",
  "payment",
  "expense",
  "bank_txn",
];

export const UNSUPPORTED_KIND_MESSAGE: Partial<Record<DetectedKind, string>> = {
  invoice:
    "This looks like a list of invoices. Invoices are raised in the app rather than imported - " +
    "import the payments against them instead.",
  ledger:
    "This looks like a general ledger or trial balance. The ledger is built from payments and " +
    "expenses here, so import those and the ledger follows.",
  call_log: "This looks like a call log. Call records arrive from the handset app, not from a file.",
  employee:
    "This looks like an employee or payroll list. People are added under the organization chart, " +
    "not through this importer.",
};

/** Header words that point at a kind, with how much each is worth. */
const KIND_SIGNALS: Record<Exclude<DetectedKind, "unknown">, Array<[RegExp, number]>> = {
  payment: [
    [/\b(payment|paid|receipt|received)\b/i, 3],
    [/\b(utr|rrn|transaction\s*(id|ref)|txn\s*(id|no|ref))\b/i, 3],
    [/\b(mode|method)\b/i, 1],
    [/\b(amount|amt)\b/i, 1],
    [/\b(payment\s*date|paid\s*on|value\s*date)\b/i, 2],
  ],
  expense: [
    [/\b(expense|expenditure|spend|cost)\b/i, 3],
    [/\b(vendor|supplier|payee)\b/i, 2],
    [/\b(category|head|account\s*head)\b/i, 2],
    [/\b(bill\s*(no|number)|voucher)\b/i, 2],
    [/\b(gst|tax|cgst|sgst|igst)\b/i, 1],
  ],
  bank_txn: [
    [/\b(narration|particulars|description)\b/i, 3],
    [/\b(withdrawal|deposit|debit|credit)\b/i, 2],
    [/\b(balance|closing\s*balance)\b/i, 3],
    [/\b(cheque|chq)\b/i, 2],
    [/\b(value\s*date|txn\s*date|transaction\s*date)\b/i, 2],
  ],
  contact: [
    [/\b(first\s*name|last\s*name|full\s*name|contact\s*name)\b/i, 3],
    [/\b(mobile|phone|whatsapp)\b/i, 2],
    [/\b(email|e-?mail)\b/i, 2],
    [/\b(designation|title|job\s*title)\b/i, 1],
  ],
  account: [
    [/\b(company|organisation|organization|account\s*name|firm)\b/i, 3],
    [/\b(gstin|gst\s*no)\b/i, 2],
    [/\b(industry|sector)\b/i, 2],
    [/\b(website|domain)\b/i, 1],
  ],
  deal: [
    [/\b(deal|opportunity|pipeline)\b/i, 3],
    [/\b(stage|status)\b/i, 2],
    [/\b(value|deal\s*value|amount)\b/i, 1],
    [/\b(close\s*date|expected\s*close)\b/i, 2],
    [/\b(owner|assigned\s*to|telecaller)\b/i, 1],
  ],
  invoice: [
    [/\b(invoice\s*(no|number|date)|bill\s*to)\b/i, 3],
    [/\b(taxable\s*value|place\s*of\s*supply|hsn|sac)\b/i, 3],
    [/\b(irn|e-?invoice)\b/i, 3],
  ],
  ledger: [
    [/\b(ledger|trial\s*balance|voucher\s*type)\b/i, 3],
    [/\b(opening\s*balance|closing\s*balance)\b/i, 1],
    [/\b(debit|credit)\b/i, 1],
    [/\b(account\s*(code|head)|group)\b/i, 2],
  ],
  call_log: [
    [/\b(call\s*(id|type|duration|date|time)|recording)\b/i, 3],
    [/\b(disposition|outcome|talk\s*time)\b/i, 3],
    [/\b(caller|dialled|dialed|incoming|outgoing|missed)\b/i, 2],
  ],
  employee: [
    [/\b(employee\s*(id|code|name)|emp\s*(id|code))\b/i, 3],
    [/\b(salary|ctc|gross\s*pay|net\s*pay|basic)\b/i, 3],
    [/\b(pf|uan|esic|date\s*of\s*joining|doj)\b/i, 3],
    [/\b(department|designation)\b/i, 1],
  ],
};

export interface KindDetection {
  kind: DetectedKind;
  /** 0-1. The console confirms anything under ~0.6. */
  confidence: number;
  /** The headers that drove it, for the "why" line under the suggestion. */
  matchedHeaders: string[];
  importable: boolean;
  message: string | null;
  /** Runners-up, so the console's picker can pre-sort rather than alphabetise. */
  alternatives: Array<{ kind: DetectedKind; score: number }>;
}

/**
 * What kind of data is in this file?
 *
 * Scored on headers, with the content used only to break a tie: headers are
 * what a person wrote on purpose, and content coincidences are everywhere - a
 * column of amounts appears in six of these kinds.
 */
export function detectKind(
  headers: readonly string[],
  rows: readonly (readonly (string | null)[])[] = [],
): KindDetection {
  const scores: Array<{ kind: DetectedKind; score: number; matched: string[] }> = [];

  for (const [kind, signals] of Object.entries(KIND_SIGNALS) as Array<
    [Exclude<DetectedKind, "unknown">, Array<[RegExp, number]>]
  >) {
    let score = 0;
    const matched: string[] = [];
    for (const [pattern, weight] of signals) {
      const header = headers.find((h) => pattern.test(h));
      if (header) {
        score += weight;
        matched.push(header);
      }
    }
    if (score > 0) scores.push({ kind, score, matched });
  }

  // Content tie-breakers. Small weights: a column of IFSC codes is strong
  // evidence of a bank file, a column of GSTINs of an account list, but
  // neither should outvote a header that names the thing outright.
  if (rows.length > 0) {
    const columns = headers.map((_, i) => rows.map((r) => r[i] ?? null));
    const has = (kind: CellKind) => columns.some((col) => columnKindShare(col, kind) > 0.5);
    const bump = (kind: DetectedKind, by: number) => {
      const found = scores.find((s) => s.kind === kind);
      if (found) found.score += by;
    };
    if (has("ifsc")) bump("bank_txn", 1.5);
    if (has("gstin")) {
      bump("account", 1);
      bump("invoice", 1);
    }
    if (has("phone")) {
      bump("contact", 1);
      bump("call_log", 0.5);
    }
  }

  if (scores.length === 0) {
    return {
      kind: "unknown",
      confidence: 0,
      matchedHeaders: [],
      importable: false,
      message:
        "The column names in this file do not match anything recognisable. " +
        "Pick what it holds and map the columns by hand.",
      alternatives: [],
    };
  }

  scores.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
  const top = scores[0];
  const runnerUp = scores[1]?.score ?? 0;
  // Confidence is about the GAP, not the absolute score: eight points when the
  // second guess has seven is a coin toss, and eight when the second has one is
  // certainty. A file is one kind of thing, so the margin is the signal.
  const confidence = Math.max(0, Math.min(1, (top.score - runnerUp) / Math.max(4, top.score)));
  const importable = IMPORTABLE_KINDS.includes(top.kind);

  return {
    kind: top.kind,
    confidence,
    matchedHeaders: [...new Set(top.matched)],
    importable,
    message: importable ? null : (UNSUPPORTED_KIND_MESSAGE[top.kind] ?? null),
    alternatives: scores.slice(1, 4).map((s) => ({ kind: s.kind, score: s.score })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Known sources - §3's "saved mapping templates per source"
// ─────────────────────────────────────────────────────────────────────────────

export const ImportSource = z.enum([
  "aura_export",
  "razorpay_settlement",
  "tally_export",
  "gstr2b",
  "bank_statement",
  "generic",
]);
export type ImportSource = z.infer<typeof ImportSource>;

export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  aura_export: "An export from this app",
  razorpay_settlement: "Razorpay settlement report",
  tally_export: "Tally export",
  gstr2b: "GST portal download",
  bank_statement: "Bank statement",
  generic: "A spreadsheet of your own",
};

const SOURCE_SIGNALS: Array<[ImportSource, RegExp[]]> = [
  ["razorpay_settlement", [/\bsettlement\s*(id|utr)\b/i, /\brazorpay\b/i, /\bpayment_id\b/i]],
  ["gstr2b", [/\bgstr-?2b\b/i, /\bsupplier\s*gstin\b/i, /\bitc\s*available\b/i]],
  ["tally_export", [/\bvoucher\s*type\b/i, /\bparticulars\b.*\bvch\b/i, /\btally\b/i]],
  ["bank_statement", [/\bnarration\b/i, /\bwithdrawal\s*amt\b/i, /\bclosing\s*balance\b/i, /\bchq\.?\s*\/?\s*ref/i]],
  ["aura_export", [/\baura\b/i]],
];

/**
 * Which known export shape is this?
 *
 * Used to offer a saved mapping template straight away - §3's "After the first
 * import, a saved template makes later imports one click." Returns `generic`
 * rather than guessing, because offering the wrong bank's template is worse
 * than offering none.
 */
export function detectSource(headers: readonly string[], fileName = ""): ImportSource {
  const haystack = [...headers, fileName].join(" | ");
  for (const [source, patterns] of SOURCE_SIGNALS) {
    if (patterns.some((p) => p.test(haystack))) return source;
  }
  return "generic";
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency - §3's "hash each row or use a natural key"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The natural key for a row of each kind, in priority order.
 *
 * A reference number wins where there is one: a UTR, a settlement id or an
 * invoice number identifies a payment better than any combination of date and
 * amount, and two genuinely different ₹5,000 payments on the same day are
 * common while two rows with the same UTR are always the same payment.
 */
const NATURAL_KEYS: Partial<Record<DetectedKind, string[][]>> = {
  payment: [["reference"], ["externalId"], ["paidAt", "amount", "customer"]],
  expense: [["billNumber", "vendor"], ["spentOn", "amount", "vendor", "category"]],
  bank_txn: [["reference", "valueDate"], ["valueDate", "amount", "narration"]],
  contact: [["email"], ["phone"], ["displayName", "accountName"]],
  account: [["gstin"], ["name"]],
  deal: [["externalId"], ["name", "accountName"]],
};

/**
 * A stable, READABLE key for a row - not a hash.
 *
 * §3 offers "hash each row or use a natural key". This returns the key itself,
 * joined, and the database hashes it if it wants to. Two reasons: a hash
 * collision silently skips a real row, and - the one that matters in practice -
 * when somebody asks why a row was skipped as a duplicate, a key reading
 * `payment|utr|AXIS0098122` answers it and an MD5 does not.
 *
 * Null when the row has none of the key fields filled, which means it cannot
 * be de-duplicated and must be treated as new.
 */
export function rowFingerprint(
  kind: DetectedKind,
  row: Record<string, string | number | null | undefined>,
): string | null {
  const keySets = NATURAL_KEYS[kind];
  if (!keySets) return null;
  for (const fields of keySets) {
    const values = fields.map((f) => canonicalKeyPart(row[f]));
    if (values.every((v) => v !== null)) {
      return [kind, fields.join("+"), ...values].join("|");
    }
  }
  return null;
}

function canonicalKeyPart(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  return text === "" ? null : text;
}

export interface DuplicateReport {
  /** Row indexes (into the data rows) that repeat an earlier row's key. */
  duplicateRows: number[];
  /** Key -> every row index carrying it, for keys seen more than once. */
  groups: Record<string, number[]>;
  /** Rows with no usable natural key, which cannot be de-duplicated at all. */
  unkeyedRows: number[];
}

/**
 * §3's "Duplicate detection ... within the file".
 *
 * The FIRST occurrence is not reported - it is the row that will be imported,
 * and the later ones are the duplicates. Reporting all of them would make a
 * file with one accidental copy-paste look like two bad rows instead of one.
 */
export function findDuplicatesInFile(
  kind: DetectedKind,
  rows: ReadonlyArray<Record<string, string | number | null | undefined>>,
): DuplicateReport {
  const seen = new Map<string, number[]>();
  const unkeyedRows: number[] = [];

  rows.forEach((row, index) => {
    const key = rowFingerprint(kind, row);
    if (key === null) {
      unkeyedRows.push(index);
      return;
    }
    const list = seen.get(key);
    if (list) list.push(index);
    else seen.set(key, [index]);
  });

  const groups: Record<string, number[]> = {};
  const duplicateRows: number[] = [];
  for (const [key, indexes] of seen) {
    if (indexes.length < 2) continue;
    groups[key] = indexes;
    duplicateRows.push(...indexes.slice(1));
  }
  return { duplicateRows: duplicateRows.sort((a, b) => a - b), groups, unkeyedRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// How a run is applied
// ─────────────────────────────────────────────────────────────────────────────

/** §3 step 7: "create only, update existing ..., or upsert". */
export const ImportMode = z.enum(["create", "update", "upsert"]);
export type ImportMode = z.infer<typeof ImportMode>;

export const IMPORT_MODE_LABELS: Record<ImportMode, string> = {
  create: "Create new records only",
  update: "Update existing records only",
  upsert: "Create new and update existing",
};

/** §3 step 8's dry run: "120 new, 15 updates, 4 skipped, 6 errors". */
export interface DryRunSummary {
  newRows: number;
  updateRows: number;
  skippedRows: number;
  errorRows: number;
  duplicateRows: number;
  totalRows: number;
}

export function describeDryRun(summary: DryRunSummary): string {
  const parts = [
    `${summary.newRows} new`,
    `${summary.updateRows} update${summary.updateRows === 1 ? "" : "s"}`,
    `${summary.skippedRows} skipped`,
    `${summary.errorRows} error${summary.errorRows === 1 ? "" : "s"}`,
  ];
  return parts.join(", ");
}

/** Nothing to apply: every row is an error, a skip, or there are none at all. */
export function dryRunIsEmpty(summary: DryRunSummary): boolean {
  return summary.newRows === 0 && summary.updateRows === 0;
}
