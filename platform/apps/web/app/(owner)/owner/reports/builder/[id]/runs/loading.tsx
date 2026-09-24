import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Run timestamps ("19 Sep 2026, 09:30") are all about the same length; a little variety only. */
const RUN_W = ["w-44", "w-40", "w-48", "w-44", "w-40", "w-48"] as const;

/**
 * Mirrors reports/builder/[id]/runs/page.tsx: one card holding the "Runs"
 * label, a short explanation of what a
 * run freezes and a divided list of runs, each a timestamp with a status chip
 * and a scheduled/manual chip.
 */
export default function RunHistoryLoading() {
  return (
    <>
      <PageHeader title="Run history" context="Custom reports" />

      <Card>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="mt-1">
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-full" />
          </div>
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-3/4" />
          </div>
        </div>

        <div className="mt-3 divide-y divide-border">
          {RUN_W.map((w, i) => (
            <div key={i} className="flex items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <Skeleton className={`h-3.5 ${w}`} />
              </div>
              <Skeleton className="h-5.5 w-20 rounded-full" />
              <Skeleton className="h-5.5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
