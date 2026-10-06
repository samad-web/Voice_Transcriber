"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { Button, Card, Checkbox, DropZone, ErrorBanner, FormField, Select } from "@aura/ui";
import { inputClass } from "@/lib/form";
import { addDncEntriesAction, type DncList } from "./actions";
import {
  EMPTY_TALLY,
  MAX_CELL_CHARS,
  TOO_LONG_REASON,
  UPLOAD_CHUNK,
  addLocalRefusals,
  mergeChunk,
  type UploadTally,
} from "./upload-summary";

/**
 * Putting numbers into one list - pasted, or off a sheet.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * It does not decide what a phone number is. `importPhone` does, server-side,
 * against the workspace's own country, and it is the same function the contact
 * importer uses - which is the point: a DNC entry that keys differently from
 * the vault's row for the same customer is not weak suppression, it is NO
 * suppression with a convincing count beside it. So this component posts the
 * cells as typed and renders what came back.
 *
 * The one thing it does refuse by itself is a cell over `MAX_CELL_CHARS`, and
 * only because the route's body schema would 400 the whole chunk over it - see
 * upload-summary.ts. Those are reported as refusals like any other, never
 * dropped.
 *
 * ── AND WHY THE REFUSALS GET MORE ROOM THAN THE SUCCESSES ───────────────────
 *
 * Because a silently skipped row is a number somebody will later be rung on.
 * The counts are a line; the reasons are a list, grouped, quoted, and in the
 * console's error tone - which is ORANGE. Red means MISSED here.
 */

/** A cell on its way to the API, and where in the sheet it came from. */
interface Cell {
  value: string;
  where: string;
}

/** One parsed CSV, and the two choices a person can correct about it. */
interface Sheet {
  fileName: string;
  rows: string[][];
  /** Which column holds the numbers. */
  column: number;
  /** Whether row 1 is a heading rather than data. */
  header: boolean;
}

function digitCount(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

/**
 * Enough digits to be worth sending.
 *
 * Only ever used to GUESS - which column of a sheet holds the numbers, and
 * whether its first row is a heading. It is deliberately not a validation:
 * `phoneMatchDigits` has a six-digit floor and the API is what applies it.
 */
function looksDialable(value: string): boolean {
  return digitCount(value) >= 6;
}

/** A pasted block: one number per line, or several separated by commas or tabs. */
function pastedCells(text: string): Cell[] {
  const out: Cell[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const part of line.split(/[,;\t]/)) {
      const value = part.trim();
      if (value) out.push({ value, where: `pasted line ${index + 1}` });
    }
  });
  return out;
}

/** The column with the most number-looking cells, and whether row 1 is a heading. */
function readSheet(fileName: string, rows: string[][]): Sheet {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  let column = 0;
  let best = -1;
  for (let c = 0; c < width; c += 1) {
    const hits = rows.reduce((n, row) => n + (looksDialable(row[c] ?? "") ? 1 : 0), 0);
    if (hits > best) {
      best = hits;
      column = c;
    }
  }
  // A heading is a first row whose cell in that column is not a number. A
  // one-row file is never treated as a heading - that would send nothing and
  // say nothing about why.
  const header = rows.length > 1 && !looksDialable(rows[0]?.[column] ?? "");
  return { fileName, rows, column, header };
}

function sheetCells(sheet: Sheet): Cell[] {
  const out: Cell[] = [];
  for (let r = sheet.header ? 1 : 0; r < sheet.rows.length; r += 1) {
    const value = (sheet.rows[r]?.[sheet.column] ?? "").trim();
    // A blank cell is noise in a sheet, not an error, and the API says so too.
    if (value) out.push({ value, where: `row ${r + 1}` });
  }
  return out;
}

/** Column names for the picker: the heading if there is one, else its position. */
function columnChoices(sheet: Sheet): { index: number; label: string }[] {
  const width = sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const out: { index: number; label: string }[] = [];
  for (let c = 0; c < width; c += 1) {
    const heading = sheet.header ? (sheet.rows[0]?.[c] ?? "").trim() : "";
    const sample = (sheet.rows[sheet.header ? 1 : 0]?.[c] ?? "").trim();
    const name = heading || `Column ${c + 1}`;
    out.push({ index: c, label: sample ? `${name} - e.g. ${sample}` : name });
  }
  return out;
}

/** A refused cell, short enough to print beside the reason it was refused for. */
function quote(value: string): string {
  if (!value) return "(empty)";
  return value.length <= MAX_CELL_CHARS ? value : `${value.slice(0, MAX_CELL_CHARS)}…`;
}

