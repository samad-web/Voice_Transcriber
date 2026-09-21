import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import {
  ChartCardSkeleton,
  StatGridSkeleton,
  TableBlockSkeleton,
  ToolbarSkeleton,
} from "@/components/skeletons";

/** The label on the left of a report card, and its Export CSV link on the right. */
function ReportHead({ exportLink = true }: { exportLink?: boolean }) {
  return (
    <div className="flex h-4 items-center justify-between gap-2">
      <Skeleton className="h-3 w-32" />
      {exportLink ? <Skeleton className="h-3 w-16" /> : null}
    </div>
  );
}

/** The `text-xs` note under a report's table: `lines` lines, the last one short. */
function FootnoteSkeleton({ lines }: { lines: number }) {
  return (
    <div className="mt-3 space-y-1">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={i === lines - 1 ? "h-3 w-2/3" : "h-3 w-full"} />
      ))}
    </div>
  );
}

/**
 * Mirrors reports/page.tsx, top to bottom: the date-range pills with the range
 * printed beside them; six metric cards; the pipeline-by-stage and leads-per-day
 * charts side by side; the against-target meters (only a tenant with targets set
 * has them); then the report cards - forecast by stage (a table), conversion
 * funnel (bars), rep performance (a table, its task chips and a note) and
 * commission (a table and a note) - and the commission-plans panel with its table.
 */
export default function ReportsLoading() {
  return (
    <>
      <PageHeader title="Reports" context="Pipeline" />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ToolbarSkeleton pills={3} />
        <Skeleton className="h-3 w-32" />
      </div>

      {/* MetricCard is a plain bordered card, not the filled KPI tile, and has no icon. */}
      <StatGridSkeleton count={6} columns={3} tone="plain" icons={false} />

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCardSkeleton kind="progress" />
        <ChartCardSkeleton kind="bars" />
      </div>

      {/* Against target */}
      <ChartCardSkeleton kind="progress" />

      {/* Forecast by stage */}
      <Card>
        <ReportHead />
        <div className="mt-2 flex h-4 items-center">
          <Skeleton className="h-3 w-3/4" />
        </div>
        <div className="mt-3">
          <TableBlockSkeleton columns={["text", "num", "num", "num", "num", "num"]} rows={5} />
        </div>
      </Card>

      {/* Conversion funnel */}
      <ChartCardSkeleton kind="progress" />

      {/* Rep performance */}
      <Card>
        <ReportHead />
        <div className="mt-3">
          <TableBlockSkeleton
            columns={["text", "num", "num", "num", "num", "num", "num"]}
            rows={4}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Skeleton className="h-6 w-36 rounded-full" />
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-40 rounded-full" />
        </div>
        <FootnoteSkeleton lines={2} />
      </Card>

      {/* Commission */}
      <Card>
        <ReportHead />
        <div className="mt-3">
          <TableBlockSkeleton columns={["text", "text", "num", "num"]} rows={3} />
        </div>
        <FootnoteSkeleton lines={3} />
      </Card>

      {/* Commission plans */}
      <Card>
        <ReportHead exportLink={false} />
        <div className="mt-3 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3 w-72 max-w-full" />
            <Skeleton className="h-8 w-20 shrink-0 rounded-full" />
          </div>
          <TableBlockSkeleton columns={["primary", "text", "num", "chip"]} rows={3} />
        </div>
      </Card>
    </>
  );
}
