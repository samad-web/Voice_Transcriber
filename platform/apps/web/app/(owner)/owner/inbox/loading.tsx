import { PageHeader } from "@/components/page-header";
import { ChannelStripSkeleton, TwoPaneSkeleton } from "@/components/skeletons";

/** Mirrors inbox/page.tsx: the channel strip, then the thread-list-beside-conversation layout. */
export default function InboxLoading() {
  return (
    <>
      <PageHeader title="Inbox" context="Pipeline" />
      <ChannelStripSkeleton active={0} />
      <TwoPaneSkeleton />
    </>
  );
}
