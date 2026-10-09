import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { SectionHeadingSkeleton, StatGridSkeleton } from "@/components/skeletons";

/**
 * Mirrors forecast/page.tsx: three horizon tabs, the low/base/high trio, the
 * band chart, and the assumptions card.
 *
 * The low-confidence banner is NOT drawn. It appears only when the forecast
 * says so, and a placeholder for it would promise a warning that may not
 * arrive - the same reasoning the resources loader gives for not drawing its
 * add form.
 */
export default function ForecastLoading() {
  return (
    <>
      <PageHeader title="Cash forecast" context="Sales" />
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-md" />
        ))}
      </div>
      <StatGridSkeleton count={3} columns={3} tone="plain" icons={false} />
      <SectionHeadingSkeleton />
      <Skeleton className="h-56 w-full rounded-xl" />
      <SectionHeadingSkeleton />
      <Skeleton className="h-48 w-full rounded-xl" />
    </>
  );
}
