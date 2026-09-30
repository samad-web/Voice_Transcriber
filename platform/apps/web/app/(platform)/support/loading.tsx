import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** A `StatCard`'s shape: the label line, the big value, the context line. */
function TileSkeleton() {
  return (
    <Card className="space-y-2">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-12" />
      <Skeleton className="h-3 w-32" />
    </Card>
  );
}

/**
 * Mirrors support/page.tsx: five tiles, the filter button row, then the two-column
 * board - the queue list on the left and the empty detail panel on the right.
 *
 * Measured against the real page rather than guessed, per the rule in
 * `console-loading.test.ts`: the title and context here must match the
 * `PageHeader` the page itself renders, or that test fails on parity.
 */
export default function SupportLoading() {
  return (
    <>
      {/* The description is repeated verbatim from page.tsx, not omitted:
          `console-loading.test.ts` compares the loader's header with the page's
          in full, so a skeleton that drops it makes the header jump when the
          real page arrives. */}
      <PageHeader
        title="Escalations"
        context="Support"
        description="Problems clients have reported with their processed calls. Re-running a call is ours to do, and it spends - so read the snapshot before you press it."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <TileSkeleton />
        <TileSkeleton />
        <TileSkeleton />
        <TileSkeleton />
        <TileSkeleton />
      </div>

      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-36 rounded-full" />
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-10" />
              </div>
              <div className="flex gap-1.5">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </Card>

        <Card className="space-y-3">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3 w-64" />
          <div className="space-y-1.5 pt-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
          <div className="space-y-1 pt-2">
            <Skeleton className="h-3 w-40" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-32" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
