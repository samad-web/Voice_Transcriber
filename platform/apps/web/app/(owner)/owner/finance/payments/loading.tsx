import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/** Mirrors payments/page.tsx: three filter tabs, then the payment table. */
export default function PaymentsLoading() {
  return (
    <>
      <PageHeader title="Payments" context="Sales" />
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7 w-32 rounded-md" />
        ))}
      </div>
      <TableBlockSkeleton
        columns={["text", "primary", "text", "num", "chip", "text"]}
        rows={8}
      />
    </>
  );
}
