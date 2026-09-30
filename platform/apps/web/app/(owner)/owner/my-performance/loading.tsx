import { Card, Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";

/**
 * Mirrors my-performance/page.tsx: the shared date control, the headline
 * sentence, today's tracker, THREE four-tile rows (output, pipeline and
 * follow-ups, quality), the work queue, the daily strip, the two half-width
 * quality panels, and the two note cards.
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

      {/* Today: label + connected count, the big number and its caption, the
          bar, then the line naming what the bar is measured against. Rendered
          unconditionally although the real panel hides itself outside the
          current range - on a first paint the range is almost always one that
          contains today, and a missing block that then appears reads worse than
          a block that resolves to nothing. */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="flex items-baseline gap-2">
          <Skeleton className="h-8 w-12" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
        <Skeleton className="h-3 w-3/4" />
      </Card>

      <TileRow />
      <TileRow />
      <TileRow />

      {/* What is waiting: label + the load line, then three queue rows of a
          title over a detail sentence, with a trailing "Open" link. */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-56" />
        </div>
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start justify-between gap-3">
              <div className="flex-1 space-y-1">
                <Skeleton className="h-3.5 w-52" />
                <Skeleton className="h-3.5 w-full" />
              </div>
              <Skeleton className="h-3.5 w-10 shrink-0" />
            </div>
          ))}
        </div>
      </Card>

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
