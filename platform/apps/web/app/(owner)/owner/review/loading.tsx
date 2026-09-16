import { PageHeader } from "@/components/page-header";
import { MatchListSkeleton } from "@/components/skeletons";

/** Mirrors review/page.tsx: the source tabs, then a list of cards. */
export default function ReviewLoading() {
  return (
    <>
      <PageHeader title="Review queue" context="Pipeline" />
      <MatchListSkeleton />
    </>
  );
}
