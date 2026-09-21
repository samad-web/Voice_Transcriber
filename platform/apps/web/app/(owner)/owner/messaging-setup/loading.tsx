import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ChannelStripSkeleton, FormCardSkeleton } from "@/components/skeletons";

/**
 * Mirrors messaging-setup/page.tsx: the channel strip, intro copy, then the Wasi
 * channel form.
 */
export default function MessagingSetupLoading() {
  return (
    <>
      <PageHeader title="WhatsApp Setup" context="Settings" />
      <ChannelStripSkeleton active={3} />
      <Skeleton className="h-3.5 w-full max-w-2xl" />
      <Skeleton className="h-3.5 w-2/3 max-w-2xl" />
      <FormCardSkeleton fields={3} />
    </>
  );
}
