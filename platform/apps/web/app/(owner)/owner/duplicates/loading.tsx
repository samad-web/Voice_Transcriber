import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const REASON_W = ["w-52", "w-44", "w-56", "w-48"] as const;
const NAME_W = ["w-32", "w-40", "w-28", "w-36", "w-44", "w-32", "w-36", "w-28"] as const;
const DETAIL_W = ["w-44", "w-52", "w-36", "w-48", "w-40", "w-56", "w-44", "w-36"] as const;

/** A bar in a real line box, so the block is as tall as the text it stands in for. */
function TextLine({ line, bar }: { line: "h-4" | "h-5" | "h-6"; bar: string }) {
  return (
    <div className={`flex items-center ${line}`}>
      <Skeleton className={bar} />
    </div>
  );
}

/** A kit `Button size="sm"`: `h-10` on a phone, `h-8` beside a cursor. */
function SmallButton({ width, className = "" }: { width: string; className?: string }) {
  return <Skeleton className={`h-10 ${width} rounded-full sm:h-8 ${className}`} />;
}

/** One side of a pair: a name over its detail line, then Keep this one. */
function RecordSideSkeleton({ i }: { i: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <TextLine line="h-6" bar={`h-3.5 ${NAME_W[i % NAME_W.length]}`} />
      <TextLine line="h-4" bar={`h-3 ${DETAIL_W[i % DETAIL_W.length]} max-w-full`} />
      <SmallButton width="w-28" className="mt-2" />
    </div>
  );
}

/**
 * Mirrors duplicates/page.tsx: a one-line helper under the header, then
 * duplicates-manager.tsx's own `space-y-4` root - the Scan contacts / Scan accounts
 * pair, and a stack of pending-pair cards. Each card is a "contact - matched on ..."
 * label with a pending chip, two record boxes side by side from `sm` (a name over its
 * detail line, and Keep this one), and Not a duplicate at the far right.
 */
export default function DuplicatesLoading() {
  return (
    <>
      <PageHeader title="Duplicates" context="Pipeline" />
      <div className="-mt-2">
        <TextLine line="h-5" bar="h-3.5 w-[64rem] max-w-full" />
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SmallButton width="w-28" />
          <SmallButton width="w-28" />
        </div>
        <div className="space-y-3">
          {REASON_W.map((reason, i) => (
            <Card key={i}>
              <div className="flex items-center justify-between gap-2">
                <TextLine line="h-4" bar={`h-3 ${reason}`} />
                <Skeleton className="h-5.5 w-20 rounded-full" />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <RecordSideSkeleton i={i * 2} />
                <RecordSideSkeleton i={i * 2 + 1} />
              </div>
              <div className="mt-3 flex justify-end">
                <SmallButton width="w-32" />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
