import { Skeleton } from "@aura/ui";
import { DateRangeBarSkeleton, DateRangeSummarySkeleton } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton, ToolbarSkeleton } from "@/components/skeletons";

/** The date pills: Any date, Today, Yesterday, Last 7/30/90 days, This month, Last month. */
const DATE_PILLS = ["w-20", "w-16", "w-20", "w-24", "w-28", "w-28", "w-24", "w-24"] as const;

/**
 * Mirrors calls/page.tsx: an intro line, the shared date control and its line
 * of dates, then calls-explorer.tsx - a search box beside three pill groups
 * (Status 4, Feeling 4, Direction 3), a Telecaller pill row, and a 6-column
 * log: When (relative time over the exact one), Contact (name over its state
 * chip), Length, Telecaller, The AI read, Lead.
 */
export default function CallsLoading() {
  return (
    <>
      <PageHeader title="Calls" context="Pipeline" />
      <Skeleton className="-mt-2 h-3.5 w-[40rem] max-w-full" />
      <DateRangeBarSkeleton pills={DATE_PILLS} />
      <DateRangeSummarySkeleton />
      {/* The explorer's own filter row: stacked on a phone, a single line from lg. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-5">
        <Skeleton className="h-9.5 w-full rounded-sm lg:min-w-48 lg:flex-1" />
        <ToolbarSkeleton pills={4} />
        <ToolbarSkeleton pills={4} />
        <ToolbarSkeleton pills={3} />
      </div>
      <ToolbarSkeleton pills={5} />
      <TableBlockSkeleton columns={["primary2", "primary2", "num", "text", "chip", "text"]} />
    </>
  );
}
