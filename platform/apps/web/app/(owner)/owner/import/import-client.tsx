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
} from "@aura/ui";
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

interface TargetField {
  field: string;
  label: string;
  required: boolean;
}

const ENTITY_OPTIONS: Array<{ value: ImportEntity; label: string; hint: string }> = [
  { value: "contact", label: "Contacts", hint: "People — name, email, phone, title." },
  { value: "account", label: "Accounts", hint: "Companies — name and domain." },
  { value: "deal", label: "Deals", hint: "Opportunities — name, amount, stage." },
];

/**
 * The full target-field list per entity (the same set `/import/preview`
 * guesses against). Fixed by the API contract, so it is hardcoded here rather
 * than derived from a response that might arrive empty on error — the
 * mapping step needs the whole list of Selects to render even before the
 * preview call returns.
 */
const TARGET_FIELDS: Record<ImportEntity, TargetField[]> = {
  contact: [
    { field: "displayName", label: "Full name", required: true },
    { field: "firstName", label: "First name", required: false },
    { field: "lastName", label: "Last name", required: false },
    { field: "email", label: "Email", required: false },
    { field: "phone", label: "Phone", required: false },
    { field: "title", label: "Title", required: false },
  ],
  account: [
    { field: "name", label: "Company name", required: true },
    { field: "domain", label: "Domain", required: false },
  ],
  deal: [
    { field: "name", label: "Deal name", required: true },
    { field: "amount", label: "Amount", required: false },
    { field: "stage", label: "Stage", required: false },
    { field: "contactEmail", label: "Contact email", required: false },
    { field: "accountName", label: "Account name", required: false },
  ],
};

