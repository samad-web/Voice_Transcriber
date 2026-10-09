import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { DateRangeBarSkeleton } from "@/components/date-range-bar";
import { SectionHeadingSkeleton, StatGridSkeleton, TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors finance/page.tsx: the range bar, the freshness line, two bands of
 * four tiles, the aging table and the health card.
 *
 * The freshness stamp is drawn as a short line rather than left out, because
 * it is the one thing on the page that is ALWAYS there - "data as of 15:42" or
 * "not computed yet" - so omitting it would make the header jump by a line
 * when the data lands.
 *
 * The second band is `plain`, matching the page: runway, CAC, fees and
 * days-to-collect are secondary tiles there and a filled placeholder would
 * promise more emphasis than arrives.
 */
export default function FinanceLoading() {
  return (
    <>
      <PageHeader title="Finance" context="Sales" />
      <DateRangeBarSkeleton />
      <Skeleton className="h-2.5 w-72" />
      <StatGridSkeleton count={4} columns={4} />
      <StatGridSkeleton count={4} columns={4} tone="plain" />
      <SectionHeadingSkeleton subtitle={false} />
      <TableBlockSkeleton columns={["text", "num", "num"]} rows={5} />
      <SectionHeadingSkeleton />
      <Skeleton className="h-40 w-full rounded-xl" />
    </>
  );
}
