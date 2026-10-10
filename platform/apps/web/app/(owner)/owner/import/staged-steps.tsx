"use client";

import { Button } from "@aura/ui";
import { describeDryRun, type DateOrderDetection, type DryRunSummary } from "@aura/shared";

/**
 * The two steps a finance import adds to the wizard
 * (Build docs/indian-business-finance-documents-cycles-import §3 steps 6-9).
 *
 * In their own file because `import-client.tsx` is already a thousand lines and
 * these two are self-contained: they take a verdict and a summary and render
 * them, with no state of their own.
 */

export type ResolvedDateOrder = "iso" | "dmy" | "mdy";

export interface StagedResult {
  jobId: string;
  summary: DryRunSummary;
  dedupeWarning: string | null;
  sampleErrors: Array<{ sourceRowNumber: number; status: string; error: string | null }>;
}

/**
 * §3 step 6's date-format question, asked only when the file cannot answer it.
 *
 * ── WHY THIS DESERVES A WHOLE STEP ──────────────────────────────────────────
 *
 * It is the one ambiguity in a finance import that cannot be detected from the
 * data and cannot be corrected afterwards. A file of Indian dates read as
 * American moves 05/09/2026 from 5 September to 9 May - four months - and
 * every figure derived from it is then wrong in a way no later check can
 * catch, because the result is a perfectly valid date.
 *
 * `detectDateOrder` settles it from the file wherever one value has a day past
 * the 12th, and then this step says so and asks nothing. A person is only
 * asked for a column where EVERY day is under the 13th, which is the case
 * where asking is the only correct behaviour.
 */
export function DateOrderStep({
  detection,
  value,
  onChange,
  onBack,
  onNext,
  busy,
}: {
  detection: { header: string; verdict: DateOrderDetection } | null;
  value: ResolvedDateOrder | null;
  onChange: (value: ResolvedDateOrder) => void;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
}) {
  const verdict = detection?.verdict;
  const settled =
    verdict && (verdict.order === "iso" || verdict.order === "dmy" || verdict.order === "mdy");
  const conflict = verdict?.order === "conflict";

  return (
    <div>
      <h3 className="text-lg font-semibold text-text">How should the dates be read?</h3>
      <p className="mt-1 text-sm text-text-muted">
        {detection
          ? `From the "${detection.header}" column.`
          : "No date column is mapped, so there is nothing to confirm."}
      </p>

      {verdict ? (
        <div className="mt-4 rounded-md border border-border p-4">
          <p className="text-sm text-text-muted">{verdict.message}</p>
          {verdict.evidence.length > 0 ? (
            <p className="mt-2 text-xs text-text-subtle">
              Values seen: {verdict.evidence.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {conflict ? (
        <p className="mt-4 text-sm text-text">
          This file cannot be imported as it is - two rows disagree about the format, so some of
          its dates would be wrong whichever reading is chosen. Fix the file and upload it again.
        </p>
      ) : settled ? (
        <p className="mt-4 text-sm text-text-muted">
          Nothing to confirm - the file settles this by itself.
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {(
            [
              ["dmy", "Day first", "05/09/2026 is 5 September 2026. Usual in India."],
              ["mdy", "Month first", "05/09/2026 is 9 May 2026. Usual in the US."],
            ] as const
          ).map(([key, label, hint]) => (
            <label
              key={key}
              className={
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 " +
                (value === key
                  ? "border-accent bg-surface-hover"
                  : "border-border hover:bg-surface-hover")
              }
            >
              <input
                type="radio"
                name="date-order"
                className="mt-1"
                checked={value === key}
                onChange={() => onChange(key)}
              />
              <span>
                <span className="block text-sm font-medium text-text">{label}</span>
                <span className="block text-xs text-text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button onClick={onNext} disabled={busy || conflict || !value}>
          {busy ? "Checking the rows…" : "Check the rows"}
        </Button>
      </div>
    </div>
  );
}

/**
 * §3 step 8's dry run: "120 new, 15 updates, 4 skipped, 6 errors".
 *
 * ── NOTHING HAS BEEN WRITTEN WHILE THIS IS ON SCREEN ────────────────────────
 *
 * The rows are in `import_staging_rows` and no real table has been touched.
 * That gap is the point of the whole staged flow - §3's "a person should
 * approve it once" - and it is why Back here DISCARDS the staged job rather
 * than merely navigating: an abandoned staged job is invisible debt that the
 * next import of the same file would not collide with.
 */
export function PreviewStep({
  staged,
  isExpense,
  onBack,
  onCommit,
  busy,
}: {
  staged: StagedResult;
  isExpense: boolean;
  onBack: () => void;
  onCommit: () => void;
  busy: boolean;
}) {
  const { summary } = staged;
  const nothingToDo = summary.newRows === 0 && summary.updateRows === 0;

  return (
    <div>
      <h3 className="text-lg font-semibold text-text">Check before importing</h3>
      <p className="mt-1 text-sm text-text-muted">
        Nothing has been saved yet. {describeDryRun(summary)}.
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ["To import", summary.newRows],
            ["Duplicates skipped", summary.duplicateRows],
            ["Rows with errors", summary.errorRows],
            ["Rows in the file", summary.totalRows],
          ] as const
        ).map(([label, count]) => (
          <div key={label} className="rounded-md border border-border p-3">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-text">{count}</dd>
          </div>
        ))}
      </dl>

      {staged.dedupeWarning ? (
        <p className="mt-4 rounded-md border border-border p-3 text-sm text-text-muted">
          {staged.dedupeWarning}
        </p>
      ) : null}

      {isExpense && summary.newRows > 0 ? (
        <p className="mt-4 rounded-md border border-border p-3 text-sm text-text-muted">
          Imported expenses arrive <strong className="text-text">waiting for approval</strong>, so
          they are not in any cost figure until somebody approves them. That is deliberate: an
          import that approved its own rows would let anybody with import rights move the margin on
          the owner&apos;s dashboard by uploading a spreadsheet.
        </p>
      ) : null}

      {staged.sampleErrors.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-sm font-medium text-text">
            The first {staged.sampleErrors.length} problem
            {staged.sampleErrors.length === 1 ? "" : "s"}
          </h4>
          <ul className="mt-2 space-y-1 text-xs text-text-muted">
            {staged.sampleErrors.map((row) => (
              <li key={row.sourceRowNumber}>
                <span className="tabular-nums text-text">Row {row.sourceRowNumber}</span> —{" "}
                {row.error ?? row.status}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-subtle">
            Rows with errors are left out of the import. The row numbers are the lines of your own
            file, so you can correct those and upload only them.
          </p>
        </div>
      ) : null}

      <div className="mt-6 flex items-center gap-3">
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button onClick={onCommit} disabled={busy || nothingToDo}>
          {busy
            ? "Importing…"
            : nothingToDo
              ? "Nothing to import"
              : `Import ${summary.newRows} row${summary.newRows === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}
