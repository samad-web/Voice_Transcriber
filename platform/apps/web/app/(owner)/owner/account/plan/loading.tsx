import { PageHeader } from "@/components/page-header";
import { ContentCardSkeleton, SectionHeadingSkeleton, StatGridSkeleton } from "@/components/skeletons";

/** Mirrors account/plan/page.tsx: plan card, storage card, then "This month" and its five tiles. */
export default function PlanUsageLoading() {
  return (
    <>
      <PageHeader title="Plan & usage" context="Account" />
      <ContentCardSkeleton lines={3} />
      <ContentCardSkeleton lines={4} />
      <SectionHeadingSkeleton subtitle={false} />
      <StatGridSkeleton count={5} columns={3} />
    </>
  );
}
