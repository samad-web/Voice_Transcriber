import { Card, Skeleton } from "@aura/ui";

/** The overview's quick-action links ("Open call log", "Issue enrollment key", ...). */
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
 * Mirrors instances/[id]/page.tsx - the Overview panel and nothing else: the
 * quick-action links and the "Recent calls" panel, a titled card holding a call /
 * device / duration / status table.
 *
 * It used to also draw the back link, the tenant header, the vitals card and the
 * tab strip. All four moved into `layout.tsx` (doc 34 Part B), which means they
 * are ALREADY on screen while this fallback shows - drawing skeletons of them
 * here would stack a second, grey copy of the header under the real one.
 */
export default function InstanceOverviewLoading() {
  return (
    <>
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
