import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors superfone/page.tsx once a source is connected: a summary card (the
 * source name and status chip, the calls-received line, the mono intake URL and
 * the "these are call records, not recordings" note), then a "Recent calls"
 * card holding a 6-column log (when, caller, number, outcome, agent, lead).
 * The not-yet-connected state is a single form and is not drawn.
 */
export default function SuperfoneLoading() {
  return (
    <>
      <PageHeader title="Superfone" context="Superfone" />

      <Card className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-5.5 w-16 rounded-full" />
        </div>
        <div className="flex h-5 items-center">
          <Skeleton className="h-3.5 w-3/5" />
        </div>
        <div className="flex h-5 items-end">
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
        <div className="space-y-1.5 pt-1">
          <Skeleton className="h-3 w-full max-w-prose" />
          <Skeleton className="h-3 w-2/3 max-w-prose" />
        </div>
      </Card>

      <Card className="space-y-2">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-24" />
        </div>
        <TableBlockSkeleton columns={["date", "text", "text", "text", "text", "text"]} rows={6} />
      </Card>
    </>
  );
}
