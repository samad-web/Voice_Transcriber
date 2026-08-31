import { PageHeader } from "@/components/page-header";
import { FilterTableSkeleton } from "@/components/skeletons";

/** Mirrors leads/page.tsx: stage/status filters, then a 5-column table. */
export default function LeadsLoading() {
  return (
    <>
      <PageHeader title="All Leads" context="Pipeline" />
      <FilterTableSkeleton pills={6} columns={5} />
    </>
  );
}
