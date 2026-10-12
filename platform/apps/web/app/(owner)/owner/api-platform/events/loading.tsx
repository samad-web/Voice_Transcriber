import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TabsSkeleton } from "@/components/skeletons";

/** Status filters, the grouped-reasons card, then a list of event cards. */
export default function EventInspectorLoading() {
  return (
    <>
      <PageHeader title="Event inspector" context="API platform" />
      <IntroSkeleton lines={1} />
      <TabsSkeleton tabs={4} />
      <Skeleton className="h-44 rounded-xl" />
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-32 rounded-xl" />
      ))}
    </>
  );
}
