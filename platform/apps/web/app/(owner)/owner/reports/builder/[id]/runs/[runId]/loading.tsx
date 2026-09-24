import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { CanvasTileSkeleton } from "@/components/skeletons";

/**
 * Mirrors reports/builder/[id]/runs/[runId]/page.tsx: the link tucked under the
 * header (open the live report), a "Frozen at ..." card with its
 * status chip and explanation, then the run's snapshot: one card per report
 * page, holding the page name over the same 12-column tile canvas the editor
 * uses (a row of KPI tiles, two charts, a wide table).
 */
export default function RunDetailLoading() {
  return (
    <>
      <PageHeader title="Report run" context="Custom reports" />
      <div className="-mt-2 flex h-4 items-center gap-3">
        <Skeleton className="h-3 w-32" />
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-3 w-44" />
          <Skeleton className="h-5.5 w-20 rounded-full" />
        </div>
        <div className="mt-1">
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-full" />
          </div>
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex h-4 items-center">
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="grid grid-cols-12 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <CanvasTileSkeleton key={i} kpi className="col-span-3 h-32" />
          ))}
          <CanvasTileSkeleton className="col-span-6 h-64" />
          <CanvasTileSkeleton className="col-span-6 h-64" />
          <CanvasTileSkeleton className="col-span-12 h-48" />
        </div>
      </Card>
    </>
  );
}
