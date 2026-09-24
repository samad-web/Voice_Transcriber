import { Card, Skeleton } from "@aura/ui";
import { CanvasTileSkeleton, PageHeaderSkeleton } from "@/components/skeletons";

/** The three `text-xs` links under the header: run history, data sources, dashboard. */
const LINK_W = ["w-16", "w-18", "w-28"] as const;

/** The add-a-widget buttons: Chart, Metric, Table, Note, Divider. */
const ADD_W = ["w-18", "w-20", "w-18", "w-16", "w-20"] as const;

/** Six series-colour swatches, one per palette colour the toolbar previews. */
const SWATCHES = [0, 1, 2, 3, 4, 5] as const;

/** The remove button's frame: `px-1.5` around a 12px icon, joined to the tab's right edge. */
const TAB_REMOVE =
  "flex h-7 items-center rounded-r-sm border border-l-0 border-border bg-surface px-1.5";

/**
 * One page tab: the page's name in a bordered button, and the small remove button
 * joined to its right edge (drawn only when the report has more than one page).
 */
function PageTabSkeleton({ active, bar }: { active: boolean; bar: string }) {
  return (
    <div className="flex items-center">
      <div
        className={`flex h-7 items-center rounded-l-sm border px-2.5 ${
          active ? "border-border-strong bg-surface-hover" : "border-border bg-surface"
        }`}
      >
        <Skeleton className={bar} />
      </div>
      <div className={TAB_REMOVE}>
        <Skeleton className="size-3" />
      </div>
    </div>
  );
}

/**
 * Mirrors reports/builder/[id]/page.tsx and the ReportEditor it mounts: the three
 * links under the header (the title is the report's name, so it is a skeleton);
 * the editor's own stack - a toolbar card (the report name with its status chip,
 * undo and redo, the design and palette dropdowns, PDF, fullscreen and share,
 * then a row of series-colour swatches), the page tabs with an add-page button,
 * the add-a-widget buttons - and the canvas. The canvas is the editor's real
 * 12-column grid at its real 44px row height with 12px gaps: four metric tiles,
 * two charts and a wide trend. No inspector is drawn - nothing is selected on open.
 */
export default function ReportEditorLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Custom reports" />

      <div className="-mt-2 flex flex-wrap items-center gap-3">
        {LINK_W.map((w, i) => (
          <div key={i} className="flex h-[18px] items-center">
            <Skeleton className={`h-3 ${w}`} />
          </div>
        ))}
      </div>

      {/* The editor's own root stacks at space-y-3, tighter than the page's rhythm. */}
      <div className="space-y-3">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-6 items-center">
                <Skeleton className="h-4 w-40" />
              </div>
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-10 w-12 rounded-full sm:h-8 sm:w-18" />
              <Skeleton className="h-10 w-12 rounded-full sm:h-8 sm:w-18" />
              <Skeleton className="h-9.5 w-36 rounded-sm" />
              <Skeleton className="h-9.5 w-40 rounded-sm" />
              <Skeleton className="h-10 w-18 rounded-full sm:h-8" />
              <Skeleton className="h-10 w-28 rounded-full sm:h-8" />
              <Skeleton className="h-10 w-20 rounded-full sm:h-8" />
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <div className="flex h-[16.5px] items-center">
              <Skeleton className="h-2.5 w-20" />
            </div>
            <div className="flex gap-1">
              {SWATCHES.map((i) => (
                <Skeleton key={i} className="size-3.5" />
              ))}
            </div>
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-1.5">
          <PageTabSkeleton active bar="h-3 w-16" />
          <PageTabSkeleton active={false} bar="h-3 w-12" />
          <Skeleton className="h-10 w-18 rounded-full sm:h-8" />
        </div>

        <div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {ADD_W.map((w, i) => (
              <Skeleton key={i} className={`h-10 rounded-full sm:h-8 ${w}`} />
            ))}
          </div>

          {/* Rows are 44px with 12px gaps, so a tile `h` rows tall is h * 56 - 12 px. */}
          <div className="grid grid-cols-12 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <CanvasTileSkeleton key={i} kpi className="col-span-3 h-[156px]" />
            ))}
            <CanvasTileSkeleton className="col-span-7 h-[436px]" />
            <CanvasTileSkeleton className="col-span-5 h-[436px]" />
            <CanvasTileSkeleton className="col-span-12 h-[380px]" />
          </div>
        </div>
      </div>
    </>
  );
}
