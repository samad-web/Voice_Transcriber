import { PageHeader } from "@/components/page-header";
import { TwoPaneSkeleton } from "@/components/skeletons";

/** Mirrors inbox/page.tsx: the channel strip, then the thread-list-beside-conversation layout. */
export default function InboxLoading() {
  return (
    <>
      <PageHeader title="Chats" context="Conversations" />
      <TwoPaneSkeleton />
    </>
  );
}
