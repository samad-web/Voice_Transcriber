import { PageHeader } from "@/components/page-header";
import { ChannelStripSkeleton, EntityPickerSkeleton } from "@/components/skeletons";

/**
 * Mirrors import/page.tsx's opening step: the channel strip, then pick contacts,
 * accounts, or deals.
 */
export default function ImportLoading() {
  return (
    <>
      <PageHeader title="Bulk Import" context="Pipeline" />
      <ChannelStripSkeleton active={4} />
      <EntityPickerSkeleton />
    </>
  );
}
