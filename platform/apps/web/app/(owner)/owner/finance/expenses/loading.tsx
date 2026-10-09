import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { SectionHeadingSkeleton, TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors expenses/page.tsx: the month's heading, the fixed/variable pair, the
 * per-category bars, two filter tabs and the table.
 *
 * Five category bars rather than the real count, which nothing knows until the
 * summary read returns - and the summary is the one read on that page allowed
 * to fail without failing the page, so this placeholder is deliberately the
 * shape it takes when it succeeds.
 */
export default function ExpensesLoading() {
  return (
    <>
      <PageHeader title="Expenses" context="Sales" />
      <SectionHeadingSkeleton />
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
      <Skeleton className="h-36 w-full rounded-xl" />
      <div className="flex flex-wrap gap-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-7 w-32 rounded-md" />
        ))}
      </div>
      <TableBlockSkeleton
        columns={["text", "primary", "text", "num", "text", "chip"]}
        rows={6}
      />
    </>
  );
}
