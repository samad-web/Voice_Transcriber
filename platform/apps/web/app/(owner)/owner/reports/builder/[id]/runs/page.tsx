import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { LocalTime } from "@/components/local-time";
import { ownerGet } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Report runs" };

interface RunRow {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  error: string | null;
  started_at: string;
  finished_at: string | null;
  schedule_id: string | null;
}

/**
 * Every time this report has been frozen.
 *
 * A run is the only place this feature keeps data (migration 0077), and this
 * page is where that becomes visible rather than implicit: somebody looking at
 * Monday's figures should be able to see that they ARE Monday's figures, and
 * when the next set is due.
 */
export default async function RunsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await ownerGet<{ runs: RunRow[] }>(`/v1/report-builder/${id}/runs`);

  return (
    <>
      <PageHeader title="Run history" context="Report builder" />

      <Card>
        <MonoLabel>Runs</MonoLabel>
        <p className="mt-1 text-xs text-text-muted">
          A run freezes the numbers as they stood at that moment - so a scheduled report and the
          person who opens it three days later see the same figures. Opening the live report always
          recomputes.
        </p>

        {!data || data.runs.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No runs yet"
              description="Use “Run now” in Share & schedule, or add a schedule so it happens on its own."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {data.runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <Link
                  href={`/owner/reports/builder/${id}/runs/${run.id}`}
                  className="min-w-0 flex-1 text-sm text-text hover:text-accent-text hover:underline"
                >
                  <LocalTime iso={run.started_at} />
                </Link>
                <StatusChip
                  tone={
                    run.status === "succeeded"
                      ? "solid"
                      : run.status === "failed"
                        ? "danger"
                        : "outline"
                  }
                >
                  {run.status}
                </StatusChip>
                <StatusChip tone="muted">{run.schedule_id ? "scheduled" : "manual"}</StatusChip>
                {run.error ? (
                  <span className="w-full text-[11px] text-warning-text">{run.error}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
