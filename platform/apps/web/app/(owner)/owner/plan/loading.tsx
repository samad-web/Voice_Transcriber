import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** The plan card, the usage meters, the actions, then the comparison table. */
export default function PlanLoading() {
  return (
    <>
      <PageHeader title="Plan & usage" context="Settings" />
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
    </>
  );
}
