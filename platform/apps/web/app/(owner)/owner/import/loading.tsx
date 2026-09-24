import { PageHeader } from "@/components/page-header";
import { EntityPickerSkeleton } from "@/components/skeletons";

/**
 * Mirrors import/page.tsx's opening step: the channel strip, then pick contacts,
 * accounts, or deals.
 */
export default function ImportLoading() {
  return (
    <>
      <PageHeader title="Import" context="Leads" />
      <EntityPickerSkeleton />
    </>
  );
}
