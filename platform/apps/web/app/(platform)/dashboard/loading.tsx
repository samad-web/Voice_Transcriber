import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import {
  SectionHeadingSkeleton,
  StatGridSkeleton,
  TenantSwitcherSkeleton,
} from "@/components/skeletons";

/** One bar per day: the chart is a 7-day window. Inline heights, so not subject to the literal-class rule. */
const INGEST_PCT = [45, 70, 55, 90, 62, 38, 76] as const;

/** The "By tenant" grid: a wide name, then four figures. */
const TENANT_TRACK = "minmax(0,2.4fr) repeat(4,minmax(0,1fr))";
/** Complete class strings, picked by index, so Tailwind can see every one. */
const TENANT_HEAD = ["w-14", "w-10", "w-12", "w-14", "w-16"] as const;
const TENANT_NAME = ["w-36", "w-44", "w-32", "w-40", "w-28"] as const;
const TENANT_FIGURE = ["w-8", "w-10", "w-6", "w-12"] as const;
const TENANT_DATE = ["w-20", "w-24", "w-20", "w-28", "w-24"] as const;

/**
 * The "By tenant" card: a heading strip over a five-column ledger (tenant,
 * calls, failed, minutes, last call). TableBlockSkeleton draws its own Card and
 * has no heading strip, so this is drawn here rather than nesting one frame in
 * another.
 */
function ByTenantSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b-2 border-border-strong bg-bg-subtle px-5 py-3.5">
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="min-w-[40rem]">
        <div
          className="grid items-center gap-4 border-b-2 border-border bg-bg-subtle px-5 py-3"
          style={{ gridTemplateColumns: TENANT_TRACK }}
        >
          {TENANT_HEAD.map((w, c) => (
            <div key={c} className="flex h-4 items-center">
              <Skeleton className={`h-2.5 ${w}`} />
            </div>
          ))}
        </div>
        <div className="divide-y-2 divide-border">
          {TENANT_NAME.map((name, r) => (
            <div
              key={r}
              className="grid items-center gap-4 px-5 py-3.5"
              style={{ gridTemplateColumns: TENANT_TRACK }}
            >
              <div className="flex h-5 items-center">
                <Skeleton className={`h-3.5 ${name}`} />
              </div>
              {[0, 1, 2].map((c) => (
                <div key={c} className="flex h-5 items-center">
                  <Skeleton className={`h-3 ${TENANT_FIGURE[(r + c) % TENANT_FIGURE.length]}`} />
                </div>
              ))}
              <div className="flex h-5 items-center">
                <Skeleton className={`h-3 ${TENANT_DATE[r % TENANT_DATE.length]}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/**
 * Mirrors dashboard/page.tsx: two stacked sections. The fleet rollup (heading,
 * 4 stat tiles, the "By tenant" ledger), then one tenant under a hairline rule
 * (heading named after the tenant, tenant switcher, 4 stat tiles, a 7-day
 * call-ingest bar chart). The two `<section>`s are the page's own wrappers,
 * kept because they set a tighter rhythm than the layout's.
 */
export default function DashboardLoading() {
  return (
    <>
      <PageHeader title="Platform Hub" />

      <section className="space-y-4">
        <SectionHeadingSkeleton />
        <StatGridSkeleton count={4} />
        <ByTenantSkeleton />
      </section>

      <section className="space-y-4 border-t-2 border-border-strong pt-6">
        <SectionHeadingSkeleton />

        {/* TenantSwitcher: a label, then one pill per tenant (only shown for 2+). */}
        <TenantSwitcherSkeleton />

        <StatGridSkeleton count={4} />

        <Card>
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-56" />
          </div>
          <div className="mt-4 flex h-40 items-end gap-2">
            {INGEST_PCT.map((pct, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
                <div className="flex h-32 w-full flex-col justify-end">
                  <div className="w-full" style={{ height: `${pct}%` }}>
                    <Skeleton className="h-full w-full" />
                  </div>
                </div>
                <Skeleton className="h-2.5 w-8" />
              </div>
            ))}
          </div>
        </Card>
      </section>
    </>
  );
}
