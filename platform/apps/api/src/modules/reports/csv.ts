/**
 * Minimal RFC-4180 CSV rendering for report exports.
 *
 * Hand-rolled rather than pulled in: the whole surface is "quote a cell, join
 * with commas", and the one part that actually needs care — formula injection
 * — is not something a generic CSV library handles for you anyway.
 */

/**
 * Neutralise a cell that a spreadsheet would execute rather than display.
 *
 * Excel, LibreOffice and Sheets all treat a leading `=`, `+`, `-`, `@`, tab or
 * CR as the start of a FORMULA. A contact called `=cmd|'/c calc'!A0` — which a
 * tenant can create, since display names come from call transcripts and from
 * the contacts API — becomes code the moment somebody opens the export. The
 * standard mitigation is a leading apostrophe, which spreadsheets strip on
 * display and which keeps the value readable.
 *
 * This matters more here than in most exports: these files are generated from
 * one tenant's data and opened on an operator's machine.
 */
function neutralize(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cell(value: unknown): string {
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
  const lines = [columns.map((c) => cell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(c.value(row))).join(","));
  }
  // CRLF and a trailing newline: what Excel expects, and what makes the last
  // row survive a naive line-splitting reader.
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * A filename that cannot escape the Content-Disposition header.
 *
 * The report name reaches this from a path parameter; a quote or newline in
 * it would otherwise let a caller inject header content.
 */
export function safeFilename(base: string): string {
  return base.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "report";
}
