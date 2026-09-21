import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so the rows are not copies of one another. */
const NAME_BAR = [
  "h-3.5 w-36",
  "h-3.5 w-28",
  "h-3.5 w-44",
  "h-3.5 w-32",
  "h-3.5 w-40",
  "h-3.5 w-24",
] as const;
const CHIP_BAR = [
  "h-6 w-14 rounded-full",
  "h-6 w-20 rounded-full",
  "h-6 w-16 rounded-full",
  "h-6 w-14 rounded-full",
  "h-6 w-24 rounded-full",
  "h-6 w-16 rounded-full",
] as const;
const META_BAR = [
  "h-3 w-4/5 max-w-lg",
  "h-3 w-2/3 max-w-md",
  "h-3 w-3/4 max-w-lg",
  "h-3 w-3/5 max-w-md",
  "h-3 w-4/5 max-w-lg",
  "h-3 w-2/3 max-w-md",
] as const;

/**
 * Mirrors recycle-bin/page.tsx (a bin with things in it): a three-line explainer
 * tucked up under the header, then one card - "Deleted, newest first" over
 * divided rows, each an item's name and what kind of thing it was, a line of
 * when, by whom and how many days it has left, and a Restore button.
 */
export default function RecycleBinLoading() {
  return (
    <>
      <PageHeader title="Recycle bin" context="Settings" />

      <div className="-mt-2 max-w-2xl space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>

      {/* The real card carries mt-6 on top of <main>'s rhythm; kept so the gap matches. */}
      <Card className="mt-6">
        <Skeleton className="h-3 w-36" />
        <div className="mt-4 divide-y divide-border">
          {NAME_BAR.map((name, i) => (
            <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className={name} />
                  <Skeleton className={CHIP_BAR[i]} />
                </div>
                <Skeleton className={META_BAR[i]} />
              </div>
              <Skeleton className="h-8 w-24 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
