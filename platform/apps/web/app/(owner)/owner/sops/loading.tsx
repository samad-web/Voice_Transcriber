import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** The three explainer paragraphs of "What this does", as their line bars: four lines, three, three. */
const EXPLAINER: readonly (readonly string[])[] = [
  ["h-3 w-full", "h-3 w-full", "h-3 w-full", "h-3 w-3/5"],
  ["h-3 w-full", "h-3 w-full", "h-3 w-2/5"],
  ["h-3 w-full", "h-3 w-full", "h-3 w-1/2"],
];

/**
 * Mirrors sops/page.tsx (a procedure that has been saved more than once): the
 * "What this does" card of three explainer paragraphs, then the steps editor -
 * an Active chip and step count, the procedure's name field, a box per step (a
 * name input, an instruction box, Remove, and the counts-towards-the-score
 * checkbox), Add a step, and the save row - then the version history card. A
 * real procedure has up to twelve steps; three are drawn.
 */
export default function SopsLoading() {
  return (
    <>
      <PageHeader title="Call checklist" context="Settings" />

      <Card className="space-y-2">
        <Skeleton className="h-3 w-28" />
        {EXPLAINER.map((lines, p) => (
          <div key={p} className="max-w-prose space-y-2.5">
            {lines.map((line, l) => (
              <Skeleton key={l} className={line} />
            ))}
          </div>
        ))}
      </Card>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-3 w-12" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>

        <div className="max-w-md space-y-1.5">
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-9.5 w-full" />
        </div>

        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-9.5 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
                <Skeleton className="h-8 w-16 shrink-0 rounded-full" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 shrink-0" />
                <Skeleton className="h-3 w-3/4 max-w-lg" />
              </div>
            </div>
          ))}
          <Skeleton className="h-10 w-28 rounded-full" />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Skeleton className="h-10 w-48 rounded-full" />
          <Skeleton className="h-10 w-52 rounded-full" />
        </div>
      </Card>

      <Card className="space-y-1.5">
        <Skeleton className="h-3 w-28" />
        <div className="max-w-prose space-y-2.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/5" />
        </div>
        <div className="space-y-2.5 pt-1">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-3.5 w-44" />
          <Skeleton className="h-3.5 w-40" />
        </div>
      </Card>
    </>
  );
}
