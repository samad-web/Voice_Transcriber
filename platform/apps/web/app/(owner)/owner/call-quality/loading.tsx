import { PageHeader } from "@/components/page-header";
import { MatchListSkeleton } from "@/components/skeletons";
import { Skeleton } from "@aura/ui";

/** Mirrors call-quality/page.tsx: helper line, then the flag review queue. */
export default function CallQualityLoading() {
  return (
    <>
      <PageHeader title="Call Quality" context="Pipeline" />
      <Skeleton className="-mt-2 h-3.5 w-[28rem] max-w-full" />
      <MatchListSkeleton />
    </>
  );
}
