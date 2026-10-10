/**
 * A minimal, read-only .xlsx reader
 * (Build docs/indian-business-finance-documents-cycles-import §3).
 *
 * ── WHY THIS IS HAND-ROLLED, WHICH NEEDS JUSTIFYING ─────────────────────────
 *
 * §3 suggests "SheetJS or ExcelJS". Neither was taken:
 *
 *   SheetJS stopped publishing to npm at 0.18.5, and that version carries two
 *   advisories that are fixed only in releases distributed from the vendor's
 *   own CDN - a prototype-pollution issue and a ReDoS. Installing it would put
 *   a knowingly vulnerable parser in front of files that arrive from a
 *   tenant's accountant, which is the last place in this product to accept a
 *   known hole.
 *
 *   ExcelJS is maintained and would work, but it is a write-capable workbook
 *   model: around a megabyte into the console bundle, for a feature whose
 *   whole requirement is "read the cells of a sheet". The import wizard runs
 *   in the BROWSER (see below), so that cost is paid by every person who opens
 *   the page, not by a server.
 *
 * What is actually needed is small and stable: a ZIP has a central directory,
 * a sheet is XML, and `DecompressionStream("deflate-raw")` has been in every
 * browser and in Node since well before this repo's floor. The whole format
 * surface used here is four files inside the archive. So this is ~300 lines
 * with no dependency and no CVE surface, and it is tested against archives
 * built byte-by-byte in `xlsx-read.test.ts`.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not EVALUATE anything. A cell holding `=SUM(A1:A9)` yields the
 * cached value the writing application stored, never a computed one, and a
 * formula with no cached value yields null. §3's "no formula execution" is
 * free here because there is no evaluator to disable.
 *
 * It does not read legacy .xls (the pre-2007 binary BIFF format), which is a
 * different format altogether rather than a variation of this one. `readXlsx`
 * says so by name when handed one, because "unsupported file" sends somebody
 * looking for a bug and "re-save this as .xlsx" is a ten-second fix.
 *
 * It does not handle ZIP64, encryption or multi-disk archives, and says which
 * of those it found rather than returning half a sheet.
 */

/** One cell, as read. Positional - `null` where the sheet had no cell. */
export type XlsxCell = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  /** Row-major, ragged. Trailing empty rows and columns are trimmed. */
  rows: XlsxCell[][];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

export class XlsxError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP
// ─────────────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  /** Offset of the local file header. */
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;

/**
 * Find the end-of-central-directory record.
 *
 * Scanned BACKWARDS from the end, because the record is last and its only
 * fixed landmark is a signature that can also appear inside compressed data.
 * Searching forwards would find a false positive in any archive whose content
 * happens to contain those four bytes - which is why every ZIP reader scans
 * from the tail.
 */
function findEocd(view: DataView): number {
  // The record is 22 bytes plus a comment of at most 65535.
  const minOffset = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= minOffset; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new XlsxError("That file is not a valid .xlsx workbook (no ZIP directory was found).");
}

