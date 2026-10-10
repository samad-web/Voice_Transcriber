import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * Mirrors close/page.tsx: the progress card, then the eight-step checklist.
 *
 * Eight rows because `CLOSE_CHECKLIST` has eight steps - a real count rather
 * than a placeholder, so the list does not jump when it loads.
 */
export default function CloseLoading() {
  return (
    <>
      <PageHeader title="Month-end close" context="Sales" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="space-y-3 rounded-lg border border-border p-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="h-5 w-5 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-80" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
