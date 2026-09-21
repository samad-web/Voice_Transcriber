import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, Skeleton } from "@aura/ui";
import { PageHeaderSkeleton, TabsSkeleton } from "@/components/skeletons";

/** Widths for the six vitals cells, so the strip does not read as six identical bars. Literal classes. */
const VITALS = [
  { label: "w-10", value: "w-12", hint: "w-28" },
  { label: "w-16", value: "w-16", hint: "w-20" },
  { label: "w-14", value: "w-8", hint: "w-16" },
  { label: "w-20", value: "w-10", hint: "w-20" },
  { label: "w-16", value: "w-10", hint: "w-24" },
  { label: "w-20", value: "w-8", hint: "w-24" },
] as const;

/** The overview's quick-action buttons ("Open call log", "Issue enrollment key", ...). */
const JUMP_W = ["w-32", "w-44", "w-48", "w-32"] as const;

/** Recent-calls rows: the width of the call's name and of its device. */
const CALL_ROWS = [
  { name: "w-32", device: "w-24" },
  { name: "w-40", device: "w-20" },
  { name: "w-28", device: "w-28" },
  { name: "w-36", device: "w-16" },
  { name: "w-24", device: "w-24" },
  { name: "w-32", device: "w-20" },
] as const;

/** One track template for the recent-calls header and every row, so the columns line up. */
const CALL_TRACKS = "minmax(0,2.2fr) minmax(0,1.4fr) minmax(0,0.8fr) minmax(0,1fr)";

/**
 * Mirrors instances/[id]/page.tsx on its default (Overview) tab: the back link
 * (static, so real), the tenant-named header (fetched, so skeletal), the vitals
 * card (a status/org/region/consent strip over six metric cells), the tab strip,
 * the quick-action buttons and the "Recent calls" panel - a titled card holding a
 * call / device / duration / status table.
 *
 * The real page nests vitals, tabs and panel in one `gap-5` column (InstanceTabs);
 * here they are direct children, so <main>'s own spacing applies between them.
 */
export default function InstanceDetailLoading() {
  return (
    <>
      <Link
        href="/instances"
        className="inline-flex items-center gap-1.5 self-start rounded-sm text-sm font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        All instances
      </Link>

      <PageHeaderSkeleton context="Instance" />

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-subtle px-4 py-2.5 sm:px-5">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-3 w-44" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-36 sm:ml-auto" />
        </div>
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
          {VITALS.map((v, i) => (
            <div key={i} className="bg-surface px-4 py-3 sm:px-5">
              <div className="flex h-4 items-center">
                <Skeleton className={`h-2.5 ${v.label}`} />
              </div>
              <div className="mt-1 flex h-7.5 items-center">
                <Skeleton className={`h-6 ${v.value}`} />
              </div>
              <div className="mt-0.5 flex h-4 items-center">
                <Skeleton className={`h-2.5 ${v.hint}`} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <TabsSkeleton tabs={5} />

      <div className="flex flex-wrap gap-2">
        {JUMP_W.map((w, i) => (
          <Skeleton key={i} className={`h-9.5 rounded-md ${w}`} />
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-bg-subtle px-5 py-3">
          <div className="flex h-5 items-center gap-2">
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="h-3.5 w-24" />
          </div>
          <Skeleton className="h-3.5 w-14" />
        </div>

        <div className="min-w-[36rem]">
          <div
            className="grid items-center gap-4 border-b border-border bg-bg-subtle px-4 py-3"
            style={{ gridTemplateColumns: CALL_TRACKS }}
          >
            <div className="flex h-4 items-center">
              <Skeleton className="h-2.5 w-10" />
            </div>
            <div className="flex h-4 items-center">
              <Skeleton className="h-2.5 w-14" />
            </div>
            <div className="flex h-4 items-center justify-end">
              <Skeleton className="h-2.5 w-12" />
            </div>
            <div className="flex h-4 items-center">
              <Skeleton className="h-2.5 w-12" />
            </div>
          </div>

          <div className="divide-y divide-border">
            {CALL_ROWS.map((row, i) => (
              <div
                key={i}
                className="grid items-center gap-4 px-4 py-2.5"
                style={{ gridTemplateColumns: CALL_TRACKS }}
              >
                <div className="min-w-0 space-y-2">
                  <Skeleton className={`h-3.5 ${row.name}`} />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className={`h-3 ${row.device}`} />
                <div className="flex justify-end">
                  <Skeleton className="h-3 w-10" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}
