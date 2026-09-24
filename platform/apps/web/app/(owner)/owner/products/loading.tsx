import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton, ToolbarSkeleton } from "@/components/skeletons";

/**
 * Mirrors products/page.tsx: a search box, then products-client.tsx - the "New
 * Product" button on its own right-aligned row above a 5-column table: Name,
 * SKU, Price, Tax, Status.
 */
export default function ProductsLoading() {
  return (
    <>
      <PageHeader title="Price list" context="Sales" />
      <ToolbarSkeleton search />
      {/* products-client.tsx is one block that spaces its own button row and table (space-y-4). */}
      <div className="space-y-4">
        <div className="flex justify-end">
          <Skeleton className="h-10 w-28 rounded-full" />
        </div>
        <TableBlockSkeleton columns={["primary", "text", "num", "num", "chip"]} />
      </div>
    </>
  );
}
