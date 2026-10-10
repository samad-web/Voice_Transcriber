"use client";

import { useEffect, useState, useTransition } from "react";
import { Download, Info } from "lucide-react";
import {
  Button,
  Dialog,
  ErrorBanner,
  FormField,
  Radio,
  RadioGroup,
  Select,
  useToast,
} from "@aura/ui";

import {
  fetchExportCatalogueAction,
  fetchExportPeopleAction,
  startExportAction,
  type ExportCatalogue,
  type ExportDatasetOption,
  type ExportPeople,
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

/**
 * ── THE THIRD OPTION IS ONE PERSON (0188) ───────────────────────────────────
 *
 * "Priya's calls", and almost always with the filters still on - the reason
 * somebody wants one person's file is nearly always a review period, so this
 * option deliberately keeps the current filters rather than clearing them the
 * way the section option does.
 *
 * It appears only when there is somebody to pick AND this dataset is something
 * a person can hold. A telecaller sees exactly one name - their own - which is
 * the right-of-access case and the reason the option is not manager-only.
 */
type Choice = "view" | "section" | "person";

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
  const [people, setPeople] = useState<ExportPeople | null>(null);
  const [subject, setSubject] = useState<string>("");

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
    // The people list is a SEPARATE failure. A workspace with no org chart, or
    // a caller the chart does not reach, still gets a working drawer with two
    // options - so this one never sets `loadError`, it just leaves the third
    // option hidden.
    void fetchExportPeopleAction().then((res) => {
      if (!live) return;
      if (!res.error) setPeople(res.data ?? null);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const mine: ExportDatasetOption | undefined = catalogue?.datasets.find((d) => d.key === dataset);
  const section = mine?.section ?? null;
  const sectionDatasets = catalogue?.datasets.filter((d) => d.section === section) ?? [];
  const redacted = mine?.redacted ?? [];

  // Offered only when both halves are true: somebody to pick, and a dataset a
  // person can actually hold. The API refuses the other combinations, so
  // hiding the option is what keeps the drawer from offering a job that would
  // come back as a 400.
  const perPersonReason = people?.notPerPerson.find((d) => d.key === dataset)?.reason ?? null;
  const canPickPerson =
    !!people && people.people.length > 0 && people.datasets.some((d) => d.key === dataset);
  const chosen = people?.people.find((p) => p.telecallerId === subject);

  // The default when the option is available: whoever this person is allowed to
  // export when there is only one choice. A telecaller sees only themselves, so
  // the picker is pre-answered rather than a list of one they must open.
  useEffect(() => {
    if (!canPickPerson || subject) return;
    const only = people?.people.length === 1 ? people.people[0] : undefined;
    const self = people?.people.find((p) => p.isSelf);
    setSubject((only ?? self)?.telecallerId ?? "");
  }, [canPickPerson, people, subject]);

  function submit(): void {
    setError(null);
    startTransition(async () => {
      const res = await startExportAction(
        choice === "view"
          ? { scope: "view", format, dataset, filters }
          : choice === "person"
            ? // Filters come along deliberately: "their calls last month" is
              // the request, not "their calls ever".
              { scope: "person", format, dataset, filters, subjectTelecallerId: subject }
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
          <Button
            onClick={submit}
            // A person export with nobody chosen is the one combination the UI
            // can reach and the API would refuse, so it is blocked here.
            disabled={pending || !mine || (choice === "person" && !subject)}
          >
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
            {canPickPerson ? (
              <Radio
                name="export-scope"
                value="person"
                checked={choice === "person"}
                onChange={() => setChoice("person")}
                label={
                  people?.visibility === "own" ? "My own work" : `One person's ${mine?.label ?? ""}`
                }
                description={
                  people?.visibility === "own"
                    ? `Your ${mine?.label ?? "records"} only - ${filterSummary || "no filters"}`
                    : `${mine?.label ?? "Records"} held by one person - ${filterSummary || "no filters"}`
                }
              />
            ) : null}
          </RadioGroup>

          {choice === "person" && people && people.visibility !== "own" ? (
            <FormField
              label="Whose work"
              name="export-subject"
              hint={
                people.visibility === "branch"
                  ? "Everyone reporting to you, from the organization chart."
                  : "Anyone in this workspace."
              }
            >
              <Select
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                className="w-full"
              >
                {people.people.map((person) => (
                  <option key={person.telecallerId} value={person.telecallerId}>
                    {person.displayName}
                    {person.isSelf ? " (you)" : ""}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {choice === "person" && chosen && !chosen.isSelf ? (
            // Said out loud, before the job runs. Exporting a colleague's work
            // is a reasonable thing a manager does and a thing they should know
            // leaves a record with their name on it - the alert and the audit
            // row both already exist, so the only question is whether anybody
            // is told about them.
            <p className="flex gap-2 text-sm text-muted">
              <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This records that you exported {chosen.displayName}&apos;s work, and your workspace
                owners are told.
              </span>
            </p>
          ) : null}

          {perPersonReason && choice !== "person" ? (
            <p className="text-sm text-muted">{perPersonReason}</p>
          ) : null}

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
