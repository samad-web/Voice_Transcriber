import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FormCardSkeleton } from "@/components/skeletons";

/** Mirrors account/time/page.tsx: the clock card (a large time over two short lists), the picker card, then the location card. */
export default function TimeZoneLoading() {
  return (
    <>
      <PageHeader title="Time & location" context="Account" />
      <Card className="space-y-4">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-4 w-56" />
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          {[0, 1].map((col) => (
            <div key={col} className="space-y-2">
              <Skeleton className="h-3 w-28" />
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ))}
        </div>
      </Card>
      <FormCardSkeleton fields={1} />
      <FormCardSkeleton fields={2} />
    </>
  );
}
