import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, StatGridSkeleton } from "@/components/skeletons";

/**
 * Mirrors kpi/page.tsx: the freshness strip, the period control, the score and
 * funnel pair, six KPI tiles, then the two performer cards.
 *
 * The counts are the OWNER's layout - six tiles because the plan ceiling is
 * six - so the page shrinks on arrival rather than growing, which is the rule
 * every loader in this console follows.
 */
export default function KpiOverviewLoading() {
  return (
    <>
      <PageHeader title="Performance" context="Reports" />
      <IntroSkeleton lines={1} />
      <Skeleton className="h-10 w-full rounded-lg" />
      <Skeleton className="h-11 w-64 rounded-lg" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl lg:col-span-2" />
      </div>
      <Skeleton className="h-3.5 w-24" />
      <StatGridSkeleton count={6} columns={3} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    </>
  );
}
