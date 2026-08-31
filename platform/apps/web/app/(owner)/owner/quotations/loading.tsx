import { PageHeader } from "@/components/page-header";
import { FilterTableSkeleton } from "@/components/skeletons";

/** Mirrors quotations/page.tsx: 6 status-filter pills plus the "New Quotation" button, then a 4-column table. */
export default function QuotationsLoading() {
  return (
    <>
      <PageHeader title="Quotations" context="Pipeline" />
      <FilterTableSkeleton pills={6} columns={4} withAction />
    </>
  );
}