function readEntries(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buffer);
  const eocd = findEocd(view);

  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_EOCD_LOCATOR) {
    throw new XlsxError("That workbook uses the ZIP64 format, which this importer cannot read. Save it again as .xlsx.");
  }

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new XlsxError("That .xlsx file appears to be truncated or corrupt.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));

    // Bit 0 is the encryption flag. An encrypted workbook decompresses to
    // noise, so this has to be refused rather than parsed into gibberish.
    if (flags & 0x1) {
      throw new XlsxError("That workbook is password-protected. Remove the password and upload it again.");
    }

    entries.set(name, { name, method, offset: localOffset, compressedSize, uncompressedSize, flags });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function readFile(buffer: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const view = new DataView(buffer);
  if (view.getUint32(entry.offset, true) !== LOCAL_SIGNATURE) {
    throw new XlsxError("That .xlsx file appears to be corrupt.");
  }
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const raw = new Uint8Array(buffer, start, entry.compressedSize);

  if (entry.method === 0) return new TextDecoder().decode(raw);
  if (entry.method === 8) return new TextDecoder().decode(await inflate(raw));
  throw new XlsxError(`That workbook uses an unsupported compression method (${entry.method}).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// XML
//
// Regex rather than a DOM parser, and that is a defensible choice for exactly
// this input: the four files read here are machine-generated by spreadsheet
// applications, have no mixed content and no namespacing worth resolving, and
// the alternative in a browser (`DOMParser`) is not available in a Node test
// and would pull in a parser dependency to replace it.
//
// The one thing a regex MUST still get right is entity decoding, because a
// customer called "Shah & Sons" arrives as `Shah &amp; Sons` and a value
// written back un-decoded would corrupt the record. `decodeXml` below is
// therefore applied to every text node, not just to the ones that looked
// suspicious.
// ─────────────────────────────────────────────────────────────────────────────

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = entity.startsWith("#x") || entity.startsWith("#X")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
    }
  });
}

/** Every `<t>` run inside a fragment, concatenated. Rich text is many runs. */
function textRuns(fragment: string): string {
  const out: string[] = [];
  for (const match of fragment.matchAll(/<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    out.push(decodeXml(match[1] ?? ""));
  }
  return out.join("");
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The built-in number formats that mean "this number is a date".
 *
 * A date in a spreadsheet is just a number; only its FORMAT says it is a date.
 * Ignoring the format is how an import turns 17 September 2026 into the integer
 * 46277, which then validates fine as an amount and lands in the database.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(formatId: number | null, formatCode: string | null): boolean {
  if (formatId !== null && BUILTIN_DATE_FORMATS.has(formatId)) return true;
  if (!formatCode) return false;
  // Strip the pieces of a format string that can contain date-ish letters
  // without being dates: quoted literals, bracketed conditions and colours,
  // and escaped characters. What is left is the real format.
  const bare = formatCode
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[dmyhs]/i.test(bare) && !/^[#0?,.%\s]*$/.test(bare);
}

/**
 * A spreadsheet date serial as `YYYY-MM-DD`, or null.
 *
 * ── THE 1900 LEAP-YEAR BUG IS LOAD-BEARING ──────────────────────────────────
 *
 * Excel believes 1900 was a leap year, so serial 60 is an imaginary
 * 29 February 1900 and every serial after it is one greater than the true day
 * count. Every spreadsheet application reproduces the bug for compatibility,
 * so a reader must reproduce it too - and it cannot be done with one epoch,
 * which is the part that is easy to get wrong:
 *
 *   serial 1  is 1 January 1900  -> epoch 31 December 1899
 *   serial 61 is 1 March 1900    -> epoch 30 December 1899
 *
 * One epoch for both is off by a day on one side or the other. Serial 60 has
 * no real date at all and returns null rather than silently becoming
 * 28 February or 1 March.
 *
 * Nothing in this product has data from 1900, so the practical effect of the
 * branch is nil - but a reader that is wrong by a day somewhere is a reader
 * nobody can reason about, and the correction costs one comparison.
 */
export function serialToDateKey(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const whole = Math.floor(serial);
  if (whole === 60) return null;
  const epoch = whole < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const ms = epoch + whole * 86_400_000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell references
// ─────────────────────────────────────────────────────────────────────────────

/** "A" -> 0, "Z" -> 25, "AA" -> 26. Null for anything else. */
export function columnIndex(letters: string): number | null {
  if (!/^[A-Z]+$/.test(letters)) return null;
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** "B7" -> { col: 1, row: 6 }. Null when the reference is unreadable. */
export function parseCellRef(ref: string): { col: number; row: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  const col = columnIndex(match[1]);
  const row = Number(match[2]) - 1;
  return col === null || row < 0 ? null : { col, row };
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader
// ─────────────────────────────────────────────────────────────────────────────

/** Guards against a sheet whose dimension claims a million columns. */
const MAX_COLUMNS = 512;
const MAX_ROWS = 100_000;

export interface ReadXlsxOptions {
  /** Stop after this many rows per sheet. The console passes its own cap. */
  maxRows?: number;
}

/**
 * Read every sheet of a .xlsx workbook.
 *
 * Dates come back as `YYYY-MM-DD` strings rather than Date objects, for the
 * reason `fiscal.ts` gives: a Date built from a spreadsheet serial is a UTC
 * instant, and formatting it in the viewer's local zone moves it a day for
 * everybody east of Greenwich. A date cell in a spreadsheet has no time zone,
 * so a date string is the honest representation of it.
 */
export async function readXlsx(buffer: ArrayBuffer, options: ReadXlsxOptions = {}): Promise<XlsxWorkbook> {
  const maxRows = Math.min(options.maxRows ?? MAX_ROWS, MAX_ROWS);
  const bytes = new Uint8Array(buffer);

  // .xls (BIFF) starts with the OLE compound-file signature; .xlsx is a ZIP.
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new XlsxError(
      "That is an older .xls workbook. Open it and use Save As to make it an .xlsx file, then upload that.",
    );
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new XlsxError("That file is not an .xlsx workbook.");
  }

  const entries = readEntries(buffer);

  const workbookEntry = entries.get("xl/workbook.xml");
  if (!workbookEntry) throw new XlsxError("That .xlsx file has no workbook inside it.");
  const workbookXml = await readFile(buffer, workbookEntry);

  const relsEntry = entries.get("xl/_rels/workbook.xml.rels");
  const relTargets = new Map<string, string>();
  if (relsEntry) {
    const relsXml = await readFile(buffer, relsEntry);
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      const id = attr(match[0], "Id");
      const target = attr(match[0], "Target");
      if (id && target) relTargets.set(id, target);
    }
  }

  const sharedStrings = await readSharedStrings(buffer, entries);
  const styleIsDate = await readStyles(buffer, entries);

  const sheets: XlsxSheet[] = [];
  let positional = 0;
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    positional += 1;
    const name = attr(match[0], "name") ?? `Sheet${positional}`;
    const relId = attr(match[0], "r:id") ?? attr(match[0], "id");
    const target = relId ? relTargets.get(relId) : null;
    const path = target
      ? `xl/${target.replace(/^\/?xl\//, "").replace(/^\//, "")}`
      : `xl/worksheets/sheet${positional}.xml`;
    const sheetEntry = entries.get(path) ?? entries.get(`xl/worksheets/sheet${positional}.xml`);
    // A workbook can reference an external or a chart sheet that has no
    // worksheet part. Skipping it is right; failing the whole file is not.
    if (!sheetEntry) continue;
    const xml = await readFile(buffer, sheetEntry);
    sheets.push({ name, rows: parseSheet(xml, sharedStrings, styleIsDate, maxRows) });
  }

  if (sheets.length === 0) throw new XlsxError("That workbook has no readable sheets.");
  return { sheets };
}

async function readSharedStrings(buffer: ArrayBuffer, entries: Map<string, ZipEntry>): Promise<string[]> {
  const entry = entries.get("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = await readFile(buffer, entry);
  const out: string[] = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    out.push(textRuns(match[1] ?? ""));
  }
  return out;
}

/** Index by `s` attribute -> whether that style formats its number as a date. */
async function readStyles(buffer: ArrayBuffer, entries: Map<string, ZipEntry>): Promise<boolean[]> {
  const entry = entries.get("xl/styles.xml");
  if (!entry) return [];
  const xml = await readFile(buffer, entry);

  const customFormats = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const id = Number(attr(match[0], "numFmtId"));
    const code = attr(match[0], "formatCode");
    if (Number.isFinite(id) && code !== null) customFormats.set(id, code);
  }

  // Only `cellXfs` matters - `cellStyleXfs` is the named-style table a cellXf
  // may inherit from, and reading both as one list shifts every index.
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfs) return [];
  const out: boolean[] = [];
  for (const match of cellXfs[1].matchAll(/<xf\b[^>]*\/?>/g)) {
    const raw = attr(match[0], "numFmtId");
    const id = raw === null ? null : Number(raw);
    out.push(isDateFormat(id, id === null ? null : (customFormats.get(id) ?? null)));
  }
  return out;
}

function parseSheet(
  xml: string,
  sharedStrings: string[],
  styleIsDate: boolean[],
  maxRows: number,
): XlsxCell[][] {
  const rows: XlsxCell[][] = [];
  let widest = 0;

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowAttrs = rowMatch[1] ?? "";
    const body = rowMatch[2] ?? "";
    const declared = attr(`<row${rowAttrs}>`, "r");
    // Honour `r`, so a sheet that skips blank rows does not shift everything
    // below the gap up by however many rows it skipped.
    const rowIndex = declared ? Number(declared) - 1 : rows.length;
    if (!Number.isFinite(rowIndex) || rowIndex < 0 || rowIndex >= maxRows) continue;

    const cells: XlsxCell[] = [];
    let nextCol = 0;
    for (const cellMatch of body.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttrs = `<c${cellMatch[1] ?? ""}>`;
      const inner = cellMatch[2] ?? "";
      const ref = attr(cellAttrs, "r");
      const parsed = ref ? parseCellRef(ref) : null;
      const col = parsed ? parsed.col : nextCol;
      if (col >= MAX_COLUMNS) continue;
      nextCol = col + 1;

      const type = attr(cellAttrs, "t");
      const styleRaw = attr(cellAttrs, "s");
      const styleIndex = styleRaw === null ? null : Number(styleRaw);
      while (cells.length < col) cells.push(null);
      cells[col] = readCell(type, inner, styleIndex, sharedStrings, styleIsDate);
    }

    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
    widest = Math.max(widest, cells.length);
  }

  // Trim trailing all-empty rows: a sheet somebody has scrolled through often
  // carries a thousand styled-but-empty rows, and importing them as blanks
  // turns a 40-row file into a 1,040-row one with 1,000 errors.
  while (rows.length > 0 && rows[rows.length - 1].every(isBlank)) rows.pop();
  // Pad to a rectangle so a consumer can index by column without bounds checks.
  for (const row of rows) while (row.length < widest) row.push(null);
  return rows;
}

