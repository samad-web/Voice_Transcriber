import { Skeleton } from "@aura/ui";
import { CanvasTileSkeleton } from "@/components/skeletons";

/**
 * Mirrors reports/builder/[id]/dashboard/page.tsx (LiveDashboard): the
 * full-screen, chrome-free view meant for an office TV or a kiosk.
 *
 * This route group has no layout of its own, so only the root shell (fonts and
 * providers) wraps it: no sidebar, no console header, no <main> padding and no
 * space-y rhythm, and no page header either. So this is not the console shape.
 * It is the page's own two bands, edge to edge: the top bar (report name and
 * "updated" stamp on the left; refresh-interval select, refresh, Fullscreen and
 * Edit report on the right) with a hairline under it, then a `p-4` canvas of
 * 12-column tiles. It returns two siblings rather than the page's `min-h-dvh`
 * flex wrapper because the body already carries `min-h-dvh bg-bg`, so the two
 * draw the same, and a loader is meant to be a fragment.
 */
export default function LiveDashboardLoading() {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-28 rounded-sm" />
          <Skeleton className="h-8 w-10 rounded-full" />
          <Skeleton className="h-8 w-28 rounded-full" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-12 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <CanvasTileSkeleton key={i} kpi className="col-span-3 h-32" />
          ))}
          <CanvasTileSkeleton className="col-span-8 h-72" />
          <CanvasTileSkeleton className="col-span-4 h-72" />
          <CanvasTileSkeleton className="col-span-12 h-56" />
        </div>
      </div>
    </>
  );
}
