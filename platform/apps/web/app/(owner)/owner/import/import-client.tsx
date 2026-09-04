"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import type { RefObject } from "react";
import Papa from "papaparse";
import {
  Button,
  Card,
  FormField,
  MonoLabel,
  Radio,
  RadioGroup,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useAlert,
} from "@aura/ui";
import {
  IMPORT_FIELDS,
  type ImportField,
  importTemplateCsv,
  importTemplateFilename,
  looksLikeTemplateSample,
  suggestMapping,
} from "@aura/shared";
import {
  fetchImportErrorsAction,
  fetchImportErrorsCsvAction,
  previewImportAction,
  runImportAction,
  type DedupeStrategy,
  type ImportEntity,
  type ImportJob,
  type ImportRowError,
} from "./actions";

type Step = "entity" | "upload" | "mapping" | "strategy" | "running" | "results";

const ENTITY_OPTIONS: Array<{ value: ImportEntity; label: string; hint: string }> = [
  { value: "contact", label: "Contacts", hint: "People - name, email, phone, title." },
  { value: "account", label: "Accounts", hint: "Companies - name and domain." },
  { value: "deal", label: "Deals", hint: "Opportunities - name, amount, stage." },
];

const DEDUPE_OPTIONS: Array<{ value: DedupeStrategy; label: string; description: string }> = [
  {
    value: "skip",
    label: "Skip duplicates",
    description: "Leave existing records alone - a row that matches one already on file is left untouched.",
  },
  {
    value: "update",
    label: "Update existing",
    description:
      "Fill in matched records with the new data, without ever blanking a field that already has a value.",
  },
  {
    value: "create",
    label: "Always create",
    description:
      "Insert every row even if it looks like a duplicate - some rows may fail if they'd collide with an existing unique phone, email or domain.",
  },
];

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 5;

const STEP_ORDER: Step[] = ["entity", "upload", "mapping", "strategy", "running", "results"];
const STEP_LABELS: Record<Step, string> = {
  entity: "Choose data",
  upload: "Upload CSV",
  mapping: "Map columns",
  strategy: "Duplicates",
  running: "Import",
  results: "Results",
};

/** The required target fields to validate against: the API's own answer when
 *  it loaded, falling back to `@aura/shared` if the preview call failed -
 *  required-ness must never silently disappear just because a network call
 *  did. Both sides read the same table, so the fallback cannot disagree. */
function requiredFieldsFor(entity: ImportEntity, apiRequired: string[]): string[] {
  return apiRequired.length > 0
    ? apiRequired
    : IMPORT_FIELDS[entity].filter((f) => f.required).map((f) => f.field);
}

/** Hand the browser a file. Same three lines for the template and for the
 *  failed-row export, so they are written once. */
function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * The bulk-import wizard: entity → CSV → column mapping → dedupe strategy →
 * run → results. One `step` state machine, all client-side - the CSV itself
 * is parsed in the browser with papaparse and never touches the server until
 * "Start import", which sends the raw rows plus the mapping the human
 * confirmed. The API applies the mapping itself (see ./actions.ts).
 */
