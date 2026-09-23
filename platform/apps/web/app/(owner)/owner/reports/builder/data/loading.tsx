import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * Line boxes, from the theme's 1.5 line-height (theme.css): `text-sm` 21px,
 * `text-xs` 18px, and `text-xs leading-snug` or `text-[11px]` 16.5px. A bare bar is
 * shorter than the line it stands in for, and a dozen of them add up to a visible jump.
 */
const BOX = { sm: "h-[21px]", xs: "h-[18px]", snug: "h-[16.5px]" } as const;

/** One line of text: `bar` (a literal `h-* w-*` pair) centred in that line's box. */
function Line({ box, bar }: { box: keyof typeof BOX; bar: string }) {
  return (
    <div className={`flex items-center ${BOX[box]}`}>
      <Skeleton className={bar} />
    </div>
  );
}

/** CRM source names ("Leads", "Marketing sources"), and where each description's last line ends. */
const SOURCE_NAME_W = ["w-16", "w-20", "w-16", "w-14", "w-16", "w-32", "w-20"] as const;
const SOURCE_TAIL_W = ["w-2/3", "w-1/2", "w-3/4", "w-3/5"] as const;

/**
 * One CRM source, as the catalogue lists it: an icon and a name, a two-line
 * description, a column count, then a Connect button - or, once connected, a chip.
 * The fifth source (marketing) is not scopable, so its count line runs longer.
 */
function SourceCardSkeleton({ i }: { i: number }) {
  const connected = i % 3 === 1;
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <Skeleton className="size-4 shrink-0" />
        <Line box="sm" bar={`h-3.5 ${SOURCE_NAME_W[i % SOURCE_NAME_W.length]}`} />
      </div>
      <div className="mt-1 flex-1">
        <Line box="snug" bar="h-2.5 w-full" />
        <Line box="snug" bar={`h-2.5 ${SOURCE_TAIL_W[i % SOURCE_TAIL_W.length]}`} />
      </div>
      <div className="mt-1">
        <Line box="snug" bar={i === 5 ? "h-2.5 w-64 max-w-full" : "h-2.5 w-16"} />
      </div>
      <div className="mt-2">
        {connected ? (
          <Skeleton className="h-6 w-24 rounded-full" />
        ) : (
          <Skeleton className="h-10 w-18 rounded-full sm:h-8" />
        )}
      </div>
    </div>
  );
}

/**
 * The connected sources and uploaded files: a name over its rows/updated/used-by
 * line. Two are live CRM data (nothing to replace); two are uploads, which also
 * carry a Replace rows button.
 */
const DATASETS = [
  { upload: false, name: "w-24", sub: "w-52" },
  { upload: true, name: "w-40", sub: "w-80" },
  { upload: false, name: "w-28", sub: "w-44" },
  { upload: true, name: "w-36", sub: "w-72" },
] as const;

/**
 * Mirrors reports/builder/data/page.tsx: the back link and the intro paragraph
 * under the header, then two cards. "From your CRM" is a caption and a note over
 * a grid of the seven CRM sources - each an icon and name, a two-line
 * description, a column count and a Connect button or a connected chip. "Your
 * data sources" is its Upload CSV button beside the caption, over a divided list
 * of connected sources and uploaded files, each with a remove button and, for
 * an upload, a Replace rows button.
 */
export default function DataSourcesLoading() {
  return (
    <>
      <PageHeader title="Data sources" context="Report builder" />

      <div className="-mt-2 max-w-3xl">
        <Line box="sm" bar="h-3.5 w-full" />
        <Line box="sm" bar="h-3.5 w-full" />
        <Line box="sm" bar="h-3.5 w-1/2" />
      </div>

      <Card>
        <Line box="xs" bar="h-3 w-28" />
        <div className="mt-1">
          <Line box="xs" bar="h-2.5 w-full" />
          <Line box="xs" bar="h-2.5 w-1/5" />
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {SOURCE_NAME_W.map((_, i) => (
            <SourceCardSkeleton key={i} i={i} />
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Line box="xs" bar="h-3 w-32" />
          <Skeleton className="h-10 w-28 rounded-full sm:h-8" />
        </div>

        <div className="mt-3 divide-y divide-border">
          {DATASETS.map((dataset, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <Line box="sm" bar={`h-3.5 ${dataset.name}`} />
                <Line box="xs" bar={`h-2.5 ${dataset.sub}`} />
              </div>
              {dataset.upload ? <Skeleton className="h-10 w-28 rounded-full sm:h-8" /> : null}
              <Skeleton className="h-10 w-12 rounded-full sm:h-8 sm:w-10" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
