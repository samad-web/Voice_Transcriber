import { Card, Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors performance/page.tsx: the shared date control, the headline line,
 * two four-tile rows, the targets card, then the campaign, channel and floor
 * tables.
 *
 * Geometry is measured against the real page rather than guessed - a skeleton
 * whose blocks land somewhere else than the content reads as the page jumping
 * rather than as it arriving.
 */
function TileRow() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-28" />
        </Card>
      ))}
    </div>
  );
}

export default function PerformanceLoading() {
  return (
    <>
      <PageHeader title="Performance" context="Reports" />

      <DateRangeBarSkeleton />
      <DateRangeSummarySkeleton />

      <Skeleton className="h-4 w-72" />

      <TileRow />
      <TileRow />

      {/* The funnel: label + the velocity line, then one row per open stage -
          a label/count pair over a 12px bar - and the insight sentence. Four
          stages, which is the default pipeline's open count (New, Contacted,
          Qualified, Negotiation); a tenant with more gets a slightly short
          skeleton, which is the right way round to be wrong. */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-3 w-48" />
        </div>
        <div className="space-y-3">
          {["w-full", "w-4/5", "w-3/5", "w-2/5"].map((w, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3.5 w-28" />
              </div>
              <div className="h-3 w-full rounded-sm bg-border/60">
                <Skeleton className={`h-3 rounded-sm ${w}`} />
              </div>
              {i > 0 ? <Skeleton className="h-3 w-52" /> : null}
            </div>
          ))}
        </div>
        <Skeleton className="h-4 w-3/4" />
      </Card>

      {/* Targets: a label, then two rows of name + bar + caption. */}
      <Card className="space-y-4">
        <Skeleton className="h-3 w-32" />
        {[0, 1].map((i) => (
          <div key={i} className="space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-24" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </Card>

      {/* Campaigns: seven columns, a name then six figures. */}
      <TableBlockSkeleton
        columns={["primary", "num", "num", "num", "num", "num", "num"]}
        rows={5}
      />
      {/* Channels: five. */}
      <TableBlockSkeleton columns={["primary", "num", "num", "num", "num"]} rows={3} />
      {/* The floor: six. */}
      <TableBlockSkeleton columns={["primary", "num", "num", "num", "num", "num"]} rows={5} />
    </>
  );
}
