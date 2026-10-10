import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors compliance/page.tsx: the CA-verification card, six status filters,
 * then the filings table - filing, period, due, status, owner, proof.
 *
 * Six pills rather than a guess: the statuses are a fixed list (All plus
 * ComplianceStatus's five), so this is the real count and the row does not
 * resize when the data arrives.
 */
export default function ComplianceLoading() {
  return (
    <>
      <PageHeader title="Compliance calendar" context="Sales" />
      <Skeleton className="h-16 w-full rounded-lg" />
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-7 w-28 rounded-md" />
        ))}
      </div>
      <TableBlockSkeleton
        columns={["primary", "text", "text", "chip", "text", "text"]}
        rows={10}
      />
    </>
  );
}
