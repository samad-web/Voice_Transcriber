import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors documents/page.tsx: the gap card, five expiry filters, then one
 * table per document group - document, number, expires, status, owner, file.
 *
 * Two table blocks, not one: the vault renders a card per §1 group, and a
 * single block would collapse to the right height only for a tenant whose
 * documents all sit in one group.
 */
export default function DocumentsLoading() {
  return (
    <>
      <PageHeader title="Documents" context="Sales" />
      <Skeleton className="h-20 w-full rounded-lg" />
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-7 w-28 rounded-md" />
        ))}
      </div>
      <TableBlockSkeleton columns={["primary", "text", "text", "chip", "text", "text"]} rows={5} />
      <TableBlockSkeleton columns={["primary", "text", "text", "chip", "text", "text"]} rows={4} />
    </>
  );
}
