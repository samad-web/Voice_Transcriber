import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** One flag card each: the three flag types read at different lengths, and only two name a deal. */
const FLAGS = [
  { label: "w-36", detail: "w-[38rem]", deal: false },
  { label: "w-48", detail: "w-96", deal: true },
  { label: "w-44", detail: "w-[35rem]", deal: true },
] as const;

/** A bar in a real line box, so the block is as tall as the text it stands in for. */
function TextLine({ line, bar }: { line: "h-4" | "h-5"; bar: string }) {
  return (
    <div className={`flex items-center ${line}`}>
      <Skeleton className={bar} />
    </div>
  );
}

/** A kit `Button size="sm"`: `h-10` on a phone, `h-8` beside a cursor. */
function SmallButton({ width }: { width: string }) {
  return <Skeleton className={`h-10 ${width} rounded-full sm:h-8`} />;
}

/**
 * One outcome in the vocabulary editor, on a single line: the name input (`w-48`),
 * what the outcome means for the lead (`w-56`), its colour (`w-28`), then Retire
 * pushed to the far end. The widths are the page's own - they only take effect
 * now that the kit's `Input` and `Select` honour a caller's `w-*`.
 */
function OutcomeRowSkeleton() {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2.5">
      <Skeleton className="h-9.5 w-48" />
      <Skeleton className="h-9.5 w-56" />
      <Skeleton className="h-9.5 w-28" />
      <span className="flex-1" />
      <SmallButton width="w-16" />
    </li>
  );
}

/**
 * Mirrors call-quality/page.tsx: a two-line helper under the header, then
 * call-quality-manager.tsx's `space-y-4` root holding a stack of flag cards - each
 * a flag-type label and a date chip, one line saying what the AI read against what
 * the CRM holds, the call (and, for two of the types, the deal) it is about, and
 * Not a problem / Mark fixed - then dispositions-editor.tsx's card: a heading and
 * count, a paragraph, the seven default outcomes, an add-an-outcome row and a
 * footnote.
 */
export default function CallQualityLoading() {
  return (
    <>
      <PageHeader title="Call Quality" context="Pipeline" />
      <div className="-mt-2">
        <TextLine line="h-5" bar="h-3.5 w-full" />
        <TextLine line="h-5" bar="h-3.5 w-3/5" />
      </div>

      <div className="space-y-4">
        <div className="space-y-3">
          {FLAGS.map((flag, i) => (
            <Card key={i}>
              <div className="flex items-center justify-between gap-2">
                <TextLine line="h-4" bar={`h-3 ${flag.label}`} />
                <Skeleton className="h-5.5 w-24 rounded-full" />
              </div>
              <div className="mt-2">
                <TextLine line="h-5" bar={`h-3.5 ${flag.detail} max-w-full`} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                <TextLine line="h-4" bar="h-3 w-60" />
                {flag.deal ? <TextLine line="h-4" bar="h-3 w-28" /> : null}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <SmallButton width="w-28" />
                <SmallButton width="w-24" />
              </div>
            </Card>
          ))}
        </div>
      </div>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <TextLine line="h-4" bar="h-3 w-24" />
          <TextLine line="h-4" bar="h-3 w-14" />
        </div>
        <div className="max-w-prose">
          {["w-full", "w-full", "w-1/3"].map((width, i) => (
            <div key={i} className="flex h-[22.75px] items-center">
              <Skeleton className={`h-3.5 ${width}`} />
            </div>
          ))}
        </div>
        <ul className="space-y-1.5">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <OutcomeRowSkeleton key={i} />
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Skeleton className="h-10 min-w-0 flex-1" />
          <Skeleton className="h-10 w-16 rounded-full" />
        </div>
        <TextLine line="h-4" bar="h-3 w-[42rem] max-w-full" />
      </Card>
    </>
  );
}
