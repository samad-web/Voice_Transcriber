import { Card, Skeleton } from "@aura/ui";
import { NavPageHeader } from "@/components/nav-page-header";
import { IntroSkeleton, TabsSkeleton } from "@/components/skeletons";

/** The headcount strip's chips ("1 Owner", "2 Manager", ...). */
const COUNT_W = ["w-20", "w-24", "w-24", "w-20"] as const;

/** Complete class strings, picked by index, so Tailwind can see every one. */
const NAME_W = ["w-36", "w-44", "w-32", "w-40", "w-28"] as const;
const EMAIL_W = ["w-48", "w-40", "w-52", "w-44", "w-36"] as const;

/**
 * The roster's column tracks. Person is the widest (name, email, chips, the Staff
 * details link), the two persona/identity pickers next, then a spacer for the
 * "Saving..." status, and the row actions last.
 */
const ROSTER_COLS =
  "minmax(0,1.5fr) minmax(0,1.3fr) minmax(0,1fr) minmax(0,1.1fr) 2rem minmax(0,1.5fr)";

/** A line of `text-xs leading-relaxed` copy: 19.5px, with the bar centred in it. */
function NoteLine({ width }: { width: string }) {
  return (
    <div className="flex h-[19.5px] items-center">
      <Skeleton className={`h-2.5 ${width}`} />
    </div>
  );
}

/** One roster row, drawn from team-table.tsx's `Row` - every cell `align-top`. */
function RosterRowSkeleton({ i }: { i: number }) {
  return (
    <div className="grid items-start gap-4 px-4 py-3" style={{ gridTemplateColumns: ROSTER_COLS }}>
      {/* Person: name, email, the chips (you / staff code), then "Staff details". */}
      <div className="min-w-0">
        <div className="flex h-[21px] items-center">
          <Skeleton className={`h-3.5 ${NAME_W[i % NAME_W.length]}`} />
        </div>
        <div className="flex h-[18px] items-center">
          <Skeleton className={`h-2.5 ${EMAIL_W[i % EMAIL_W.length]}`} />
        </div>
        <div className="mt-1.5 flex gap-1.5">
          {i === 0 ? <Skeleton className="h-6 w-10 rounded-full" /> : null}
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
        <div className="mt-1.5 flex h-[18px] items-center">
          <Skeleton className="h-2.5 w-20" />
        </div>
      </div>

      {/* Role: the persona picker over its two-line description. */}
      <div className="min-w-0">
        <Skeleton className="h-9.5 w-full" />
        <div className="mt-1.5 max-w-xs">
          <NoteLine width="w-full" />
          <NoteLine width="w-3/4" />
        </div>
      </div>

      {/* Telecaller identity: a single picker. */}
      <div className="min-w-0">
        <Skeleton className="h-9.5 w-full" />
      </div>

      {/* Permissions: the role picker over its three-line note. */}
      <div className="min-w-0">
        <Skeleton className="h-9.5 w-full" />
        <div className="mt-1.5 max-w-[13rem]">
          <NoteLine width="w-full" />
          <NoteLine width="w-full" />
          <NoteLine width="w-2/3" />
        </div>
      </div>

      <div />

      {/* Row actions: Reset password, Suspend, Remove - full-size buttons in a row. */}
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-10 w-32 rounded-full" />
        <Skeleton className="h-10 w-20 rounded-full" />
        <Skeleton className="h-10 w-20 rounded-full" />
      </div>
    </div>
  );
}

/**
 * The roster: a card holding a `min-w-[720px]` table whose rows are about 130px
 * tall, because every cell stacks a control over its explanation. Drawing it as
 * one-line rows understated the table by ~85px a row, so the page below it jumped
 * by most of a screen on arrival.
 */
function RosterSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-hidden">
        <div className="min-w-[720px]">
          <div
            className="grid items-center gap-4 border-b border-border bg-bg-subtle px-4 py-2.5"
            style={{ gridTemplateColumns: ROSTER_COLS }}
          >
            {["w-12", "w-8", "w-28", "w-20"].map((w) => (
              <div key={w} className="flex h-[18px] items-center">
                <Skeleton className={`h-2.5 ${w}`} />
              </div>
            ))}
          </div>
          <div className="divide-y divide-border">
            {[0, 1, 2, 3, 4].map((i) => (
              <RosterRowSkeleton key={i} i={i} />
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Mirrors staff/page.tsx on its default Team tab, as an owner sees it: the
 * three bordered section links, the "What each role sees" card (five roles in a
 * two-column list), the headcount strip, the Add someone button, the roster
 * table (person, role, telecaller identity, permissions, row actions) and the
 * closing note. The roles and performance tabs draw their own content in place.
 */
export default function StaffLoading() {
  return (
    <>
      {/* "Staff" to an owner, "Team" to a manager - the rail's word for it. */}
      <NavPageHeader href="/owner/staff" fallback="Staff" context="Workspace" />

      <TabsSkeleton variant="boxed" tabs={3} />

      <Card className="space-y-3">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-36" />
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex gap-2">
              <div className="w-24 shrink-0">
                <Skeleton className="h-3.5 w-16" />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="mr-1 h-3 w-16" />
        {COUNT_W.map((w, i) => (
          <Skeleton key={i} className={`h-5.5 rounded-full ${w}`} />
        ))}
      </div>

      <div>
        <Skeleton className="h-10 w-32 rounded-full" />
      </div>

      <RosterSkeleton />

      <IntroSkeleton lines={2} />
    </>
  );
}
