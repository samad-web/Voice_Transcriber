import { Card, Skeleton } from "@aura/ui";
import { PageHeaderSkeleton } from "@/components/skeletons";

const ROW_NAME = ["h-3.5 w-48", "h-3.5 w-36", "h-3.5 w-56"] as const;
const ROW_DETAIL = ["h-3 w-32", "h-3 w-40", "h-3 w-28"] as const;
const LINE_TAIL = ["h-3 w-2/3", "h-3 w-1/2", "h-3 w-3/4"] as const;

/**
 * Mirrors integrations/[appId]/page.tsx. The app's name is the title and comes
 * from the URL segment, which a route loader cannot read, so the header is a
 * PageHeaderSkeleton under the page's real eyebrow. Then the hero row (logo,
 * maker, blurb, state chip, primary button) and the `1fr | 22rem` grid:
 * connections and activity on the left; About, access, needs and the
 * disconnect note on the right.
 */
export default function IntegrationAppLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Connected apps" />

      <div className="-mt-2 flex flex-wrap items-start gap-x-4 gap-y-3">
        <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1 basis-64 space-y-2 pt-1">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-3.5 w-full max-w-prose" />
          <Skeleton className="h-5.5 w-24 rounded-full" />
        </div>
        <Skeleton className="h-10 w-28 rounded-full" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <section className="space-y-2">
            <Skeleton className="h-3 w-28" />
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-60 space-y-1.5">
                    <Skeleton className={ROW_NAME[i]} />
                    <Skeleton className={ROW_DETAIL[i]} />
                  </div>
                  <div className="space-y-1">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-5.5 w-20 rounded-full" />
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-4">
          {[3, 4, 2].map((lines, card) => (
            <Card key={card}>
              <Skeleton className="h-3 w-24" />
              <div className="mt-3 space-y-2">
                {Array.from({ length: lines }, (_, i) => (
                  <Skeleton key={i} className={i === lines - 1 ? LINE_TAIL[card % LINE_TAIL.length] : "h-3 w-full"} />
                ))}
              </div>
            </Card>
          ))}
        </aside>
      </div>
    </>
  );
}
