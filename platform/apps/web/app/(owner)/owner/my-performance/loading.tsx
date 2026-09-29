import { Card, Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";

/**
 * Mirrors my-performance/page.tsx: the shared date control, the headline
 * sentence, two four-tile rows, the daily strip, the two half-width quality
 * panels, and the two note cards.
 *
 * Geometry is measured against the real page rather than guessed, the rule the
 * console's other loaders follow - a skeleton whose blocks land somewhere else
 * than the content reads as the page jumping rather than as it arriving. The
 * empty-state card and the optional notes are left out: they appear for some
 * readers only, and a skeleton for a block that never comes is worse than none.
 */
function TileRow() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i} className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-3 w-28" />
        </Card>
      ))}
    </div>
  );
}

export default function MyPerformanceLoading() {
  return (
    <>
      <PageHeader title="My performance" context="Reports" />

      <DateRangeBarSkeleton />
      <DateRangeSummarySkeleton />

      <Skeleton className="h-4 w-64" />

      <TileRow />
      <TileRow />

      {/* The daily strip: label row, the 8rem plot, an insight line. */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-4 w-56" />
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="space-y-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="space-y-3">
              {[0, 1, 2].map((j) => (
                <div key={j} className="space-y-1.5">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-2 w-full rounded-full" />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      {[0, 1].map((i) => (
        <Card key={i} className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-3/4" />
        </Card>
      ))}
    </>
  );
}
