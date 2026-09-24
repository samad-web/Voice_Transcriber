import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so the four cards are not four copies of one row. */
const NAME_BAR = ["h-4 w-36", "h-4 w-28", "h-4 w-40", "h-4 w-32"] as const;
const META_BAR = ["h-3 w-64", "h-3 w-56", "h-3 w-72", "h-3 w-60"] as const;
const SUMMARY_BAR = ["h-3.5 w-2/3", "h-3.5 w-1/2", "h-3.5 w-3/4", "h-3.5 w-2/5"] as const;

/**
 * Mirrors calls/triage/page.tsx (the Unmatched tab, with calls waiting): a
 * five-line explainer tucked up under the header, the "Where the calls went"
 * card with its Unmatched / Dismissed links, then a card per call - who and
 * which direction, when and how long, a summary - with Create lead / Link /
 * Not relevant beside it.
 */
export default function CallTriageLoading() {
  return (
    <>
      <PageHeader title="Calls to link" context="Conversations" />

      <div className="-mt-2 max-w-prose space-y-2.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/5" />
      </div>

      <Card className="space-y-1.5">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3.5 w-full max-w-xl" />
        <div className="flex gap-3 pt-1">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      </Card>

      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 max-w-prose flex-1 basis-64 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className={NAME_BAR[i]} />
                  <Skeleton className="h-6 w-20 rounded-full" />
                </div>
                <Skeleton className={META_BAR[i]} />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className={SUMMARY_BAR[i]} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-8 w-24 rounded-full" />
                <Skeleton className="h-8 w-14 rounded-full" />
                <Skeleton className="h-8 w-28 rounded-full" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