function readCell(
  type: string | null,
  inner: string,
  styleIndex: number | null,
  sharedStrings: string[],
  styleIsDate: boolean[],
): XlsxCell {
  switch (type) {
    case "s": {
      const index = Number(firstTag(inner, "v") ?? "");
      return Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : null;
    }
    case "inlineStr":
      return textRuns(inner) || null;
    case "str":
      // A formula's cached STRING result. The formula itself is in `<f>` and is
      // ignored - see this file's header on not evaluating anything.
      return decodeXml(firstTag(inner, "v") ?? "") || null;
    case "b":
      return firstTag(inner, "v") === "1";
    case "e":
      // `#REF!`, `#DIV/0!`. Returned as the error text rather than as null, so
      // validation can tell "the sheet has a broken formula here" from "this
      // cell is empty" - which are different conversations with the uploader.
      return firstTag(inner, "v") ?? null;
    default: {
      const raw = firstTag(inner, "v");
      if (raw === null || raw === "") return null;
      const value = Number(raw);
      if (!Number.isFinite(value)) return decodeXml(raw);
      if (styleIndex !== null && styleIsDate[styleIndex]) {
        return serialToDateKey(value) ?? value;
      }
      return value;
    }
  }
}

function firstTag(fragment: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`).exec(fragment);
  return match ? (match[1] ?? "") : null;
}

function isBlank(cell: XlsxCell): boolean {
  return cell === null || cell === "";
}

/**
 * Every sheet as a grid of strings, which is what the mapping step consumes.
 *
 * Numbers are stringified with no thousands separator and no currency symbol,
 * because the next step parses them with `toMinor` and a formatted number
 * would have to be un-formatted first. A date already came back as a date key.
 */
export function sheetToGrid(sheet: XlsxSheet): string[][] {
  return sheet.rows.map((row) =>
    row.map((cell) => {
      if (cell === null) return "";
      if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
      return String(cell);
    }),
  );
}
