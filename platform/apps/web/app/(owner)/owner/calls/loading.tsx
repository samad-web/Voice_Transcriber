import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors calls/page.tsx: an intro line, then calls-explorer.tsx's own filter
 * bar - a search box beside the date dropdown (both 38px, `h-9.5`), the active
 * filter tags (omitted here: nothing is selected yet), the Status/Feeling/
 * Direction selects and the Advanced filters button (all `h-8`) - and a
 * 6-column log: When (relative time over the exact one), Contact (name over
 * its state chip), Length, Telecaller, The AI read, Lead.
 */
export default function CallsLoading() {
  return (
    <>
      <PageHeader title="Calls" context="Conversations" />
      <Skeleton className="-mt-2 h-3.5 w-[40rem] max-w-full" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Skeleton className="h-9.5 w-full rounded-sm sm:min-w-48 sm:flex-1" />
        <Skeleton className="h-9.5 w-40 shrink-0 rounded-sm" />
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Skeleton className="h-8 w-36 rounded-sm" />
        <Skeleton className="h-8 w-32 rounded-sm" />
        <Skeleton className="h-8 w-36 rounded-sm" />
        <Skeleton className="h-8 w-32 rounded-full" />
      </div>
      <TableBlockSkeleton columns={["primary2", "primary2", "num", "text", "chip", "text"]} />
    </>
  );
}
