import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * Mirrors org-chart/page.tsx: the filter row, the view switch and the canvas.
 *
 * ── THE CANVAS IS ONE BLOCK, NOT A SKELETON TREE ───────────────────────────
 *
 * The obvious loader draws a few placeholder nodes in a tree shape. It does
 * not, for one reason: nothing here knows the shape of the tree yet, and a
 * three-node placeholder that resolves into a forty-node chart is a bigger
 * jump than an empty frame resolving into the same chart. §5.3 asks for "no
 * layout jump on load", and the honest way to keep that promise is a frame of
 * the right HEIGHT with nothing in it - the canvas has a fixed height, so the
 * page does not move at all when the data lands.
 *
 * The filter row IS drawn at its real width, because those controls are always
 * there and always that size. The view switch is drawn with its three real
 * segments. Nothing is drawn for the drawer, which only exists once somebody
 * opens a node.
 */
export default function OrgChartLoading() {
  return (
    <>
      <PageHeader
        title="Organization chart"
        context="Settings"
        description="Who reports to whom, what each position is responsible for, and what it can approve."
      />

      {/* Search, three filters and the as-of date. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1.5">
          <Skeleton className="h-2.5 w-14" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-9 w-36 rounded-md" />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Skeleton className="h-8 w-56 rounded-md" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
      </div>

      {/* The same height the canvas reserves, so the frame does not resize. */}
      <Skeleton className="h-[min(72vh,760px)] w-full rounded-lg" />
    </>
  );
}
