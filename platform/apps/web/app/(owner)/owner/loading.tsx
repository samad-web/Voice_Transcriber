import { Card, Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { ChartCardSkeleton, PageHeaderSkeleton } from "@/components/skeletons";

// Literal Tailwind classes, not computed ones - Tailwind v4 only generates CSS
// for class names it can see statically in source.
const STAGE_BAR_WIDTHS = ["w-full", "w-3/4", "w-1/2", "w-1/3", "w-1/5"];
const HEAT_ROWS = [0, 1, 2, 3, 4, 5, 6];
const HEAT_COLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const SIX = [0, 1, 2, 3, 4, 5];
const FIVE = [0, 1, 2, 3, 4];
const FOUR = [0, 1, 2, 3];

/**
 * The dashboard's own skeleton, mirroring the CEO layout at its fullest - the
 * OWNER composition, which is the only one that draws every band (Build
 * docs/46, and docs/29 §9 for the rule).
 *
 * The geometry is measured against the real panels, not approximated: the KPI
 * band is six p-4 cards and not four p-6 ones, the pace chart is its two 96px
 * panes plus the 28px gap and the axis row, and the donut band is four cards
 * with a 112px ring. A loader whose blocks are the wrong size is worse than
 * none - the page visibly jumps when it swaps in, which is the exact flicker
 * a loader exists to prevent.
 *
 * Next actions is left out, as before: it is a client panel that fetches after
 * the page is up and draws its own inline loader.
 */
export default function DashboardLoading() {
  return (
    <>
      <PageHeaderSkeleton context="CEO analytics" />

      <DateRangeBarSkeleton />
      <DateRangeSummarySkeleton />

      {/* The six KPI tiles - plain surfaces, no icon, 16px padding. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {SIX.map((i) => (
          <Card key={i} className="flex flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-8 rounded-full" />
            </div>
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-24" />
          </Card>
        ))}
      </div>

      {/* The series strip: four toggles and the grain control. */}
      <Card className="grid grid-cols-1 gap-px overflow-hidden bg-border p-0 sm:grid-cols-2 lg:grid-cols-5">
        {FIVE.map((i) => (
          <div key={i} className="space-y-2 bg-surface p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-14" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </Card>

      {/* The pace chart: one 180px plot plus the shared axis row. */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-[204px] w-full" />
        <div className="flex gap-4">
          {FOUR.map((i) => (
            <Skeleton key={i} className="h-3 w-24" />
          ))}
        </div>
        <Skeleton className="h-4 w-96" />
      </Card>

      {/* Needs you: a header and four ranked rows. */}
      <Card className="space-y-3">
        <Skeleton className="h-3 w-48" />
        {FOUR.map((i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </Card>

      {/* Who drives the business: four donut cards under one band heading. */}
      <Skeleton className="h-5 w-56" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {FOUR.map((i) => (
          <Card key={i} className="space-y-4">
            <Skeleton className="h-3 w-28" />
            <div className="flex items-center gap-4">
              <Skeleton className="h-28 w-28 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                {[0, 1, 2].map((r) => (
                  <Skeleton key={r} className="h-3 w-full" />
                ))}
              </div>
            </div>
            <Skeleton className="h-3 w-40" />
          </Card>
        ))}
      </div>

      {/* Telecaller performance: five small multiples. */}
      <Skeleton className="h-5 w-48" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {FIVE.map((i) => (
          <Card key={i} className="space-y-3">
            <Skeleton className="h-3 w-24" />
            {FOUR.map((r) => (
              <div key={r} className="space-y-1">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-1.5 w-full rounded-full" />
              </div>
            ))}
          </Card>
        ))}
      </div>

      {/* Effort vs yield beside the conversion funnel. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="space-y-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-[200px] w-full rounded-sm" />
          <Skeleton className="h-4 w-full" />
        </Card>
        <Card className="space-y-4">
          <Skeleton className="h-3 w-40" />
          {FIVE.map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-24 shrink-0" />
              <Skeleton className="h-6 min-w-0 flex-1" />
              <Skeleton className="h-4 w-14 shrink-0" />
            </div>
          ))}
        </Card>
      </div>

      {/* The missed heatmap beside the call outcome split. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
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

      {/* Response speed beside open leads by age. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCardSkeleton kind="progress" />
        <ChartCardSkeleton kind="bars" height="h-32" />
      </div>

      {/* Pipeline health. */}
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

      {/* Source effectiveness. */}
      <Card className="space-y-3">
        <Skeleton className="h-3 w-44" />
        {FOUR.map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </Card>

      {/* The three scenarios. */}
      <Card className="space-y-3">
        <Skeleton className="h-3 w-56" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-8 w-44 shrink-0" />
            <Skeleton className="h-6 min-w-0 flex-1" />
            <Skeleton className="h-4 w-14 shrink-0" />
          </div>
        ))}
        <Skeleton className="h-4 w-full" />
      </Card>

      {/* Cash & collections - six figure tiles. */}
      <Card className="space-y-4">
        <Skeleton className="h-3 w-40" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {SIX.map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-3 w-80" />
      </Card>

      {/* Latest activity. */}
      <Card className="space-y-3">
        <Skeleton className="h-3 w-28" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </>
  );
}
