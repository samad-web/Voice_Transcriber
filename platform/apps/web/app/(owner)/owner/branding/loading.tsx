import { PageHeader } from "@/components/page-header";
import { FormCardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@aura/ui";

/** Mirrors branding/page.tsx: intro copy, then a form (logo, primary/secondary color, browser title). */
export default function BrandingLoading() {
  return (
    <>
      <PageHeader title="Branding" context="Settings" />
      <Skeleton className="h-3.5 w-full max-w-2xl" />
      <FormCardSkeleton fields={4} />
    </>
  );
}