export function ImportWizard() {
  const [step, setStep] = useState<Step>("entity");
  const [entity, setEntity] = useState<ImportEntity | null>(null);
  const alert = useAlert();

  // ── parsed CSV (step: upload) ────────────────────────────────────────
  const [fields, setFields] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [pasteText, setPasteText] = useState("");
  /** How many parsed rows still look like the template's own sample rows. */
  const [sampleRowCount, setSampleRowCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── column mapping (step: mapping) ──────────────────────────────────
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [apiRequiredFields, setApiRequiredFields] = useState<string[]>([]);
  const [mappingPending, startMapping] = useTransition();

  // ── dedupe strategy (step: strategy) ────────────────────────────────
  const [dedupeStrategy, setDedupeStrategy] = useState<DedupeStrategy>("skip");

  // ── run + results (step: running / results) ─────────────────────────
  const [job, setJob] = useState<ImportJob | null>(null);
  const [rowErrors, setRowErrors] = useState<ImportRowError[] | null>(null);
  const [, startRun] = useTransition();

  function reset() {
    setStep("entity");
    setEntity(null);
    setFields([]);
    setRows([]);
    setPasteText("");
    setSampleRowCount(0);
    setMapping({});
    setApiRequiredFields([]);
    setDedupeStrategy("skip");
    setJob(null);
    setRowErrors(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function applyParsed(data: Record<string, string>[], parsedFields: string[]) {
    if (data.length === 0) {
      setFields([]);
      setRows([]);
      setSampleRowCount(0);
      void alert({
        title: "Couldn't read that file",
        body: "No rows found in that file.",
        tone: "danger",
      });
      return;
    }
    if (data.length > MAX_ROWS) {
      setFields(parsedFields);
      setRows([]);
      setSampleRowCount(0);
      void alert({
        title: "That file has too many rows",
        body:
          `That file has ${data.length.toLocaleString()} rows - this wizard imports up to ` +
          `${MAX_ROWS.toLocaleString()} at a time. Split the file and import it in batches.`,
        tone: "danger",
      });
      return;
    }
    setFields(parsedFields);
    setRows(data);

    // Whether the template's sample rows survived into a real import. Guessed
    // locally with the SAME function the API uses server-side, because the
    // mapping step has not run yet at this point - and a warning that only
    // appeared two screens later would arrive after the human had stopped
    // looking at their spreadsheet.
    if (entity) {
      const guessed = suggestMapping(entity, parsedFields);
      setSampleRowCount(data.filter((row) => looksLikeTemplateSample(entity, guessed, row)).length);
    }
  }

  function handleFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => applyParsed(results.data, results.meta.fields ?? []),
      // Clear whatever a previous upload left behind before complaining: the
      // Continue button is gated on there being rows, so a file that failed to
      // parse must not leave the last file's rows sitting there looking ready.
      error: (err) => {
        setFields([]);
        setRows([]);
        setSampleRowCount(0);
        void alert({
          title: "Couldn't read that file",
          body: err.message || "Could not parse that file.",
          tone: "danger",
        });
      },
    });
  }

  function handlePaste() {
    if (!pasteText.trim()) return;
    const results = Papa.parse<Record<string, string>>(pasteText, {
      header: true,
      skipEmptyLines: true,
    });
    applyParsed(results.data, results.meta.fields ?? []);
  }

  function goToMapping() {
    if (!entity) return;
    setStep("mapping");
    startMapping(async () => {
      const res = await previewImportAction(entity, fields);
      if (res.error) {
        await alert({
          title: "Couldn't read your columns",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setMapping(res.mapping ?? {});
      setApiRequiredFields(res.requiredFields ?? []);
    });
  }

  function goToStrategy() {
    if (!entity) return;
    const required = requiredFieldsFor(entity, apiRequiredFields);
    const missing = IMPORT_FIELDS[entity].filter((f) => required.includes(f.field) && !mapping[f.field]);
    if (missing.length > 0) {
      void alert({
        title: "Map every required field before continuing",
        body: `Still missing: ${missing.map((f) => f.label).join(", ")}.`,
        tone: "danger",
      });
      return;
    }
    setStep("strategy");
  }

  function runImport() {
    if (!entity) return;
    setStep("running");
    startRun(async () => {
      const res = await runImportAction(entity, mapping, dedupeStrategy, rows);
      if (res.error || !res.job) {
        setStep("strategy");
        await alert({
          title: "Couldn't run the import",
          body: res.error ?? "Import failed with no reason given.",
          tone: "danger",
        });
        return;
      }
      setJob(res.job);
      if (res.job.failed_count > 0) {
        const errRes = await fetchImportErrorsAction(res.job.id);
        setRowErrors(errRes.errors ?? []);
      }
      setStep("results");
    });
  }

  async function downloadErrorsCsv() {
    if (!job) return;
    const res = await fetchImportErrorsCsvAction(job.id);
    if (!res.csv) {
      await alert({
        title: "Couldn't download the error rows",
        body: res.error ?? "Could not download the error rows.",
        tone: "danger",
      });
      return;
    }
    downloadCsv(`import-${job.id}-errors.csv`, res.csv);
  }

  const previewRows = useMemo(() => rows.slice(0, PREVIEW_ROWS), [rows]);

  return (
    <Card>
      <StepIndicator step={step} />

      {step === "entity" ? (
        <EntityStep
          entity={entity}
          onPick={(value) => {
            setEntity(value);
            setStep("upload");
          }}
        />
      ) : null}

      {step === "upload" && entity ? (
        <UploadStep
          entity={entity}
          fields={fields}
          rows={rows}
          previewRows={previewRows}
          pasteText={pasteText}
          onPasteTextChange={setPasteText}
          onParsePaste={handlePaste}
          onFile={handleFile}
          fileInputRef={fileInputRef}
          sampleRowCount={sampleRowCount}
          onDownloadTemplate={() => downloadCsv(importTemplateFilename(entity), importTemplateCsv(entity))}
          onBack={() => setStep("entity")}
          onNext={goToMapping}
        />
      ) : null}

      {step === "mapping" && entity ? (
        <MappingStep
          entity={entity}
          fields={fields}
          mapping={mapping}
          apiRequiredFields={apiRequiredFields}
          loading={mappingPending}
          onChange={(field, value) => setMapping((prev) => ({ ...prev, [field]: value }))}
          onBack={() => setStep("upload")}
          onNext={goToStrategy}
        />
      ) : null}

      {step === "strategy" ? (
        <StrategyStep
          value={dedupeStrategy}
          onChange={setDedupeStrategy}
          onBack={() => setStep("mapping")}
          onNext={runImport}
        />
      ) : null}

      {step === "running" ? <RunningStep rowCount={rows.length} /> : null}

      {step === "results" && job ? (
        <ResultsStep
          job={job}
          rowErrors={rowErrors}
          onDownloadErrors={() => void downloadErrorsCsv()}
          onRestart={reset}
        />
      ) : null}
    </Card>
  );
}

/** A non-interactive breadcrumb of where the human is in the five-step flow.
 *  The numbered/checked badges are aria-hidden: the text label beside each
 *  one already names the step, so a screen reader would otherwise announce
 *  every step twice. */
function StepIndicator({ step }: { step: Step }) {
  const currentIndex = STEP_ORDER.indexOf(step);
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-3 border-b border-border pb-4">
      {STEP_ORDER.map((s, i) => {
        const isCurrent = i === currentIndex;
        const isDone = i < currentIndex;
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums " +
                (isCurrent
                  ? "bg-accent text-accent-fg"
                  : isDone
                    ? "bg-text text-bg"
                    : "border border-border-strong text-text-muted")
              }
            >
              {isDone ? "✓" : i + 1}
            </span>
            <span
              aria-current={isCurrent ? "step" : undefined}
              className={"text-xs font-medium " + (isCurrent ? "text-text" : "text-text-muted")}
            >
              {STEP_LABELS[s]}
            </span>
            {i < STEP_ORDER.length - 1 ? (
              <span aria-hidden="true" className="ml-1 h-px w-4 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function EntityStep({
  entity,
  onPick,
}: {
  entity: ImportEntity | null;
  onPick: (value: ImportEntity) => void;
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-text">What are you importing?</h3>
      <p className="mt-1 text-sm text-text-muted">
        Pick one CSV type per import - run the wizard again for the others.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {ENTITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onPick(opt.value)}
            aria-pressed={entity === opt.value}
            className={
              "flex flex-col items-start gap-1 rounded-md border p-4 text-left transition-colors " +
              (entity === opt.value
                ? "border-accent bg-surface-hover"
                : "border-border hover:bg-surface-hover")
            }
          >
            <span className="text-sm font-semibold text-text">{opt.label}</span>
            <span className="text-xs text-text-muted">{opt.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function UploadStep({
  entity,
  fields,
  rows,
  previewRows,
  pasteText,
  onPasteTextChange,
  onParsePaste,
  onFile,
  fileInputRef,
  sampleRowCount,
  onDownloadTemplate,
  onBack,
  onNext,
}: {
  entity: ImportEntity;
  fields: string[];
  rows: Record<string, string>[];
  previewRows: Record<string, string>[];
  pasteText: string;
  onPasteTextChange: (value: string) => void;
  onParsePaste: () => void;
  onFile: (file: File) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  sampleRowCount: number;
  onDownloadTemplate: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const canContinue = rows.length > 0;
  const entityLabel = ENTITY_OPTIONS.find((o) => o.value === entity)?.label.toLowerCase() ?? entity;
  const columns = IMPORT_FIELDS[entity];

  return (
    <div>
      <h3 className="text-lg font-semibold text-text">Upload a CSV of {entityLabel}</h3>
      <p className="mt-1 text-sm text-text-muted">
        The first row must be column headers. Up to {MAX_ROWS.toLocaleString()} rows per import - split a
        larger file and run this wizard again for the rest.
      </p>

      <TemplatePanel entityLabel={entityLabel} columns={columns} onDownload={onDownloadTemplate} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <MonoLabel>Upload a file</MonoLabel>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
            }}
            className="mt-1.5 block w-full text-sm text-text file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:text-sm file:font-medium file:text-text hover:file:bg-surface-hover"
          />
        </div>
        <div>
          <MonoLabel>Or paste CSV text</MonoLabel>
          <textarea
            value={pasteText}
            onChange={(e) => onPasteTextChange(e.target.value)}
            placeholder={"name,email,phone\nJane Doe,jane@example.com,9876543210"}
            rows={3}
            className="mt-1.5 w-full resize-none rounded-md border border-border-strong bg-surface p-2.5 text-sm text-text placeholder:text-text-muted"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-1.5"
            disabled={!pasteText.trim()}
            onClick={onParsePaste}
          >
            Parse pasted text
          </Button>
        </div>
      </div>

      {sampleRowCount > 0 ? (
        <p className="mt-3 rounded-md border border-warning-text/30 bg-warning-subtle px-3 py-2 text-sm text-warning-text">
          {sampleRowCount === 1 ? "One row is" : `${sampleRowCount} rows are`} still the template&rsquo;s
          example {sampleRowCount === 1 ? "row" : "rows"} - delete{" "}
          {sampleRowCount === 1 ? "it" : "them"} in your spreadsheet and upload again, or{" "}
          {sampleRowCount === 1 ? "it" : "they"} will be imported as real records.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="mt-4">
          <MonoLabel>
            Preview - first {Math.min(PREVIEW_ROWS, rows.length)} of {rows.length.toLocaleString()} row
            {rows.length === 1 ? "" : "s"}
          </MonoLabel>
          <Table caption="Parsed CSV preview" className="mt-1.5">
            <TableHead>
              <tr>
                {fields.map((f) => (
                  <TableHeaderCell key={f}>{f}</TableHeaderCell>
                ))}
              </tr>
            </TableHead>
            <TableBody>
              {previewRows.map((row, i) => (
                <TableRow key={i}>
                  {fields.map((f) => (
                    <TableCell key={f} className="text-text-muted">
                      {row[f] ?? ""}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" disabled={!canContinue} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/**
 * "Here is the shape we want, here is a file of that shape."
 *
 * Both halves matter. The download alone leaves anyone who opens the file in
 * Notepad guessing; the table alone leaves them retyping headers by hand and
 * getting one of them slightly wrong. Together they are the answer to the only
 * question this step actually raises, which is what the file should look like.
 *
 * The columns come from `@aura/shared`, the same table the API maps against -
 * so this can never advertise a column the importer would then ignore.
 */
function TemplatePanel({
  entityLabel,
  columns,
  onDownload,
}: {
  entityLabel: string;
  columns: ImportField[];
  onDownload: () => void;
}) {
  return (
    <div className="mt-4 rounded-md border border-border bg-bg-subtle p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[16rem] flex-1">
          <MonoLabel>Not sure of the format?</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            Download the template, fill it in with your {entityLabel}, and upload it back. Its headers
            are the ones this wizard recognises, so the mapping step arrives already filled in.
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onDownload}>
          Download CSV template
        </Button>
      </div>

      <Table caption={`Columns in the ${entityLabel} template`} className="mt-3">
        <TableHead>
          <tr>
            <TableHeaderCell>Column</TableHeaderCell>
            <TableHeaderCell>Required</TableHeaderCell>
            <TableHeaderCell>Example</TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {columns.map((c) => (
            <TableRow key={c.field}>
              <TableCell className="whitespace-nowrap font-medium">{c.header}</TableCell>
              <TableCell className="text-text-muted">{c.required ? "Yes" : "Optional"}</TableCell>
              <TableCell className="text-text-muted">
                {c.example}
                {c.hint ? <span className="mt-0.5 block text-xs">{c.hint}</span> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <p className="mt-2 text-xs text-text-muted">
        Opens in Excel, Numbers or Google Sheets. It ships with two example rows - delete them before
        you upload. Extra columns of your own are ignored, and the order does not matter.
      </p>
    </div>
  );
}

function MappingStep({
  entity,
  fields,
  mapping,
  apiRequiredFields,
  loading,
  onChange,
  onBack,
  onNext,
}: {
  entity: ImportEntity;
  fields: string[];
  mapping: Record<string, string | null>;
  apiRequiredFields: string[];
  loading: boolean;
  onChange: (field: string, value: string | null) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const targetFields = IMPORT_FIELDS[entity];
  const required = requiredFieldsFor(entity, apiRequiredFields);

  return (
    <div>
      <h3 className="text-lg font-semibold text-text">Match your columns</h3>
      <p className="mt-1 text-sm text-text-muted">
        We guessed a mapping from your headers - check it, and fill in anything left as
        &ldquo;- none -&rdquo;. Fields marked <span className="text-danger">*</span> are required.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-text-muted">Reading your columns…</p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {targetFields.map((tf) => (
            <FormField
              key={tf.field}
              name={`map-${tf.field}`}
              label={tf.label}
              required={required.includes(tf.field)}
            >
              <Select
                value={mapping[tf.field] ?? ""}
                onChange={(e) => onChange(tf.field, e.target.value || null)}
              >
                <option value="">- none -</option>
                {fields.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </FormField>
          ))}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" disabled={loading} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function StrategyStep({
  value,
  onChange,
  onBack,
  onNext,
}: {
  value: DedupeStrategy;
  onChange: (value: DedupeStrategy) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-text">Handling duplicates</h3>
      <p className="mt-1 text-sm text-text-muted">
        Choose what happens when a row looks like it matches a record already in your CRM.
      </p>

      <RadioGroup legend="Duplicate strategy" className="mt-4">
        {DEDUPE_OPTIONS.map((opt) => (
          <Radio
            key={opt.value}
            name="dedupeStrategy"
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            label={opt.label}
            description={opt.description}
          />
        ))}
      </RadioGroup>

      <div className="mt-6 flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onNext}>
          Start import
        </Button>
      </div>
    </div>
  );
}

function RunningStep({ rowCount }: { rowCount: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-6 w-6 animate-spin text-text-muted"
        fill="none"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium text-text">
        Importing {rowCount.toLocaleString()} row{rowCount === 1 ? "" : "s"}…
      </p>
      <p className="text-xs text-text-muted">This can take a few seconds for a large file.</p>
    </div>
  );
}

function ResultsStep({
  job,
  rowErrors,
  onDownloadErrors,
  onRestart,
}: {
  job: ImportJob;
  rowErrors: ImportRowError[] | null;
  onDownloadErrors: () => void;
  onRestart: () => void;
}) {
  const stats: Array<{ label: string; value: number }> = [
    { label: "Inserted", value: job.inserted_count },
    { label: "Updated", value: job.updated_count },
    { label: "Skipped", value: job.skipped_count },
    { label: "Failed", value: job.failed_count },
  ];

  return (
    <div>
      <h3 className="text-lg font-semibold text-text">Import complete</h3>
      <p className="mt-1 text-sm text-text-muted">
        {job.total_rows.toLocaleString()} row{job.total_rows === 1 ? "" : "s"} processed.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-md border border-border p-3">
            <MonoLabel>{s.label}</MonoLabel>
            <p
              className={
                "mt-1 text-2xl font-semibold tabular-nums " +
                (s.label === "Failed" && s.value > 0 ? "text-danger-text" : "text-text")
              }
            >
              {s.value.toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      {job.failed_count > 0 ? (
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MonoLabel>Failed rows</MonoLabel>
            <Button type="button" variant="secondary" size="sm" onClick={onDownloadErrors}>
              Download error rows as CSV
            </Button>
          </div>
          {rowErrors === null ? (
            <p className="mt-2 text-sm text-text-muted">Loading…</p>
          ) : (
            <Table caption="Failed rows" className="mt-2">
              <TableHead>
                <tr>
                  <TableHeaderCell>Row</TableHeaderCell>
                  <TableHeaderCell>Error</TableHeaderCell>
                </tr>
              </TableHead>
              <TableBody>
                {rowErrors.map((e) => (
                  <TableRow key={e.row_number}>
                    <TableCell className="tabular-nums">{e.row_number}</TableCell>
                    <TableCell className="text-danger-text">{e.error}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : null}

      <div className="mt-6 border-t border-border pt-4">
        <Button type="button" variant="secondary" onClick={onRestart}>
          Start another import
        </Button>
      </div>
    </div>
  );
}
