import { Card, Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Widths of the sort link row, in the order the page lists them (Calls, Talk
 * time, Idle gap, SOP adherence, Name). Whole literal classes, so Tailwind v4
 * can see them.
 */
const SORT = { label: "w-6", options: ["w-14", "w-20", "w-18", "w-28", "w-12"] } as const;

/** A label, then its row of option links (`rounded-md px-2.5 py-1`, 28px tall). */
function OptionRow({ label, options }: { label: string; options: readonly string[] }) {
  return (
    <div className="flex items-center gap-2">
      <Skeleton className={`h-3 ${label}`} />
      {options.map((w, i) => (
        <Skeleton key={i} className={`h-7 rounded-md ${w}`} />
      ))}
    </div>
  );
}

/**
 * Mirrors productivity/page.tsx: the shared date-range control and its line of
 * dates, then the feed, the workload matrix and the leaderboard, then the
 * section heading, the Sort link row, one 9-column telecaller table (a name,
 * then eight right-hand figures) and the "How to read this" notes card.
 *
 * Geometry is measured against the real page rather than guessed, the rule the
 * console's other loaders follow - a skeleton whose blocks land somewhere else
 * than the content reads as the page jumping rather than as it arriving.
 *
 * The optional notices (talk time not measured, no SOP scoring, own numbers
 * only, the unlinked-follow-ups note) are left out: they appear for some orgs
 * only, and a skeleton for a block that never comes is worse than none.
 */
export default function ProductivityLoading() {
  return (
    <>
      <PageHeader title="Team activity" context="Reports" />

      <DateRangeBarSkeleton />
      <DateRangeSummarySkeleton />

      {/* The feed: a label and its summary, then two day groups of four lines.
          Each line is one 20px row - actor, verb, subject, time - so the block is
          a stack of full-width bars rather than a table. */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-44" />
        </div>
        {[0, 1].map((group) => (
          <div key={group} className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <div className="space-y-2.5">
              {["w-11/12", "w-4/5", "w-10/12", "w-3/4"].map((w, i) => (
                <Skeleton key={i} className={`h-3.5 ${w}`} />
              ))}
            </div>
          </div>
        ))}
        <Skeleton className="h-3 w-full" />
      </Card>

      {/* The workload matrix: label + legend, the caveat line, then a 6-column
          table whose second column is the pair of bars. */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-48" />
        </div>
        <Skeleton className="h-3 w-3/4" />
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-3.5 w-28 shrink-0" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-2 w-full rounded-full" />
                <Skeleton className="h-2 w-2/3 rounded-full" />
              </div>
              <Skeleton className="h-3.5 w-10 shrink-0" />
              <Skeleton className="h-3.5 w-10 shrink-0" />
              <Skeleton className="h-3.5 w-32 shrink-0" />
            </div>
          ))}
        </div>
        <Skeleton className="h-4 w-2/3" />
      </Card>

      {/* The leaderboard: label + five metric pills, then a 6-column table. */}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-3 w-24" />
          <div className="flex items-center gap-1">
            {["w-24", "w-24", "w-24", "w-20", "w-28"].map((w, i) => (
              <Skeleton key={i} className={`h-7 rounded-md ${w}`} />
            ))}
          </div>
        </div>
        <TableBlockSkeleton columns={["num", "primary", "num", "num", "num", "num"]} rows={5} />
        <Skeleton className="h-3 w-full" />
      </Card>

      {/* The section heading above the kept table: title then its note line. */}
      <div className="mt-2 space-y-1">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-3 w-64" />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <OptionRow {...SORT} />
      </div>

      <TableBlockSkeleton
        columns={["primary", "num", "num", "num", "num", "num", "num", "num", "num"]}
        rows={6}
      />

      <Card className="space-y-1.5">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="space-y-1.5">
          {["w-2/3", "w-3/4", "w-1/2", "w-3/5"].map((last, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className={`h-3.5 ${last}`} />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
