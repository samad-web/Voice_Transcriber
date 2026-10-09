import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { SectionHeadingSkeleton } from "@/components/skeletons";

/**
 * Mirrors advisor/page.tsx: the leak report card, the four severity counters,
 * then a stack of alert cards.
 *
 * NOT a table skeleton. Each alert is a card with a message, a recommended
 * action, an amount and a collapsed explain panel, and drawing table rows here
 * would resolve into something structurally different - the layout jump §11
 * forbids.
 */
export default function AdvisorLoading() {
  return (
    <>
      <PageHeader title="Money-leak inbox" context="Sales" />
      <SectionHeadingSkeleton />
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-24 rounded-md" />
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-32 w-full rounded-xl" />
      ))}
    </>
  );
}
