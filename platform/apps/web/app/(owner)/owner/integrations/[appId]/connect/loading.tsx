import { Card, Skeleton } from "@aura/ui";
import { PageHeaderSkeleton } from "@/components/skeletons";

const STEP_W = ["w-28", "w-24", "w-20", "w-16"] as const;

/**
 * Mirrors integrations/[appId]/connect/page.tsx and the ConnectFlow it mounts.
 * The title names the app, which a route loader cannot read from the URL, so
 * the header is a PageHeaderSkeleton under its real eyebrow. Then the step
 * row (numbered dots joined by short rules) and the step's card: the app's
 * logo and "will be able to" beside it, three access lines, and Continue.
 */
export default function ConnectAppLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Connected apps" />

      <div className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {STEP_W.map((w, i) => (
            <div key={i} className="flex items-center gap-2">
              {i > 0 ? <span className="h-px w-4 bg-border-strong" /> : null}
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className={`h-3 ${w}`} />
            </div>
          ))}
        </div>

        <Card>
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
              <div className="flex-1 space-y-2 pt-1">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-2.5 w-12" />
                <Skeleton className="h-3.5 w-3/4" />
              </div>
            ))}
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
        </Card>
      </div>
    </>
  );
}
