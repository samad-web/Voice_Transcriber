import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { StatGridSkeleton } from "@/components/skeletons";

/**
 * Mirrors org-chart/analytics/page.tsx: the four stat tiles, the two cards
 * side by side, and the three lists below them.
 *
 * Its own loader rather than falling through to the chart's, which
 * `console-loading.test.ts` is what caught: the parent's skeleton draws a
 * filter row and a tall canvas frame, and this page has neither - so a reader
 * would watch a chart placeholder turn into a page of numbers.
 *
 * The list cards are drawn at a FIXED four rows rather than at the real count,
 * which nothing knows until the data lands. Four is roughly a small business's
 * manager count and short enough that a bigger result grows the page
 * downwards rather than reflowing what is already on screen.
 */
export default function OrgChartAnalyticsLoading() {
  return (
    <>
      <PageHeader
        title="Organization analytics"
        context="Settings"
        description="Headcount, how wide each manager's team is, what is empty, and how long people stay."
      />

      <Skeleton className="h-4 w-28" />

      <StatGridSkeleton count={4} tone="plain" />

      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((card) => (
          <div key={card} className="space-y-3 rounded-lg border border-border bg-surface p-4">
            <Skeleton className="h-3.5 w-44" />
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center justify-between gap-4">
                <Skeleton className="h-2.5 w-40" />
                <Skeleton className="h-2.5 w-12" />
              </div>
            ))}
          </div>
        ))}
      </div>

      {[0, 1].map((card) => (
        <div key={card} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-2.5 w-72" />
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-0">
              <Skeleton className="h-2.5 w-48" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
