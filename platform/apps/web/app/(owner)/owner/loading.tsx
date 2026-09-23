import { Card, Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { ChartCardSkeleton, PageHeaderSkeleton, StatGridSkeleton } from "@/components/skeletons";

// Literal Tailwind classes, not computed ones - Tailwind v4 only generates CSS
// for class names it can see statically in source.
const STAGE_BAR_WIDTHS = ["w-full", "w-3/4", "w-1/2", "w-1/3", "w-1/5"];
const HEAT_ROWS = [0, 1, 2, 3, 4, 5, 6];
const HEAT_COLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/**
 * The dashboard's own skeleton, mirroring owner/page.tsx's OWNER composition at
 * its fullest (Build docs/29 §9): the shared date control and its date line, the KPI
 * band drawn as the solid fill, the two-plot trend card at its real plot
 * heights (160 + 12 + 96), the heatmap beside call outcomes, the pipeline
 * rows, aging beside response, the telecaller table and the recent list.
 *
 * Next actions is left out, as before: it is a client panel that fetches after
 * the page is up and draws its own inline loader.
 */
export default function DashboardLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Instance" />

      <DateRangeBarSkeleton />
      <DateRangeSummarySkeleton />

      <StatGridSkeleton count={4} />

      <Card className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <div className="flex gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-3 w-20" />
          ))}
        </div>
        <Skeleton className="h-[268px] w-full" />
        <Skeleton className="h-4 w-80" />
      </Card>

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <Card className="space-y-4">
          <Skeleton className="h-3 w-48" />
          <div className="space-y-[2px]">
            {HEAT_ROWS.map((r) => (
              <div key={r} className="flex gap-[2px]">
                {HEAT_COLS.map((c) => (
                  <Skeleton key={c} className="h-5 flex-1" />
                ))}
              </div>
            ))}
          </div>
          <Skeleton className="h-3 w-72" />
        </Card>
        <Card className="space-y-4">
          <Skeleton className="h-3 w-32" />
          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-7 w-12" />
                <Skeleton className="h-3 w-24" />
              </div>
            ))}
          </div>
          <Skeleton className="h-2.5 w-full" />
        </Card>
      </div>

      <Card className="space-y-4">
        <Skeleton className="h-3 w-40" />
        {STAGE_BAR_WIDTHS.map((w, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-24" />
            <div className="min-w-0 flex-1">
              <Skeleton className={`h-4 ${w}`} />
            </div>
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </Card>

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <ChartCardSkeleton kind="bars" height="h-32" />
        <ChartCardSkeleton kind="progress" />
      </div>

      <Card className="space-y-3">
        <Skeleton className="h-3 w-40" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </Card>

      <Card className="space-y-3">
        <Skeleton className="h-3 w-28" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </>
  );
}
