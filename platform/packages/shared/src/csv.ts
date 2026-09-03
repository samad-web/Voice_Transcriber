/**
 * Minimal RFC-4180 CSV rendering.
 *
 * Hand-rolled rather than pulled in: the whole surface is "quote a cell, join
 * with commas", and the one part that actually needs care - formula injection
 * - is not something a generic CSV library handles for you anyway.
 *
 * ── WHY THIS IS IN @aura/shared AND NOT IN apps/api ───────────────────────
 *
 * It started in `apps/api/src/modules/reports/csv.ts`, which is still where
 * every server-side export calls it from. It moved here when the import
 * wizard started generating a blank TEMPLATE in the browser: that file is a
 * CSV the console writes without the API ever seeing it, and the alternative
 * was a second escaper in the web app. Two CSV encoders in one product is how
 * you end up with an export that quotes correctly and a template that does
 * not - and the template is the one a customer edits and hands back to us.
 */

/**
 * Neutralise a cell that a spreadsheet would execute rather than display.
 *
 * Excel, LibreOffice and Sheets all treat a leading `=`, `+`, `-`, `@`, tab or
 * CR as the start of a FORMULA. A contact called `=cmd|'/c calc'!A0` - which a
 * tenant can create, since display names come from call transcripts and from
 * the contacts API - becomes code the moment somebody opens the export. The
 * standard mitigation is a leading apostrophe, which spreadsheets strip on
 * display and which keeps the value readable.
 *
 * This matters more here than in most exports: these files are generated from
 * one tenant's data and opened on an operator's machine.
 */
function neutralize(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** One cell, escaped and formula-neutralised. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  const safe = neutralize(raw);
  // Quote when the value contains anything that would otherwise break the
  // row; double any embedded quote, per RFC 4180.
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(columns: Array<CsvColumn<T>>, rows: T[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row))).join(","));
  }
  // CRLF and a trailing newline: what Excel expects, and what makes the last
  // row survive a naive line-splitting reader.
  return `${lines.join("\r\n")}\r\n`;
}

/** Render already-positional rows - the template writer's shape, where the
 *  header list and each row are just parallel arrays of literals. */
export function toCsvGrid(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * The byte-order mark Excel needs to read a CSV as UTF-8.
 *
 * Without it, Excel on Windows decodes the file in the local ANSI codepage
 * and a Tamil or Devanagari name arrives as mojibake - which matters here
 * because that is exactly what this product's contacts are called. Papa Parse
 * strips a leading BOM when the file comes back, so it costs nothing on the
 * round trip; anything else that reads these files should do the same.
 */
export const CSV_BOM = "\uFEFF";
