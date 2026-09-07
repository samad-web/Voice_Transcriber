import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { KanbanSkeleton } from "@/components/skeletons";

/** Mirrors board/page.tsx: helper line, then the drag-and-drop stage columns. */
export default function BoardLoading() {
  return (
    <>
      <PageHeader title="Lead Board" context="Pipeline" />
      <Skeleton className="-mt-2 h-3.5 w-72" />
      <KanbanSkeleton columns={5} />
    </>
  );
}
