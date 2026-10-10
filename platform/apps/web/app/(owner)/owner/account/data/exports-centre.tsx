"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { Download, RotateCcw, X } from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  ProgressBar,
  StatusChip,
  useToast,
} from "@aura/ui";
import { formatBytes } from "@aura/shared";

import { LocalTime } from "@/components/local-time";
import { useRealtime } from "@/components/realtime-provider";
import { useServerState } from "@/lib/use-server-state";
import {
  cancelExportAction,
  exportDownloadUrlAction,
  fetchExportsAction,
  startExportAction,
  type ExportJobRow,
} from "./actions";

/**
 * The exports centre's live half (doc 35 SS8.3/SS8.4, migration 0148).
 *
 * ── TWO REFRESH MECHANISMS, DELIBERATELY ────────────────────────────────────
 *
 * Realtime (`export` topic) AND a 5s poll while anything is in flight. The poll
 * is NOT optional: locally realtime needs RabbitMQ running or nothing updates at
 * all, and in production a broker restart drops signals in flight by design. A
 * progress bar that can silently stop is worse than one that ticks a little
 * late.
 *
 * The poll stops when nothing is in flight and when the tab is hidden - a
 * background tab must not keep a query running every five seconds forever.
 */

const LIVE = new Set(["queued", "running", "packaging"]);
const POLL_MS = 5_000;

