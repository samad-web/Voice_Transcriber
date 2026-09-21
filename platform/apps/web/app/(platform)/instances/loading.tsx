import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors instances/page.tsx: intro copy beside the "New Instance" action, the
 * client sign-in link card (caption, blurb, a copyable address row), then the
 * ledger of customer companies - name over id, device and call counts, consent
 * policy, retention, created date and a status chip.
 */
export default function InstancesLoading() {
  return (
    <>
      <PageHeader title="Instances" context="Platform" />
      <IntroSkeleton lines={2} action />

      <Card elevated className="space-y-2.5">
        <div className="flex items-center gap-2">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3 w-36" />
        </div>
        <div className="space-y-1">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface py-1.5 pr-1.5 pl-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-10 w-28 shrink-0 rounded-full sm:h-8" />
        </div>
      </Card>

      <TableBlockSkeleton
        variant="ledger"
        columns={["primary2", "num", "num", "text", "num", "date", "chip"]}
        rows={6}
      />
    </>
  );
}
