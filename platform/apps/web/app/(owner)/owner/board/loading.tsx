import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { KanbanSkeleton } from "@/components/skeletons";

/**
 * Mirrors board/page.tsx: the helper line with Manage boards / New lead beside
 * it, then the drag-and-drop stage columns. The board switcher is not drawn -
 * most orgs have one board and never see it.
 */
export default function BoardLoading() {
  return (
    <>
      <PageHeader title="Lead board" context="Leads" />
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-3.5 w-72" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </div>
      <KanbanSkeleton columns={5} />
    </>
  );
}
