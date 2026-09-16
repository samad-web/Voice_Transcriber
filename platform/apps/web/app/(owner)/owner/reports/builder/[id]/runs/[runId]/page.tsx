import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import type { ReportDoc } from "@aura/shared";
import { PageHeader } from "@/components/page-header";
import { LocalTime } from "@/components/local-time";
import { ownerGet } from "@/lib/owner-context";
import type { WidgetResult } from "../../../chart-surface";
import { FrozenReport } from "./frozen-report";

export const metadata: Metadata = { title: "Report run" };

interface RunResponse {
  run: {
    id: string;
    status: "running" | "succeeded" | "partial" | "failed";
    error: string | null;
    started_at: string;
    snapshot: {
      doc: ReportDoc;
      widgets: Record<string, WidgetResult>;
      generatedAt: string;
    } | null;
  };
}

/**
 * One frozen run.
 *
 * This is where a scheduled report's notification lands. It renders the
 * SNAPSHOT - the document and the rows exactly as they were - not a fresh
 * query, which is the entire point: "the weekly numbers as they stood on
 * Monday" has to still say Monday's numbers on Thursday.
 *
 * Access was already re-checked against LIVE permissions by the API before the
 * snapshot was handed over (report-builder.controller.ts's `runDetail`), so a
 * person who has since lost access to the report cannot open an old run.
 */
export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  const data = await ownerGet<RunResponse>(`/v1/report-builder/${id}/runs/${runId}`);

  if (!data) notFound();
  const { run } = data;

  return (
    <>
      <PageHeader title="Report run" context="Report builder" />
      <div className="-mt-2 flex flex-wrap items-center gap-3 text-xs">
        <Link href={`/owner/reports/builder/${id}/runs`} className="text-accent-text hover:underline">
          ← All runs
        </Link>
        <Link href={`/owner/reports/builder/${id}`} className="text-accent-text hover:underline">
          Open the live report
        </Link>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonoLabel>
            Frozen <LocalTime iso={run.started_at} />
          </MonoLabel>
          <StatusChip
            tone={run.status === "succeeded" ? "solid" : run.status === "failed" ? "danger" : "outline"}
          >
            {run.status}
          </StatusChip>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          These are the numbers as they stood when this run happened - they will not change. Open
          the live report for today&rsquo;s.
        </p>
        {run.error ? <p className="mt-2 text-xs text-warning-text">{run.error}</p> : null}
      </Card>

      {run.snapshot ? (
        <FrozenReport doc={run.snapshot.doc} widgets={run.snapshot.widgets} />
      ) : (
        <Card>
          <p className="text-sm text-text-muted">
            This run produced no snapshot - it failed before any widget could be built.
          </p>
        </Card>
      )}
    </>
  );
}
