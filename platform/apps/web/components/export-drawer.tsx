"use client";

import { useEffect, useState, useTransition } from "react";
import { Download, Info } from "lucide-react";
import { Button, Dialog, ErrorBanner, Radio, RadioGroup, useToast } from "@aura/ui";

import {
  fetchExportCatalogueAction,
  startExportAction,
  type ExportCatalogue,
  type ExportDatasetOption,
} from "@/app/(owner)/owner/account/data/actions";

/**
 * The export drawer (doc 35 SS8.2, migration 0148).
 *
 * ── PRE-FILLED FROM WHAT IS ON SCREEN ───────────────────────────────────────
 *
 * The caller passes the dataset it is showing and the filters currently applied,
 * and "This view" is the DEFAULT. That is the whole UX argument: somebody who
 * has just filtered a board to forty rows and presses Export means those forty,
 * and asking them to express it again in a modal is where exports get abandoned.
 *
 * ── THE SECOND OPTION IS THE SECTION ────────────────────────────────────────
 *
 * "Everything in Sales", unfiltered, every dataset that section owns. It names
 * those datasets out loud, because "everything in Sales" is otherwise a promise
 * nobody can check - and it lists only the ones this person may actually have,
 * so what they see is what they will get.
 *
 * ── TWO NOTICES, BOTH BEFORE THE JOB RUNS ───────────────────────────────────
 *
 * Redaction and the owner alert. Someone who exports 12,000 calls and only then
 * finds the transcript column empty has wasted their time and ours; and a
 * monitoring measure people are not told about is a worse version of one they
 * are.
 */

export interface ExportDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The dataset this page is showing - `leads`, `calls`, `contacts`. */
  dataset: string;
  /** A human summary of the filters in force, for the "This view" option. */
  filterSummary?: string;
  /** The filters themselves, replayed by the worker. Only sent for `view`. */
  filters?: Record<string, unknown>;
  /** Row estimate for the current view, when the page knows it. */
  viewRows?: number | null;
}

type Choice = "view" | "section";

export function ExportDrawer({
  open,
  onClose,
  dataset,
  filterSummary,
  filters,
  viewRows,
}: ExportDrawerProps) {
  const toast = useToast();
  const [catalogue, setCatalogue] = useState<ExportCatalogue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("view");
  const [format, setFormat] = useState<"csv" | "xlsx" | "json">("csv");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Loaded when the drawer opens rather than on mount: the catalogue is a
  // gated, per-caller read, and a list page should not pay for it until
  // somebody actually reaches for Export.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchExportCatalogueAction().then((res) => {
      if (!live) return;
      if (res.error) setLoadError(res.error);
      else setCatalogue(res.data ?? null);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const mine: ExportDatasetOption | undefined = catalogue?.datasets.find((d) => d.key === dataset);
  const section = mine?.section ?? null;
  const sectionDatasets = catalogue?.datasets.filter((d) => d.section === section) ?? [];
  const redacted = mine?.redacted ?? [];

  function submit(): void {
    setError(null);
    startTransition(async () => {
      const res = await startExportAction(
        choice === "view"
          ? { scope: "view", format, dataset, filters }
          : { scope: "section", format, section: section ?? undefined },
      );
      if (res.error) {
        setError(res.error);
        return;
      }
      const dropped = res.data?.omitted ?? [];
      // The omission is surfaced HERE, not left for somebody to discover a
      // missing file. The API returns it for exactly this.
      toast(
        dropped.length > 0
          ? `Export started - ${dropped.length} dataset${dropped.length === 1 ? "" : "s"} left out (${dropped.map((d) => d.dataset).join(", ")})`
          : "Export started - it will appear in Your data",
      );
      onClose();
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export"
      description="Your workspace owners are told whenever an export runs."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !mine}>
            {pending ? "Starting..." : "Start export"}
          </Button>
        </>
      }
    >
      {loadError ? <ErrorBanner>{loadError}</ErrorBanner> : null}
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {catalogue && !mine ? (
        <p className="text-sm text-muted">
          You do not have permission to export this. Ask an owner to grant export on it.
        </p>
      ) : null}

      {mine ? (
        <div className="space-y-4">
          <RadioGroup legend="What">
            <Radio
              name="export-scope"
              value="view"
              checked={choice === "view"}
              onChange={() => setChoice("view")}
              label="This view"
              description={
                [
                  filterSummary || "No filters",
                  typeof viewRows === "number" ? `~${viewRows.toLocaleString()} rows` : null,
                ]
                  .filter(Boolean)
                  .join(" - ")
              }
            />
            <Radio
              name="export-scope"
              value="section"
              checked={choice === "section"}
              onChange={() => setChoice("section")}
              label={`Everything in ${sectionLabel(section)}`}
              // Naming the datasets is what makes the option checkable. Only
              // the ones this person may have are listed.
              description={`${sectionDatasets.map((d) => d.label).join(", ")} - no filters`}
            />
          </RadioGroup>

          <RadioGroup legend="Format">
            <Radio
              name="export-format"
              value="csv"
              checked={format === "csv"}
              onChange={() => setFormat("csv")}
              label="CSV"
            />
            {/* Excel and JSON land in E3. Offered as disabled rather than
                hidden, so the format list does not silently change shape
                later - and so nobody wonders whether we forgot. */}
            <Radio
              name="export-format"
              value="xlsx"
              checked={false}
              onChange={() => undefined}
              disabled
              label="Excel (.xlsx)"
              description="Coming soon"
            />
            <Radio
              name="export-format"
              value="json"
              checked={false}
              onChange={() => undefined}
              disabled
              label="JSON"
              description="Coming soon"
            />
          </RadioGroup>

          {redacted.length > 0 ? (
            <p className="flex gap-2 text-sm text-muted">
              <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Transcripts and recordings are not included - your role does not have recording
                export. Everything else about each call is.
              </span>
            </p>
          ) : null}

          {catalogue ? (
            <p className="flex gap-2 text-sm text-muted">
              <Download aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Files stay available for {catalogue.retentionDays} days, then they are deleted. You
                can always run the export again.
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** "sales" -> "Sales". The rail's own words, capitalised. */
function sectionLabel(section: string | null): string {
  if (!section) return "this section";
  return section.charAt(0).toUpperCase() + section.slice(1);
}
