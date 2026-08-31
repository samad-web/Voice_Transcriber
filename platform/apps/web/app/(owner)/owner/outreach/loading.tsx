import { PageHeader } from "@/components/page-header";
import { StatPlusListSkeleton } from "@/components/skeletons";

/** Mirrors outreach/page.tsx: a "due now" count card, then the follow-up ladder. */
export default function OutreachLoading() {
  return (
    <>
      <PageHeader title="Outreach" context="Pipeline" />
      <StatPlusListSkeleton statFirst />
    </>
  );
}
