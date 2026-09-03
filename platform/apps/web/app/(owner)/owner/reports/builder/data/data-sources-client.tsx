"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { Database, Trash2, Upload } from "lucide-react";
import { Button, Card, EmptyState, MonoLabel, StatusChip, useConfirm } from "@aura/ui";
import { inferSchema, MAX_UPLOAD_ROWS, type ColumnMeta } from "@aura/shared";
import { LocalTime } from "@/components/local-time";
import {
  createDatasetAction,
  deleteDatasetAction,
  refreshDatasetAction,
} from "../actions";
import type { CatalogueEntry, DatasetRow } from "../types";

/**
 * Connecting data.
 *
 * ── THE CSV IS PARSED HERE, IN THE BROWSER ──────────────────────────────
 *
 * Papa Parse turns the file into rows and the ROWS are posted as JSON - the
 * file itself never reaches the server. That is exactly what `/owner/import`
 * has done since migration 0062, and it is the reason the API needs no
 * multipart handling, no temp directory, and no upload path to secure.
 *
 * The schema is inferred here too, from the same shared function the API uses,
 * so the preview a person approves is the schema that gets stored. Two
 * inferences - one for the preview, one on save - could disagree, and the
 * disagreement would only ever show up as a column that charts differently
 * from how it previewed.
 */
