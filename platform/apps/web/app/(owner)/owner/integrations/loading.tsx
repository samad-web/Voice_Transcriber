import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so the tiles are not copies of one another. */
const NAME_BAR = ["h-3.5 w-36", "h-3.5 w-28", "h-3.5 w-40", "h-3.5 w-32"] as const;
const VENDOR_BAR = ["h-3 w-24", "h-3 w-20", "h-3 w-28"] as const;
const BLURB_TAIL = ["h-3 w-2/3", "h-3 w-1/2", "h-3 w-3/4", "h-3 w-3/5"] as const;
const CHIP_BAR = ["h-5.5 w-24 rounded-full", "", "h-5.5 w-20 rounded-full", ""] as const;
const VIEW_CHIP = ["w-10", "w-22", "w-30", "w-14"] as const;
const CATEGORY_CHIP = ["w-28", "w-20", "w-24", "w-18", "w-20", "w-28"] as const;

/** One tile, as app-tile.tsx draws it: logo, name and maker, two lines of blurb, chip and button. */
function TileSkeleton({ i }: { i: number }) {
  const chip = CHIP_BAR[i % CHIP_BAR.length];
  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-1.5 pt-1">
          <Skeleton className={NAME_BAR[i % NAME_BAR.length]} />
          <Skeleton className={VENDOR_BAR[i % VENDOR_BAR.length]} />
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className={BLURB_TAIL[i % BLURB_TAIL.length]} />
      </div>
      <div className="mt-auto flex min-h-10 items-center justify-between gap-2 pt-4">
        {chip ? <Skeleton className={chip} /> : <span />}
        <Skeleton className="h-10 w-20 rounded-full sm:h-8" />
      </div>
    </div>
  );
}

/**
 * Mirrors integrations/page.tsx and the StoreBrowser it mounts: the one-line
 * summary under the header, the search box beside the four view chips, the
 * category chips, then the first category's label over the tile grid - one
 * column, two from `md`, three from `xl`. The later categories are below the
 * fold and left out.
 */
export default function IntegrationsLoading() {
  return (
    <>
      <PageHeader
        title="Integrations"
        context="Workspace"
        description="Connect the apps your team already uses. Nothing here sends on its own."
      />

      <div className="-mt-2 flex h-[21px] items-center">
        <Skeleton className="h-3.5 w-40" />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Skeleton className="h-[38px] w-full rounded-sm sm:max-w-sm" />
          <div className="flex flex-wrap gap-1.5">
            {VIEW_CHIP.map((w, i) => (
              <Skeleton key={i} className={`h-10 rounded-full sm:h-7 ${w}`} />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORY_CHIP.map((w, i) => (
            <Skeleton key={i} className={`h-10 rounded-full sm:h-7 ${w}`} />
          ))}
        </div>
      </div>

      <section className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <TileSkeleton key={i} i={i} />
          ))}
        </div>
      </section>
    </>
  );
}
