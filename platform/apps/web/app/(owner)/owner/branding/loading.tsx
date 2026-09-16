import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FormCardSkeleton } from "@/components/skeletons";

/** Mirrors branding/page.tsx: intro copy, then the seven-field form (three images, three colours, tab title). */
export default function BrandingLoading() {
  return (
    <>
      <PageHeader title="Branding" context="Settings" />
      <Skeleton className="h-3.5 w-full max-w-2xl" />
      <FormCardSkeleton fields={7} />
    </>
  );
}
