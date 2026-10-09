import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors dues/page.tsx: the six age filters, then the table - customer,
 * instalment, due date, owed, state, promised.
 *
 * Six pills rather than a guess: the buckets are a fixed list
 * (`AGING_BUCKETS` plus All), so this is the real count and not a placeholder
 * that resizes when the data arrives.
 */
export default function DuesLoading() {
  return (
    <>
      <PageHeader title="Dues to chase" context="Sales" />
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-7 w-28 rounded-md" />
        ))}
      </div>
      <TableBlockSkeleton
        columns={["primary", "text", "text", "num", "chip", "text"]}
        rows={8}
      />
    </>
  );
}
