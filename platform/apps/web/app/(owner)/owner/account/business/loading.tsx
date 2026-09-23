import { PageHeader } from "@/components/page-header";
import { FormCardSkeleton } from "@/components/skeletons";

/** Mirrors account/business/page.tsx: one card of six sections, about seventeen fields. */
export default function BusinessProfileLoading() {
  return (
    <>
      <PageHeader title="Business profile" context="Account" />
      <FormCardSkeleton fields={12} />
    </>
  );
}
