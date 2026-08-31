import { PageHeader } from "@/components/page-header";
import { FilterTableSkeleton } from "@/components/skeletons";

/** Mirrors invoices/page.tsx: 6 status-filter pills, then a 5-column table. */
export default function InvoicesLoading() {
  return (
    <>
      <PageHeader title="Invoices" context="Pipeline" />
      <FilterTableSkeleton pills={6} columns={5} />
    </>
  );
}