export function UploadPanel({
  list,
  onFinished,
}: {
  list: DncList;
  /** The list's reconciled `entry_count`, so the table above can follow it. */
  onFinished: (entryCount: number) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paste, setPaste] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tally, setTally] = useState<UploadTally | null>(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);

  const readFile = (file: File) => {
    setError(null);
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete: (results) => setSheet(readSheet(file.name, results.data)),
      error: (err) => {
        setSheet(null);
        setError(err.message || "That file could not be read as a CSV.");
      },
    });
  };

  const upload = () => {
    setError(null);
    const cells = [...pastedCells(paste), ...(sheet ? sheetCells(sheet) : [])];
    if (cells.length === 0) {
      setError("Paste some numbers, or choose a file with a column of them.");
      return;
    }

    // Taken out before posting, and counted as refused - never dropped. One of
    // these in a chunk makes the route answer 400 for all five thousand.
    const tooLong = cells.filter((c) => c.value.length > MAX_CELL_CHARS);
    const sendable = cells.filter((c) => c.value.length <= MAX_CELL_CHARS);

    let running = addLocalRefusals(
      EMPTY_TALLY,
      TOO_LONG_REASON,
      tooLong.map((c) => ({ where: c.where, value: quote(c.value) })),
    );
    setTally(running);

    const total = Math.ceil(sendable.length / UPLOAD_CHUNK);
    setBatch(total > 1 ? { done: 0, total } : null);

    startTransition(async () => {
      for (let offset = 0; offset < sendable.length; offset += UPLOAD_CHUNK) {
        const chunk = sendable.slice(offset, offset + UPLOAD_CHUNK);
        const result = await addDncEntriesAction(
          list.id,
          chunk.map((c) => c.value),
        );
        if (result.error || !result.chunk) {
          setError(result.error ?? "The upload did not complete.");
          setBatch(null);
          // Everything before this chunk is already on the list, and the tally
          // on screen says how much - stopping here leaves an honest total
          // rather than discarding a partial upload the list has kept.
          return;
        }
        running = mergeChunk(
          running,
          result.chunk,
          chunk.length,
          // The index is into THIS chunk. Without the offset every batch after
          // the first points at the wrong line of the sheet.
          (index) => chunk[index]?.where ?? `row ${offset + index + 1}`,
        );
        setTally(running);
        if (total > 1) setBatch({ done: Math.min(total, offset / UPLOAD_CHUNK + 1), total });
      }

      setBatch(null);
      if (sendable.length > 0) {
        onFinished(running.entryCount);
        setPaste("");
        setSheet(null);
        router.refresh();
      }
    });
  };

  const choices = sheet ? columnChoices(sheet) : [];

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">Add numbers to &ldquo;{list.name}&rdquo;</h3>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Paste them, upload the sheet they came on, or both. Mixed formats are fine -{" "}
          <span className="font-mono">+91…</span>, <span className="font-mono">0…</span> and bare
          ten-digit numbers are all read against this workspace&rsquo;s country.
        </p>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <FormField
        label="Paste numbers"
        name="dnc-paste"
        hint="One per line, or separated by commas."
      >
        <textarea
          rows={6}
          value={paste}
          spellCheck={false}
          onChange={(event) => setPaste(event.target.value)}
          className={inputClass}
        />
      </FormField>

      <DropZone
        onFile={readFile}
        accept=".csv,text/csv"
        label="Or upload a CSV"
        hint="A sheet with a column of phone numbers."
        fileName={sheet?.fileName ?? null}
        disabled={pending}
      />

      {sheet ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label="Which column holds the numbers"
            name="dnc-column"
            hint={`${sheetCells(sheet).length.toLocaleString()} cells in this column.`}
          >
            <Select
              value={String(sheet.column)}
              onChange={(event) =>
                setSheet({ ...sheet, column: Number(event.target.value) })
              }
            >
              {choices.map((c) => (
                <option key={c.index} value={c.index}>
                  {c.label}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="flex items-end">
            <Checkbox
              label="The first row is a column heading"
              description="Untick it if row 1 is already a number."
              checked={sheet.header}
              onChange={(event) => setSheet({ ...sheet, header: event.target.checked })}
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="primary" loading={pending} onClick={upload}>
          Add to this list
        </Button>
        {batch ? (
          <p className="text-sm text-text-muted tabular-nums">
            Batch {batch.done} of {batch.total}
          </p>
        ) : null}
      </div>

      {tally ? (
        <div className="space-y-3">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Added" value={tally.inserted} />
            <Figure label="Already on the list" value={tally.alreadyPresent} />
            <Figure label="Repeated in the sheet" value={tally.duplicatesInSheet} />
            <Figure label="Refused" value={tally.refused} />
          </dl>
          <p className="text-sm text-text-muted">
            {tally.submitted.toLocaleString()} read in. The list now holds{" "}
            <span className="font-medium text-text tabular-nums">
              {tally.entryCount.toLocaleString()}
            </span>{" "}
            number{tally.entryCount === 1 ? "" : "s"}.
            {tally.blank > 0 ? ` ${tally.blank.toLocaleString()} blank cells were ignored.` : ""}
          </p>

          {tally.refusals.length > 0 ? (
            <ErrorBanner>
              <p className="font-medium">
                {tally.refused.toLocaleString()}{" "}
                {tally.refused === 1 ? "number was" : "numbers were"} refused and{" "}
                {tally.refused === 1 ? "is" : "are"} not on this list.
              </p>
              <p className="mt-1">
                Anybody on those rows can still be rung from here. Correct them in your sheet and
                add them again.
              </p>
              <ul className="mt-2 space-y-2">
                {tally.refusals.map((refusal) => (
                  <li key={refusal.reason}>
                    <p className="font-medium">
                      {refusal.count.toLocaleString()} &times; {refusal.reason}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {refusal.examples.map((example) => (
                        <li key={`${example.where}-${example.value}`} className="text-xs">
                          <span>{example.where}</span>{" "}
                          <span className="font-mono">{quote(example.value)}</span>
                        </li>
                      ))}
                      {refusal.count > refusal.examples.length ? (
                        <li className="text-xs">
                          and {(refusal.count - refusal.examples.length).toLocaleString()} more
                          like {refusal.examples.length === 1 ? "it" : "these"}
                        </li>
                      ) : null}
                    </ul>
                  </li>
                ))}
              </ul>
            </ErrorBanner>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/** One number from the upload, with what it counts. */
function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-bg-subtle px-4 py-3">
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-text tabular-nums">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