export function DataSourcesClient({
  datasets,
  catalogue,
}: {
  datasets: DatasetRow[];
  catalogue: CatalogueEntry[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    headers: string[];
    rows: Array<Record<string, unknown>>;
    columns: ColumnMeta[];
    /** Set when this file is replacing an existing dataset's rows. */
    replacing?: string;
  } | null>(null);
  const [drift, setDrift] = useState<
    Array<{ reportId: string; reportName: string; issues: Array<{ message: string }> }>
  >([]);

  const fileInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  const connected = new Set(
    datasets.filter((d) => d.kind === "crm").map((d) => d.source_key ?? ""),
  );

  const readFile = (file: File) => {
    setError(null);
    setNotice(null);
    setDrift([]);

    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      // dynamicTyping off: the API stores every cell as text and casts on read
      // from the column's inferred type. Letting Papa decide per CELL is how a
      // column ends up half numbers and half strings.
      dynamicTyping: false,
      complete: (result) => {
        const headers = (result.meta.fields ?? []).filter(Boolean);
        if (headers.length === 0) {
          setError("That file has no header row. The first row must name the columns.");
          return;
        }
        if (result.data.length === 0) {
          setError("That file has a header row but no data.");
          return;
        }
        if (result.data.length > MAX_UPLOAD_ROWS) {
          // Named, not truncated. A report built on a silently shortened file
          // is wrong in a way nobody can see.
          setError(
            `That file has ${result.data.length.toLocaleString()} rows; the limit is ${MAX_UPLOAD_ROWS.toLocaleString()}. Aggregate it before uploading, or chart it from the CRM instead.`,
          );
          return;
        }

        setPreview({
          name: file.name.replace(/\.[^.]+$/u, ""),
          headers,
          rows: result.data,
          columns: inferSchema(headers, result.data),
          replacing: replaceTarget.current ?? undefined,
        });
        replaceTarget.current = null;
      },
      error: () => setError("That file could not be read as CSV."),
    });
  };

  const save = () => {
    if (!preview) return;
    setError(null);

    startTransition(async () => {
      if (preview.replacing) {
        const result = await refreshDatasetAction(preview.replacing, {
          headers: preview.headers,
          rows: preview.rows,
        });
        if (result.error || !result.data) {
          setError(result.error ?? "Could not refresh that data source");
          return;
        }
        setDrift(result.data.issues);
        setNotice(
          result.data.drifted
            ? `Refreshed with ${result.data.dataset.rowCount.toLocaleString()} rows. The columns changed - see below.`
            : `Refreshed with ${result.data.dataset.rowCount.toLocaleString()} rows. The columns are unchanged, so nothing broke.`,
        );
      } else {
        const result = await createDatasetAction({
          kind: "upload",
          name: preview.name,
          headers: preview.headers,
          rows: preview.rows,
        });
        if (result.error || !result.data) {
          setError(result.error ?? "Could not create that data source");
          return;
        }
        setNotice(`Added "${result.data.dataset.name}".`);
      }
      setPreview(null);
      router.refresh();
    });
  };

  const connect = (sourceKey: string) =>
    startTransition(async () => {
      setError(null);
      const result = await createDatasetAction({ kind: "crm", sourceKey });
      if (result.error) setError(result.error);
      else {
        setNotice("Connected. It is now available to every report in this workspace.");
        router.refresh();
      }
    });

  const remove = async (dataset: DatasetRow) => {
    const ok = await confirm({
      title: `Remove "${dataset.name}"?`,
      body:
        dataset.used_by_reports > 0
          ? `${dataset.used_by_reports} report${dataset.used_by_reports === 1 ? "" : "s"} still use this. Their widgets will show "the data source is no longer available" until you re-point them.`
          : "No report uses this. Any uploaded rows are deleted with it.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;

    startTransition(async () => {
      const result = await deleteDatasetAction(dataset.id);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  };

  return (
    <>
      {error ? (
        <Card className="border-danger-text/30 bg-danger-subtle">
          <p className="text-sm text-danger-text">{error}</p>
        </Card>
      ) : null}
      {notice ? (
        <Card className="border-success-text/30 bg-success-subtle">
          <p className="text-sm text-success-text">{notice}</p>
        </Card>
      ) : null}

      {/* ── the drift report (prompt 3.2, AC 7) ────────────────────────── */}
      {drift.length > 0 ? (
        <Card className="border-warning-text/30 bg-warning-subtle">
          <MonoLabel>Widgets affected by the new columns</MonoLabel>
          <p className="mt-1 text-xs text-warning-text">
            Nothing has been re-pointed automatically. A column that looks like the old one is not
            necessarily the same measurement, and a chart with the right title and the wrong number
            is worse than one that says it is broken.
          </p>
          <ul className="mt-2 space-y-2">
            {drift.map((report) => (
              <li key={report.reportId}>
                <a
                  href={`/owner/reports/builder/${report.reportId}`}
                  className="text-xs font-medium text-warning-text underline"
                >
                  {report.reportName}
                </a>
                <ul className="mt-0.5 ml-3 list-disc space-y-0.5">
                  {report.issues.map((issue, i) => (
                    <li key={i} className="text-[11px] text-warning-text">
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* ── the CSV preview, before anything is saved ──────────────────── */}
      {preview ? (
        <Card>
          <MonoLabel>
            {preview.replacing ? "Replace rows" : "New data source"} - {preview.name}
          </MonoLabel>
          <p className="mt-1 text-xs text-text-muted">
            {preview.rows.length.toLocaleString()} rows, {preview.headers.length} columns. Check the
            types below - they are what decides which charts get suggested.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {preview.columns.map((column) => (
              <span
                key={column.name}
                className="rounded-sm border border-border bg-bg-subtle px-2 py-1 text-[11px]"
              >
                <span className="font-medium text-text">{column.name}</span>{" "}
                <span className="text-text-muted">{column.type}</span>
                {column.nullRate !== undefined && column.nullRate > 0.3 ? (
                  <span className="text-warning-text">
                    {" "}
                    · {Math.round(column.nullRate * 100)}% empty
                  </span>
                ) : null}
              </span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : preview.replacing ? "Replace rows" : "Add data source"}
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {/* ── the CRM catalogue ──────────────────────────────────────────── */}
      <Card>
        <MonoLabel>From your CRM</MonoLabel>
        <p className="mt-1 text-xs text-text-muted">
          Live. Nothing is copied or stored - each of these is a saved question against records you
          can already see, and it is narrowed by the same record permissions your role has
          everywhere else.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {catalogue.map((source) => (
            <div
              key={source.key}
              className="flex flex-col rounded-md border border-border bg-surface p-3"
            >
              <span className="flex items-center gap-2">
                <Database className="size-4 text-accent-text" aria-hidden="true" />
                <span className="text-sm font-medium text-text">{source.name}</span>
              </span>
              <span className="mt-1 flex-1 text-xs leading-snug text-text-muted">
                {source.description}
              </span>
              <span className="mt-1 text-[11px] text-text-subtle">
                {source.columns.length} columns
                {source.scopable ? null : " · cannot be narrowed to one person's records"}
              </span>
              <div className="mt-2">
                {connected.has(source.key) ? (
                  <StatusChip tone="muted">connected</StatusChip>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => connect(source.key)}
                  >
                    Connect
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── uploads ────────────────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonoLabel>Your data sources</MonoLabel>
          <div>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readFile(file);
                e.target.value = "";
              }}
            />
            <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
              <Upload className="size-3.5" aria-hidden="true" />
              Upload CSV
            </Button>
          </div>
        </div>

        {datasets.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="Nothing connected yet"
              description="Connect a CRM source above, or upload a CSV. Either one can back any widget."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {datasets.map((dataset) => (
              <li key={dataset.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">
                    {dataset.name}
                  </span>
                  <span className="block text-xs text-text-subtle">
                    {dataset.kind === "crm" ? (
                      "Live CRM data"
                    ) : (
                      <>
                        {dataset.row_count.toLocaleString()} rows
                        {dataset.refreshed_at ? (
                          <>
                            {" · updated "}
                            <LocalTime iso={dataset.refreshed_at} mode="date" />
                          </>
                        ) : null}
                      </>
                    )}
                    {dataset.used_by_reports > 0
                      ? ` · used by ${dataset.used_by_reports} report${dataset.used_by_reports === 1 ? "" : "s"}`
                      : null}
                  </span>
                </span>

                {dataset.kind === "upload" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      replaceTarget.current = dataset.id;
                      fileInput.current?.click();
                    }}
                  >
                    Replace rows
                  </Button>
                ) : null}

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void remove(dataset)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">Remove {dataset.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
