import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { StatGridSkeleton } from "@/components/skeletons";

/**
 * Mirrors the drill-down: the three summary cards, six KPI tiles, the two
 * distribution cards.
 *
 * The heading is left blank rather than guessed - this loader cannot know
 * whose page it is, and a placeholder name that swapped for a different one on
 * arrival would be worse than a bar.
 */
export default function TelecallerPerformanceLoading() {
  return (
    <>
      <PageHeader title="Performance" context="Reports" />
      <Skeleton className="h-11 w-64 rounded-lg" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
      <Skeleton className="h-3.5 w-16" />
      <StatGridSkeleton count={6} columns={3} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </>
  );
}
