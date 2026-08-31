import { PageHeader } from "@/components/page-header";
import { StatGridSkeleton, TableBlockSkeleton } from "@/components/skeletons";
import { Card, Skeleton } from "@aura/ui";

/**
 * Mirrors reports/page.tsx: the 4-stat summary row, an against-target card of
 * progress bars, four report cards (forecast by stage, conversion funnel,
 * rep performance, commission) each with their own export link and
 * table/bars, then the commission-plans settings panel.
 */
export default function ReportsLoading() {
  return (
    <>
      <PageHeader title="Reports" context="Pipeline" />
      <StatGridSkeleton count={4} />

      <Card className="space-y-3">
        <Skeleton className="h-3 w-32" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        ))}
      </Card>

      {["Forecast by stage", "Conversion funnel", "Rep performance", "Commission"].map((label) => (
        <Card key={label} className="space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-16" />
          </div>
          <TableBlockSkeleton columns={5} rows={4} />
        </Card>
      ))}

      <Card className="space-y-3">
        <Skeleton className="h-3 w-36" />
        <TableBlockSkeleton columns={4} rows={3} />
      </Card>
    </>
  );
}
