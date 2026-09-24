import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Cards per group, as an owner sees them (OWNER_SETTINGS_GROUPS). */
const GROUP_SIZES = [2, 4, 4, 2, 3] as const;
/** Complete class strings, picked by index, so the cards are not copies of one another. */
const NAME_W = ["w-32", "w-20", "w-24", "w-40", "w-28", "w-36"] as const;
const HEAD_W = ["w-12", "w-32", "w-20", "w-28", "w-24"] as const;

/**
 * Mirrors settings/page.tsx for an owner: a group heading over a grid of
 * cards, each an icon, a name, a one-line description and a chevron. A
 * narrower persona sees fewer groups, which a loader cannot know without
 * fetching - drawing the owner's layout errs on the side of the page shrinking
 * on arrival, never growing.
 */
export default function SettingsLoading() {
  return (
    <>
      <PageHeader title="Settings" context="Workspace" />
      {GROUP_SIZES.map((size, g) => (
        <div key={g} className="space-y-3">
          <div className="flex h-5 items-center">
            <Skeleton className={`h-3.5 ${HEAD_W[g]}`} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: size }, (_, i) => (
              <div key={i} className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
                <Skeleton className="h-5 w-5 shrink-0 rounded-md" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className={`h-3.5 ${NAME_W[(g + i) % NAME_W.length]}`} />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
