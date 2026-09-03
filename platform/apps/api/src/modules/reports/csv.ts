/**
 * CSV rendering for report and import exports.
 *
 * The encoder itself lives in `@aura/shared` (packages/shared/src/csv.ts) so
 * the browser-side import TEMPLATE and these server-side exports quote,
 * escape and formula-neutralise identically - see that file's header for why
 * a second copy would be a bug waiting to happen. This module stays as the
 * import site every API controller already uses, and adds the one helper that
 * is about HTTP rather than CSV.
 */

export { toCsv, csvCell, toCsvGrid, CSV_BOM, type CsvColumn } from "@aura/shared";

/**
 * A filename that cannot escape the Content-Disposition header.
 *
 * The report name reaches this from a path parameter; a quote or newline in
 * it would otherwise let a caller inject header content.
 */
export function safeFilename(base: string): string {
  return base.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "report";
}
