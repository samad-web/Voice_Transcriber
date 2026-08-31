import { PageHeader } from "@/components/page-header";
import { SearchTableSkeleton } from "@/components/skeletons";

/** Mirrors products/page.tsx: search box, then a 5-column table (Name, SKU, Price, Tax, Status). */
export default function ProductsLoading() {
  return (
    <>
      <PageHeader title="Products" context="Pipeline" />
      <SearchTableSkeleton columns={5} />
    </>
  );
}
