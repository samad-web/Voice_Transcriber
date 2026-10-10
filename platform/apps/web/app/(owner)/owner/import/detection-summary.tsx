"use client";

import {
  IMPORT_ENTITY_LABELS,
  IMPORT_SOURCE_LABELS,
  UNSUPPORTED_KIND_MESSAGE,
  type ImportEntity,
  type ImportSource,
  type KindDetection,
} from "@aura/shared";

/**
 * What §3's detect step worked out, shown rather than applied in silence.
 *
 * ── THE WHOLE REASON THIS COMPONENT EXISTS ──────────────────────────────────
 *
 * §3's opening paragraph: "'Automatically' works best as detect, suggest and
 * confirm, not silent import. Finance data wrongly imported is hard to unwind,
 * so auto-detection should do the work and a person should approve it once."
 *
 * Three of the four things on this card are decisions the importer has already
 * taken on the person's behalf - which row the headers are on, what kind of
 * data this is, and which rows were dropped. A person who cannot see those
 * cannot approve them, and the first time they find out the header row was
 * wrong is when 400 rows land under a column called "HDFC BANK LTD".
 */
export interface Detection {
  headerRow: number | null;
  headerReason: string;
  headerConfidence: number;
  skippedBlank: number;
  skippedTotals: number;
  sourceRowNumbers: number[];
  kind: KindDetection;
  fileSource: ImportSource;
  fileName: string | null;
  sheetName: string | null;
  /** How many sheets the workbook had. >1 means one was chosen for them. */
  sheetCount: number;
}

export function DetectionSummary({
  detection,
  rowCount,
}: {
  detection: Detection;
  rowCount: number;
}) {
  const { kind } = detection;
  const dropped = detection.skippedBlank + detection.skippedTotals;
  // Only worth naming when the detector is reasonably sure AND the kind is one
  // this product can import. A low-confidence guess presented as a finding is
  // worse than no finding.
  const namedKind =
    kind.kind !== "unknown" && kind.confidence >= 0.3
      ? kind.importable
        ? IMPORT_ENTITY_LABELS[kind.kind as ImportEntity]
        : null
      : null;
  const unsupported = !kind.importable && kind.kind !== "unknown" ? UNSUPPORTED_KIND_MESSAGE[kind.kind] : null;

  return (
    <div className="mt-4 rounded-md border border-border p-4">
      <h4 className="text-sm font-medium text-text">What we found in that file</h4>
      <ul className="mt-2 space-y-1 text-xs text-text-muted">
        <li>
          <strong className="text-text">{rowCount.toLocaleString()}</strong> data row
          {rowCount === 1 ? "" : "s"}
          {detection.sheetName ? ` on the "${detection.sheetName}" sheet` : ""}.
        </li>
        {/* A workbook with several sheets had one picked for the person. Saying
            which, and that there were others, is the difference between an
            import of the wrong tab and a question they can answer. */}
        {detection.sheetCount > 1 ? (
          <li>
            That workbook has {detection.sheetCount} sheets - the first one with data in it was
            read. Delete the others, or re-save just the one you want, if that is wrong.
          </li>
        ) : null}
        <li>{detection.headerReason}</li>
        {dropped > 0 ? (
          <li>
            Skipped {detection.skippedBlank > 0 ? `${detection.skippedBlank} blank` : ""}
            {detection.skippedBlank > 0 && detection.skippedTotals > 0 ? " and " : ""}
            {detection.skippedTotals > 0 ? `${detection.skippedTotals} total` : ""} row
            {dropped === 1 ? "" : "s"}.
          </li>
        ) : null}
        {detection.fileSource !== "generic" ? (
          <li>Looks like {IMPORT_SOURCE_LABELS[detection.fileSource].toLowerCase()}.</li>
        ) : null}
        {namedKind ? (
          <li>
            The columns look like <strong className="text-text">{namedKind.toLowerCase()}</strong>
            {kind.matchedHeaders.length > 0
              ? ` (from "${kind.matchedHeaders.slice(0, 3).join('", "')}")`
              : ""}
            .
          </li>
        ) : null}
      </ul>

      {/* The one case worth interrupting for: the file is recognisable and is
          something this product does not import. Saying so saves ten minutes
          of mapping a payroll sheet onto contact columns. */}
      {unsupported ? (
        <p className="mt-3 text-xs text-text">
          <strong>{unsupported}</strong>
        </p>
      ) : null}
    </div>
  );
}
