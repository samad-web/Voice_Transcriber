import { PageHeader } from "@/components/page-header";
import { ChannelStripSkeleton, StatPlusListSkeleton } from "@/components/skeletons";

/**
 * Mirrors outreach/page.tsx: the channel strip, a "due now" count card, then the
 * follow-up ladder.
 */
export default function OutreachLoading() {
  return (
    <>
      <PageHeader title="Outreach" context="Pipeline" />
      <ChannelStripSkeleton active={1} />
      <StatPlusListSkeleton statFirst />
    </>
  );
}
