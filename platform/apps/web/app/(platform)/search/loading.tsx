import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcherSkeleton } from "@/components/skeletons";

/**
 * Mirrors search/page.tsx: the tenant switcher, then one search card - a
 * heading, a line of help text, and the query box beside its Search button.
 * Results only appear after a search is run, so nothing sits below the card.
 */
export default function SearchLoading() {
  return (
    <>
      <PageHeader title="Transcript Search" />

      {/* TenantSwitcher: a label, then one pill per tenant (only shown for 2+). */}
      <TenantSwitcherSkeleton />

      <Card elevated className="space-y-4">
        <div className="flex h-7 items-center gap-2">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-5 w-72 max-w-full" />
        </div>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-full max-w-2xl" />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Skeleton className="h-11 w-full sm:flex-1" />
          <Skeleton className="h-10 w-full rounded-full sm:w-32" />
        </div>
      </Card>
    </>
  );
}
