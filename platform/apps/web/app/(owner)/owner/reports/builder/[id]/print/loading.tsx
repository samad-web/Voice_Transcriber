import { Skeleton } from "@aura/ui";
import { CanvasTileSkeleton } from "@/components/skeletons";

/**
 * Mirrors reports/builder/[id]/print/page.tsx, which has no page header. It sits
 * inside the console like any other route and draws two things: the "your
 * browser's print dialog should have opened" bar with its Print again button,
 * then the paper itself - an A4-width sheet with the running header (report
 * name and org line on the left, the generated-at stamp on the right) over a
 * 12-column grid of flat tiles.
 *
 * The sheet is `bg-white` with light ink (`onPaper`), NOT theme tokens: the real
 * article is a fixed `bg-white text-black` in both themes, so a token-toned sheet
 * was dark in dark mode and flashed white when the report arrived. The toolbar bar
 * above it stays on tokens, as the real page's `print-hide` bar does.
 *
 * The page waits on one POST that renders every widget before it can paint, so
 * without this it would inherit the editor's loader and show a toolbar and
 * page tabs that the print view never has.
 */
export default function PrintReportLoading() {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg-subtle px-4 py-3">
        <Skeleton className="h-3.5 w-80 max-w-full" />
        <Skeleton className="h-7 w-24 rounded-md" />
      </div>

      <div className="mx-auto w-full max-w-[210mm] bg-white">
        <div className="mb-4 flex items-end justify-between gap-3 border-b border-black/10 pb-2">
          <div className="space-y-1.5">
            <Skeleton onPaper className="h-5 w-56" />
            <Skeleton onPaper className="h-2.5 w-64" />
          </div>
          <Skeleton onPaper className="h-2.5 w-40" />
        </div>

        <div className="grid grid-cols-12 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <CanvasTileSkeleton key={i} flat kpi className="col-span-3 h-28" />
          ))}
          <CanvasTileSkeleton flat className="col-span-6 h-60" />
          <CanvasTileSkeleton flat className="col-span-6 h-60" />
          <CanvasTileSkeleton flat className="col-span-12 h-44" />
        </div>
      </div>
    </>
  );
}
