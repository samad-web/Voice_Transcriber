import { PageHeader } from "@/components/page-header";
import { KanbanSkeleton } from "@/components/skeletons";

/** Mirrors deals/page.tsx: the deal pipeline board, same shape as the lead board. */
export default function DealsLoading() {
  return (
    <>
      <PageHeader title="Deals" context="Sales" />
      <KanbanSkeleton columns={5} />
    </>
  );
}
