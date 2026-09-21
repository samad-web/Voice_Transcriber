import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so the rows are not copies of one another. */
const NAME_BAR = ["h-4 w-32", "h-4 w-40", "h-4 w-28", "h-4 w-36"] as const;
const BLURB_BAR = ["h-3 w-1/2", "h-3 w-2/3", "h-3 w-2/5", "h-3 w-3/5"] as const;

/**
 * One group of the switchboard, as FeatureBoard draws it: a padded card with the
 * group's label, then divided rows - the feature's name, a two-line blurb, and
 * its switch on the right.
 */
function FeatureGroupSkeleton({ rows, start }: { rows: number; start: number }) {
  return (
    <Card className="space-y-3">
      <Skeleton className="h-3 w-24" />
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0 max-w-prose flex-1 space-y-2">
              <Skeleton className={NAME_BAR[(start + i) % NAME_BAR.length]} />
              <Skeleton className="h-3 w-full" />
              <Skeleton className={BLURB_BAR[(start + i) % BLURB_BAR.length]} />
            </div>
            <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Mirrors features/page.tsx: a three-line explainer tucked up under the header,
 * then the feature switchboard - one card per group (Pipeline, Customers,
 * Conversations, ...) holding that group's features with a switch each. The real
 * board runs to seven groups; three are drawn, which is what the first screen holds.
 */
export default function FeaturesLoading() {
  return (
    <>
      <PageHeader title="Features" context="Workspace" />

      <div className="-mt-2 max-w-prose space-y-2.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/3" />
      </div>

      {/* FeatureBoard's own root: one block with a tighter rhythm (space-y-4) than <main>'s. */}
      <div className="space-y-4">
        <FeatureGroupSkeleton rows={4} start={0} />
        <FeatureGroupSkeleton rows={4} start={1} />
        <FeatureGroupSkeleton rows={4} start={2} />
      </div>
    </>
  );
}
