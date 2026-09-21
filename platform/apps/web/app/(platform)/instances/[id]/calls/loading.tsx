import { Skeleton } from "@aura/ui";
import {
  PageHeaderSkeleton,
  StatGridSkeleton,
  TableBlockSkeleton,
  TabsSkeleton,
} from "@/components/skeletons";

/**
 * Mirrors instances/[id]/calls/page.tsx: the tenant-named header and the "Back
 * to <tenant>" link (both fetched), three KPI tiles, the pipeline-status filter
 * chips, the result count, then the call log - a call cell (name over id and
 * history), date over time, device, duration, source, consent and a pipeline
 * chip. The per-instance filter row only exists for a tenant with several
 * instances, so it is left out.
 */
export default function InstanceCallsLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Instance" />

      <div className="flex h-5 items-center gap-1.5">
        <Skeleton className="size-3.5 shrink-0" />
        <Skeleton className="h-3.5 w-36" />
      </div>

      <StatGridSkeleton count={3} columns={3} />

      <div className="space-y-2">
        <div className="flex h-4 items-center">
          <Skeleton className="h-2.5 w-24" />
        </div>
        <TabsSkeleton variant="pill" tabs={6} />
      </div>

      <div className="flex h-4 items-center">
        <Skeleton className="h-3 w-40" />
      </div>

      <TableBlockSkeleton
        variant="ledger"
        columns={["primary2", "date", "text", "num", "text", "text", "chip"]}
        rows={6}
      />
    </>
  );
}
