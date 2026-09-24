import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const NAME_W = ["w-36", "w-28", "w-40", "w-32"] as const;
const META_W = ["w-96", "w-80", "w-[22rem]", "w-72"] as const;

/**
 * One handset row: its label and up to three chips (Active / Retired, the
 * telecaller it is bound to, a health chip), a mono line under it (instance,
 * app and Android versions, call count, last call), and the Retire button.
 */
function HandsetRowSkeleton({ i }: { i: number }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-6 items-center">
            <Skeleton className={`h-3.5 ${NAME_W[i % NAME_W.length]}`} />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <div className="mt-0.5 flex h-4 items-center">
          <Skeleton className={`h-2.5 ${META_W[i % META_W.length]} max-w-full`} />
        </div>
      </div>
      <Skeleton className="h-10 w-16 rounded-full sm:h-8" />
    </li>
  );
}

/**
 * Mirrors devices/page.tsx (DevicesClient), whose root is its own `mt-6
 * space-y-6` column: a "Pair a handset" card (label, two lines on installing
 * the app and scanning the code, the Pair button) above the Handsets card (label,
 * then a divided list of handsets). Also what /owner/handsets shows, which only
 * redirects here.
 *
 * The empty state (no handsets paired yet) and the pairing dialog are not drawn;
 * the fleet list is the common case for the people who visit this page.
 */
export default function DevicesLoading() {
  return (
    <>
      <PageHeader title="Phones" context="Settings" />

      <div className="mt-6 space-y-6">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex h-4 items-center">
                <Skeleton className="h-3 w-28" />
              </div>
              <div className="mt-2 max-w-xl">
                <div className="flex h-5 items-center">
                  <Skeleton className="h-3.5 w-full" />
                </div>
                <div className="flex h-5 items-center">
                  <Skeleton className="h-3.5 w-3/4" />
                </div>
              </div>
            </div>
            <Skeleton className="h-10 w-36 shrink-0 rounded-full" />
          </div>
        </Card>

        <Card>
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-20" />
          </div>
          <ul className="mt-4 divide-y divide-border">
            {[0, 1, 2, 3].map((i) => (
              <HandsetRowSkeleton key={i} i={i} />
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
