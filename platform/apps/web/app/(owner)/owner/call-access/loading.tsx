import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * One request card in the history list: who asked and why on the left, the
 * outcome chip on the right.
 */
function HistoryCardSkeleton({ i }: { i: number }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex h-5 items-center">
            <Skeleton className={i % 2 === 0 ? "h-3.5 w-52" : "h-3.5 w-44"} />
          </div>
          <div className="flex h-4 items-center">
            <Skeleton className={i % 2 === 0 ? "h-2.5 w-72" : "h-2.5 w-60"} />
          </div>
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
    </Card>
  );
}

/**
 * Mirrors call-access/page.tsx (CallAccessClient), whose root is its own
 * `flex flex-col gap-6` column: the gate card (a shield glyph, the protected /
 * not-protected headline, a two-line explanation, who requests go to, and the
 * owner's Turn on / Turn off button), then "Waiting for you" with the request
 * that needs a decision (who, why, the start and end pickers, the approve and
 * decline buttons), then the History list.
 *
 * "Active right now" is left out: it only exists while someone holds a live
 * grant. The page is new and its layout may still move, so this draws the
 * durable skeleton of it - gate, one open request, history - and no more.
 */
export default function CallAccessLoading() {
  return (
    <>
      <PageHeader
        title="Call access"
        context="Settings"
        description="Nobody outside your team can open your call logs, recordings or transcripts without your approval."
      />

      <div className="flex flex-col gap-6">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <Skeleton className="mt-0.5 size-5 shrink-0" />
              <div>
                <div className="flex h-5 items-center">
                  <Skeleton className="h-3.5 w-64" />
                </div>
                <div className="mt-1 max-w-prose space-y-1.5">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
                <div className="mt-2 flex h-4 items-center">
                  <Skeleton className="h-2.5 w-56" />
                </div>
              </div>
            </div>
            <Skeleton className="h-9 w-24 rounded-full" />
          </div>
        </Card>

        <section className="flex flex-col gap-3">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-40" />
          </div>
          <Card>
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex h-5 items-center">
                  <Skeleton className="h-3.5 w-56" />
                </div>
                <div className="mt-1 flex h-5 items-center">
                  <Skeleton className="h-3.5 w-3/4 max-w-md" />
                </div>
                <div className="mt-2 flex h-4 items-center">
                  <Skeleton className="h-2.5 w-72 max-w-full" />
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                {[0, 1].map((i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex h-4 items-center">
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                    <Skeleton className="h-9.5 w-52 rounded-sm" />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-9 w-28 rounded-full" />
                <Skeleton className="h-9 w-24 rounded-full" />
              </div>
            </div>
          </Card>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-16" />
          </div>
          {[0, 1, 2].map((i) => (
            <HistoryCardSkeleton key={i} i={i} />
          ))}
        </section>
      </div>
    </>
  );
}
