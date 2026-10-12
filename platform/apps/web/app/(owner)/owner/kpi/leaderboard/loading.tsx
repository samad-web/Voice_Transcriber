import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TablePanelSkeleton } from "@/components/skeletons";

/** Mirrors the leaderboard: period control, then one wide ranked table. */
export default function LeaderboardLoading() {
  return (
    <>
      <PageHeader title="Leaderboard" context="Reports" />
      <IntroSkeleton lines={1} />
      <Skeleton className="h-11 w-64 rounded-lg" />
      <Skeleton className="h-4 w-80" />
      <TablePanelSkeleton columns={7} rows={8} />
      <Skeleton className="h-28 rounded-xl" />
    </>
  );
}
