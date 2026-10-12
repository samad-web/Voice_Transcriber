import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TablePanelSkeleton } from "@/components/skeletons";

/** Mirrors the team roll-up: period control, one table, one locked-preview card. */
export default function TeamPerformanceLoading() {
  return (
    <>
      <PageHeader title="Team performance" context="Reports" />
      <IntroSkeleton lines={1} />
      <Skeleton className="h-11 w-64 rounded-lg" />
      <Skeleton className="h-4 w-80" />
      <TablePanelSkeleton columns={6} rows={5} />
      <Skeleton className="h-24 rounded-xl" />
    </>
  );
}
