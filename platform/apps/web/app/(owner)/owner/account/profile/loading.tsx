import { PageHeader } from "@/components/page-header";
import { FormCardSkeleton } from "@/components/skeletons";

/** Mirrors account/profile/page.tsx: details, password, preferences - three cards. */
export default function ProfileLoading() {
  return (
    <>
      <PageHeader title="Profile" context="Account" />
      <FormCardSkeleton fields={5} />
      <FormCardSkeleton fields={3} />
      <FormCardSkeleton fields={2} />
    </>
  );
}
