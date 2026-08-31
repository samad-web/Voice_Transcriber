import { PageHeader } from "@/components/page-header";
import { KanbanSkeleton } from "@/components/skeletons";

/** Mirrors deals/page.tsx: the deal pipeline board, same shape as the lead board. */
export default function DealsLoading() {
  return (
    <>
      <PageHeader title="Deals" context="Pipeline" />
      <KanbanSkeleton columns={5} />
    </>
  );
}
