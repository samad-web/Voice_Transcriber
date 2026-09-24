import { Card, Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";
import { ContentCardSkeleton } from "@/components/skeletons";

/**
 * Mirrors insights/page.tsx top to bottom: the intro line; the control row
 * (three range pills over the from/to form, the PDF button opposite); the range
 * echo; eight plain headline tiles; highlights; the call-volume chart; hours
 * beside the AI read; quality beside risk and dispositions; the team table; the
 * attention list; and the collapsed definitions.
 *
 * Drawn from the kit's primitives rather than the shared skeleton blocks on
 * purpose: those blocks are mid-rewrite in the working tree, and a loader
 * pinned to either version of their props would break on the other.
 */

const TILE_WIDTHS = ["w-14", "w-20", "w-16", "w-24", "w-20", "w-16", "w-24", "w-12"] as const;
const BAR_HEIGHTS = ["h-1/3", "h-2/3", "h-1/2", "h-3/4", "h-2/5", "h-4/5", "h-1/2", "h-3/5", "h-1/4", "h-2/3", "h-1/2", "h-3/4"] as const;

function TileSkeleton({ i }: { i: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
      <Skeleton className="h-3 w-24" />
      <Skeleton className={`mt-3 h-8 ${TILE_WIDTHS[i % TILE_WIDTHS.length]}`} />
      <Skeleton className="mt-2 h-3 w-32" />
      <Skeleton className="mt-1.5 h-3 w-40 max-w-full" />
    </div>
  );
}

function ChartSkeleton({ columns = 24 }: { columns?: number }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
        <Skeleton className="h-6 w-56 rounded-full" />
      </div>
      <div className="mt-3 flex h-40 items-end gap-[2px] border-b border-border">
        {Array.from({ length: columns }, (_, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center">
            <Skeleton className={`w-full max-w-6 rounded-b-none ${BAR_HEIGHTS[i % BAR_HEIGHTS.length]}`} />
          </div>
        ))}
      </div>
      <Skeleton className="mt-2 h-3 w-full" />
    </Card>
  );
}

function BarsSkeleton({ rows }: { rows: number }) {
  return (
    <Card>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-1.5 h-3 w-64 max-w-full" />
      <div className="mt-4 space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-3.5 w-28 shrink-0" />
            <Skeleton className="h-2 flex-1 rounded-full" />
            <Skeleton className="h-3.5 w-14 shrink-0" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function CallInsightsLoading() {
  return (
    <>
      <PageHeader title="Call summary" context="Reports" />
      <Skeleton className="-mt-2 h-3.5 w-[40rem] max-w-full" />

      <DateRangeBarSkeleton aside="w-64" />
      <DateRangeSummarySkeleton />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <TileSkeleton key={i} i={i} />
        ))}
      </div>

      <ContentCardSkeleton lines={5} />
      <ChartSkeleton columns={30} />

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartSkeleton />
        <BarsSkeleton rows={10} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <BarsSkeleton rows={7} />
        <div className="space-y-6">
          <BarsSkeleton rows={2} />
          <BarsSkeleton rows={4} />
        </div>
      </div>

      <BarsSkeleton rows={4} />
      <ContentCardSkeleton lines={6} />
      <Skeleton className="h-11 w-full rounded-lg" />
    </>
  );
}
