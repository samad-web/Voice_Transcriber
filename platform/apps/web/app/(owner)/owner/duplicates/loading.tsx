import { PageHeader } from "@/components/page-header";
import { MatchListSkeleton } from "@/components/skeletons";
import { Skeleton } from "@aura/ui";

/** Mirrors duplicates/page.tsx: helper line, scan buttons, then the pending-match queue. */
export default function DuplicatesLoading() {
  return (
    <>
      <PageHeader title="Duplicates" context="Pipeline" />
      <Skeleton className="-mt-2 h-3.5 w-96 max-w-full" />
      <MatchListSkeleton />
    </>
  );
}
