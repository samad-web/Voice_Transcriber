import { PageHeaderSkeleton, StatGridSkeleton } from "@/components/skeletons";
import { Card, Skeleton } from "@aura/ui";

// Literal Tailwind classes, not a computed percentage — Tailwind v4 only
// generates CSS for class names it can see statically in source.
const BAR_HEIGHTS = [
  "h-16", "h-28", "h-20", "h-32", "h-24", "h-12", "h-36",
  "h-20", "h-28", "h-16", "h-24", "h-32", "h-20", "h-28",
];

/**
 * The dashboard's own skeleton (mirrors owner/page.tsx: window pill row, 4
 * stat cards, two side-by-side chart cards, a telecaller table, a recent
 * activity list). The group-level (owner)/loading.tsx below this one in the
 * tree is a generic last-resort for a route that hasn't got its own — every
 * route now does, this being the dashboard's.
 */
export default function DashboardLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Instance" />

      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-14" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8 w-16 rounded-full" />
        ))}
      </div>

      <StatGridSkeleton count={4} />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <Card className="space-y-4">
          <Skeleton className="h-3 w-32" />
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </Card>
        <Card className="space-y-4">
          <Skeleton className="h-3 w-48" />
          <div className="flex h-40 items-end gap-1.5">
            {BAR_HEIGHTS.map((h, i) => (
              <Skeleton key={i} className={`w-full ${h}`} />
            ))}
          </div>
        </Card>
      </div>

      <Card className="space-y-3">
        <Skeleton className="h-3 w-40" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </Card>

      <Card className="space-y-3">
        <Skeleton className="h-3 w-28" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </>
  );
}
