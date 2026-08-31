import { PageHeader } from "@/components/page-header";
import { FormCardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@aura/ui";

/** Mirrors messaging-setup/page.tsx: intro copy, then the Wasi channel form. */
export default function MessagingSetupLoading() {
  return (
    <>
      <PageHeader title="WhatsApp Setup" context="Settings" />
      <Skeleton className="h-3.5 w-full max-w-2xl" />
      <Skeleton className="h-3.5 w-2/3 max-w-2xl" />
      <FormCardSkeleton fields={3} />
    </>
  );
}
