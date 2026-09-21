import { PageHeader } from "@/components/page-header";
import { FilterTableSkeleton } from "@/components/skeletons";

/**
 * Mirrors quotations/page.tsx: 6 status pills (All, Draft, Sent, Accepted,
 * Rejected, Expired) with the "New Quotation" button to their right, then a
 * 4-column table: Number, Status, Total, Valid until.
 */
export default function QuotationsLoading() {
  return (
    <>
      <PageHeader title="Quotations" context="Pipeline" />
      <FilterTableSkeleton pills={6} columns={["primary", "chip", "num", "date"]} withAction />
    </>
  );
}
