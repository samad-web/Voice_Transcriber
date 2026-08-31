import { PageHeader } from "@/components/page-header";
import { EntityPickerSkeleton } from "@/components/skeletons";

/** Mirrors import/page.tsx's opening step: pick contacts, accounts, or deals. */
export default function ImportLoading() {
  return (
    <>
      <PageHeader title="Bulk Import" context="Pipeline" />
      <EntityPickerSkeleton />
    </>
  );
}
