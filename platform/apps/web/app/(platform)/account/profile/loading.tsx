import { PageHeader } from "@/components/page-header";
import { ContentCardSkeleton, FormCardSkeleton } from "@/components/skeletons";

/** Mirrors (platform)/account/profile/page.tsx: the read-only email card, password, preferences. */
export default function OperatorProfileLoading() {
  return (
    <>
      <PageHeader title="Profile" context="Account" />
      <ContentCardSkeleton lines={2} />
      <FormCardSkeleton fields={3} />
      <FormCardSkeleton fields={2} />
    </>
  );
}