export function ExportsCentre({ initialJobs }: { initialJobs: ExportJobRow[] }) {
  const toast = useToast();
  const params = useSearchParams();
  const highlight = params.get("job");
  const [jobs, setJobs] = useServerState(initialJobs);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const reload = useCallback(async () => {
    const res = await fetchExportsAction();
    if (res.data) setJobs(res.data.jobs);
  }, [setJobs]);

  useRealtime(["export"], () => {
    void reload();
  });

  const anyLive = jobs.some((j) => LIVE.has(j.status));
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyLive, reload]);

  /**
   * An owner arriving from an `export_created` notification lands on `?job=<id>`.
   * Scrolling to and highlighting that row is what turns the alert into an
   * answer - an owner who clicks it and lands on an unsorted table of forty jobs
   * has been handed a search task instead.
   */
  useEffect(() => {
    if (!highlight) return;
    rowRefs.current[highlight]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight, jobs.length]);

  async function download(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    const res = await exportDownloadUrlAction(id);
    setBusy(null);
    if (res.error || !res.url) {
      setError(res.error ?? "Could not start the download");
      return;
    }
    // The URL is signed for five minutes and re-minted on every click, so it is
    // followed immediately and never stored.
    window.location.href = res.url;
    void reload();
  }

  function runAgain(job: ExportJobRow): void {
    startTransition(async () => {
      setError(null);
      const res = await startExportAction(
        job.scope === "view"
          ? { scope: "view", format: "csv", dataset: job.datasets[0] }
          : job.scope === "person"
            ? {
                scope: "person",
                format: "csv",
                dataset: job.datasets[0],
                // Re-run re-authorizes from scratch: if this person has since
                // left the caller's branch, the API refuses here rather than
                // the worker refusing it minutes later.
                subjectTelecallerId: job.subject_telecaller_id ?? undefined,
              }
            : job.scope === "section"
              ? { scope: "section", format: "csv", section: job.section ?? undefined }
              : { scope: "bulk", format: "csv" },
      );
      if (res.error) setError(res.error);
      else {
        toast("Export started - we will tell you when it is ready");
        await reload();
      }
    });
  }

  function cancel(job: ExportJobRow): void {
    startTransition(async () => {
      setError(null);
      const res = await cancelExportAction(job.id);
      if (res.error) setError(res.error);
      else await reload();
    });
  }

  if (jobs.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No exports yet"
          description="Export from any list page - Leads, Calls, Contacts - and the file will appear here."
        />
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-4 font-medium">What</th>
              <th className="py-2 pr-4 font-medium">Who</th>
              <th className="py-2 pr-4 font-medium">Rows</th>
              <th className="py-2 pr-4 font-medium">Size</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Available until</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr
                key={job.id}
                ref={(el) => {
                  rowRefs.current[job.id] = el;
                }}
                className={
                  job.id === highlight
                    ? "border-b border-line bg-surface-2"
                    : "border-b border-line"
                }
              >
                <td className="py-3 pr-4 align-top">
                  <div className="font-medium text-text">{whatLabel(job)}</div>
                  <div className="text-xs text-muted">{job.format.toUpperCase()}</div>
                </td>
                <td className="py-3 pr-4 align-top text-muted">{job.requested_by_name ?? "-"}</td>
                <td className="py-3 pr-4 align-top tabular-nums text-muted">
                  {rowsLabel(job)}
                </td>
                <td className="py-3 pr-4 align-top tabular-nums text-muted">
                  {Number(job.bytes_written) > 0 ? formatBytes(Number(job.bytes_written)) : "-"}
                </td>
                <td className="py-3 pr-4 align-top">
                  <StatusCell job={job} />
                </td>
                <td className="py-3 pr-4 align-top text-muted">
                  {/* The workspace's clock, not the machine's: `LocalTime`
                      renders in the org's zone so two colleagues read the same
                      expiry off the same row, and the first paint matches the
                      hydrated one. A bare toLocaleString() here is exactly what
                      console-time.test.ts exists to catch. */}
                  {job.status === "ready" && job.expires_at ? (
                    <LocalTime iso={job.expires_at} />
                  ) : (
                    "-"
                  )}
                </td>
                <td className="py-3 align-top text-right">
                  <div className="flex justify-end gap-2">
                    {job.canDownload ? (
                      <Button
                        size="sm"
                        onClick={() => void download(job.id)}
                        disabled={busy === job.id}
                      >
                        <Download aria-hidden className="h-4 w-4" />
                        {busy === job.id ? "Opening..." : "Download"}
                      </Button>
                    ) : null}
                    {LIVE.has(job.status) ? (
                      <Button size="sm" variant="ghost" onClick={() => cancel(job)}>
                        <X aria-hidden className="h-4 w-4" />
                        Cancel
                      </Button>
                    ) : null}
                    {canRunAgain(job) ? (
                      <Button size="sm" variant="ghost" onClick={() => runAgain(job)}>
                        <RotateCcw aria-hidden className="h-4 w-4" />
                        Run again
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * The status cell.
 *
 * Failure states use the ORANGE error treatment, not red: in this console red
 * means MISSED, and an export that could not finish is an error rather than a
 * missed call.
 */
function StatusCell({ job }: { job: ExportJobRow }) {
  if (job.status === "running" || job.status === "packaging") {
    const total = job.rows_total === null ? null : Number(job.rows_total);
    const written = Number(job.rows_written);
    const determinate = total !== null && total > 0;
    return (
      <div className="min-w-[9rem] space-y-1">
        {/* `ProgressBar` takes a real percentage and has no indeterminate mode,
            so a job with no counted total gets the pulsing track instead of a
            made-up number. A fake percentage that jumps to 100 and sits there
            is worse than admitting we do not know. */}
        {determinate ? (
          <ProgressBar percent={Math.min(100, Math.round((written / total) * 100))} />
        ) : (
          <div aria-hidden className="h-1.5 w-full animate-pulse rounded-full bg-bg-subtle" />
        )}
        <div className="text-xs text-muted">
          {job.status === "packaging"
            ? "Preparing your file"
            : determinate
              ? `${written.toLocaleString()} of ${total.toLocaleString()}`
              : `${written.toLocaleString()} rows`}
        </div>
      </div>
    );
  }
  if (job.status === "queued") {
    return (
      <div className="min-w-[9rem] space-y-1">
        <div aria-hidden className="h-1.5 w-full animate-pulse rounded-full bg-bg-subtle" />
        <div className="text-xs text-muted">Waiting to start</div>
      </div>
    );
  }
  if (job.status === "failed") {
    return (
      <div className="space-y-1">
        {/* `danger` is the console's error ORANGE, not red - red means MISSED
            and only missed. StatusChip's header sets out why. */}
        <StatusChip tone="danger">Failed</StatusChip>
        {job.error ? <div className="text-xs text-muted">{job.error}</div> : null}
      </div>
    );
  }
  if (job.status === "ready") return <StatusChip tone="solid">Ready</StatusChip>;
  if (job.status === "expired") return <StatusChip tone="muted">Expired</StatusChip>;
  if (job.status === "cancelled") return <StatusChip tone="muted">Cancelled</StatusChip>;
  return <StatusChip tone="muted">{job.status}</StatusChip>;
}

/** "This view - Leads", "Everything in Sales", "Priya - Calls", "Whole workspace". */
function whatLabel(job: ExportJobRow): string {
  // 0188 first: on a person export, WHOSE data it was is the most important
  // thing on the line, so it leads rather than trailing the dataset name.
  // `subject_label` is the name frozen at enqueue, so this row still reads
  // correctly after a rename - or after the identity is deleted entirely.
  if (job.scope === "person") {
    return `${job.subject_label ?? "A person"} - ${capitalise(job.datasets[0] ?? "data")}`;
  }
  if (job.scope === "bulk") return "Whole workspace";
  if (job.scope === "section") return `Everything in ${capitalise(job.section ?? "a section")}`;
  return `This view - ${capitalise(job.datasets[0] ?? "data")}`;
}

function rowsLabel(job: ExportJobRow): string {
  const written = Number(job.rows_written);
  if (written > 0) return written.toLocaleString();
  const total = job.rows_total === null ? null : Number(job.rows_total);
  return total ? `~${total.toLocaleString()}` : "-";
}

/**
 * An expired, failed or cancelled job keeps its row and its counts, greyed,
 * with Run again beside it. The history is worth more than the file.
 */
function canRunAgain(job: ExportJobRow): boolean {
  return ["failed", "expired", "cancelled"].includes(job.status);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}
