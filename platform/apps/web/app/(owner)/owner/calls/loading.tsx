import { PageHeader } from "@/components/page-header";
import { FilterTableSkeleton } from "@/components/skeletons";

/** Mirrors calls/page.tsx: four filter rows, then a 6-column log. */
export default function CallsLoading() {
  return (
    <>
      <PageHeader title="Calls" context="Pipeline" />
      <FilterTableSkeleton pills={8} columns={6} />
    </>
  );
}
