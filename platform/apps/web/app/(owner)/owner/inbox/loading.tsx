import { PageHeader } from "@/components/page-header";
import { TwoPaneSkeleton } from "@/components/skeletons";

/** Mirrors inbox/page.tsx: the thread-list-beside-conversation layout. */
export default function InboxLoading() {
  return (
    <>
      <PageHeader title="Inbox" context="Pipeline" />
      <TwoPaneSkeleton />
    </>
  );
}