const DEDUPE_OPTIONS: Array<{ value: DedupeStrategy; label: string; description: string }> = [
  {
    value: "skip",
    label: "Skip duplicates",
    description: "Leave existing records alone — a row that matches one already on file is left untouched.",
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
      "Insert every row even if it looks like a duplicate — some rows may fail if they'd collide with an existing unique phone, email or domain.",
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
 *  it loaded, falling back to the fixed list above if the preview call
 *  failed — required-ness must never silently disappear just because a
 *  network call did. */
function requiredFieldsFor(entity: ImportEntity, apiRequired: string[]): string[] {
  return apiRequired.length > 0
    ? apiRequired
    : TARGET_FIELDS[entity].filter((f) => f.required).map((f) => f.field);
}

/**
 * The bulk-import wizard: entity → CSV → column mapping → dedupe strategy →
 * run → results. One `step` state machine, all client-side — the CSV itself
 * is parsed in the browser with papaparse and never touches the server until
 * "Start import", which sends the raw rows plus the mapping the human
 * confirmed. The API applies the mapping itself (see ./actions.ts).
 */
export function ImportWizard() {
  const [step, setStep] = useState<Step>("entity");
  const [entity, setEntity] = useState<ImportEntity | null>(null);

  // ── parsed CSV (step: upload) ────────────────────────────────────────
  const [fields, setFields] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── column mapping (step: mapping) ──────────────────────────────────
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [apiRequiredFields, setApiRequiredFields] = useState<string[]>([]);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [mappingPending, startMapping] = useTransition();

  // ── dedupe strategy (step: strategy) ────────────────────────────────
  const [dedupeStrategy, setDedupeStrategy] = useState<DedupeStrategy>("skip");

  // ── run + results (step: running / results) ─────────────────────────
  const [job, setJob] = useState<ImportJob | null>(null);
  const [rowErrors, setRowErrors] = useState<ImportRowError[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [, startRun] = useTransition();

  function reset() {
    setStep("entity");
    setEntity(null);
    setFields([]);
    setRows([]);
    setParseError(null);
    setPasteText("");
    setMapping({});
    setApiRequiredFields([]);
    setMappingError(null);
    setDedupeStrategy("skip");
    setJob(null);
    setRowErrors(null);
    setRunError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function applyParsed(data: Record<string, string>[], parsedFields: string[]) {
    if (data.length === 0) {
      setFields([]);
      setRows([]);
      setParseError("No rows found in that file.");
      return;
    }
    if (data.length > MAX_ROWS) {
      setFields(parsedFields);
      setRows([]);
      setParseError(
        `That file has ${data.length.toLocaleString()} rows — this wizard imports up to ` +
          `${MAX_ROWS.toLocaleString()} at a time. Split the file and import it in batches.`,
      );
      return;
    }
    setParseError(null);
    setFields(parsedFields);
    setRows(data);
  }

  function handleFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => applyParsed(results.data, results.meta.fields ?? []),
      error: (err) => setParseError(err.message || "Could not parse that file."),
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
    setMappingError(null);
    startMapping(async () => {
      const res = await previewImportAction(entity, fields);
      if (res.error) {
        setMappingError(res.error);
        return;
      }
      setMapping(res.mapping ?? {});
      setApiRequiredFields(res.requiredFields ?? []);
    });
  }

  function goToStrategy() {
    if (!entity) return;
    const required = requiredFieldsFor(entity, apiRequiredFields);
    const missing = TARGET_FIELDS[entity].filter((f) => required.includes(f.field) && !mapping[f.field]);
    if (missing.length > 0) {
      setMappingError(
        `Map every required field before continuing — still missing: ${missing.map((f) => f.label).join(", ")}.`,
      );
      return;
    }
    setMappingError(null);
    setStep("strategy");
  }

  function runImport() {
    if (!entity) return;
    setStep("running");
    setRunError(null);
    startRun(async () => {
      const res = await runImportAction(entity, mapping, dedupeStrategy, rows);
      if (res.error || !res.job) {
        setRunError(res.error ?? "Import failed with no reason given.");
        setStep("strategy");
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
    if (!res.csv) return;
    const blob = new Blob([res.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-${job.id}-errors.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
          parseError={parseError}
          pasteText={pasteText}
          onPasteTextChange={setPasteText}
          onParsePaste={handlePaste}
          onFile={handleFile}
          fileInputRef={fileInputRef}
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
          error={mappingError}
          onChange={(field, value) => setMapping((prev) => ({ ...prev, [field]: value }))}
          onBack={() => setStep("upload")}
          onNext={goToStrategy}
        />
      ) : null}

      {step === "strategy" ? (
        <StrategyStep
          value={dedupeStrategy}
          onChange={setDedupeStrategy}
          error={runError}
          onBack={() => setStep("mapping")}
          onNext={runImport}
        />
      ) : null}

      {step === "running" ? <RunningStep rowCount={rows.length} /> : null}

      {step === "results" && job ? (
        <ResultsStep
          job={job}
          rowErrors={rowErrors}
          onDownloadErrors={downloadErrorsCsv}
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
        Pick one CSV type per import — run the wizard again for the others.
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
  parseError,
  pasteText,
  onPasteTextChange,
  onParsePaste,
  onFile,
  fileInputRef,
  onBack,
  onNext,
}: {
  entity: ImportEntity;
  fields: string[];
  rows: Record<string, string>[];
  previewRows: Record<string, string>[];
  parseError: string | null;
  pasteText: string;
  onPasteTextChange: (value: string) => void;
  onParsePaste: () => void;
  onFile: (file: File) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onBack: () => void;
  onNext: () => void;
}) {
  const canContinue = rows.length > 0 && !parseError;
  const entityLabel = ENTITY_OPTIONS.find((o) => o.value === entity)?.label.toLowerCase() ?? entity;

  return (
    <div>
      <h3 className="text-lg font-semibold text-text">Upload a CSV of {entityLabel}</h3>
      <p className="mt-1 text-sm text-text-muted">
        The first row must be column headers. Up to {MAX_ROWS.toLocaleString()} rows per import — split a
        larger file and run this wizard again for the rest.
      </p>

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

      {parseError ? <p className="mt-3 text-sm text-danger-text">{parseError}</p> : null}

      {rows.length > 0 ? (
        <div className="mt-4">
          <MonoLabel>
            Preview — first {Math.min(PREVIEW_ROWS, rows.length)} of {rows.length.toLocaleString()} row
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

function MappingStep({
  entity,
  fields,
  mapping,
  apiRequiredFields,
  loading,
  error,
  onChange,
  onBack,
  onNext,
}: {
  entity: ImportEntity;
  fields: string[];
  mapping: Record<string, string | null>;
  apiRequiredFields: string[];
  loading: boolean;
  error: string | null;
  onChange: (field: string, value: string | null) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const targetFields = TARGET_FIELDS[entity];
  const required = requiredFieldsFor(entity, apiRequiredFields);

  return (
    <div>
      <h3 className="text-lg font-semibold text-text">Match your columns</h3>
      <p className="mt-1 text-sm text-text-muted">
        We guessed a mapping from your headers — check it, and fill in anything left as
        &ldquo;— none —&rdquo;. Fields marked <span className="text-danger">*</span> are required.
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
                <option value="">— none —</option>
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

      {error ? <p className="mt-3 text-sm text-danger-text">{error}</p> : null}

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
  error,
  onBack,
  onNext,
}: {
  value: DedupeStrategy;
  onChange: (value: DedupeStrategy) => void;
  error: string | null;
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

      {error ? <p className="mt-3 text-sm text-danger-text">{error}</p> : null}

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
