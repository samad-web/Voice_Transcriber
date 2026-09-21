import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TenantSwitcherSkeleton } from "@/components/skeletons";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const MARKET_W = ["w-12", "w-16", "w-14", "w-24"] as const;
const PROVIDER_NAME = ["w-20", "w-28", "w-24", "w-32", "w-16", "w-24"] as const;
const INTEGRATION_NAME = ["w-40", "w-32", "w-44"] as const;
const ACTION_W = ["w-28", "w-24", "w-24", "w-24", "w-24", "w-16"] as const;

/** One catalogue tile: provider name (sometimes with a market chip), two lines of blurb, a "N targets" footer. */
function ProviderTileSkeleton({ i }: { i: number }) {
  return (
    <div className="space-y-1.5 rounded-md border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <Skeleton className={`h-3.5 ${PROVIDER_NAME[i % PROVIDER_NAME.length]}`} />
        {i % 3 === 1 ? <Skeleton className="h-6 w-14 rounded-full" /> : null}
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="mt-1 h-2.5 w-24" />
    </div>
  );
}

/** One connected integration: name and endpoint, status chip, delivery counters, then the row of action buttons. */
function IntegrationCardSkeleton({ i }: { i: number }) {
  return (
    <Card elevated className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Skeleton className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 space-y-1.5">
            <Skeleton className={`h-3.5 ${INTEGRATION_NAME[i % INTEGRATION_NAME.length]}`} />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-6 w-20 shrink-0 rounded-full" />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {ACTION_W.map((w, c) => (
          <Skeleton key={c} className={`h-10 rounded-full sm:h-8 ${w}`} />
        ))}
        <Skeleton className="ml-auto size-8.5 shrink-0 rounded-md" />
      </div>
    </Card>
  );
}

/**
 * Mirrors crm/page.tsx: the tenant switcher, then two columns (one at narrow
 * widths). Left: the "Connect a CRM" catalogue (search, market filters, a grid
 * of provider tiles) over the "CRM not listed?" card. Right: the "Connected
 * integrations" count and a stack of integration cards.
 */
export default function CrmLoading() {
  return (
    <>
      {/* The eyebrow is the tenant's name once loaded; "Workspace" is the page's own fallback. */}
      <PageHeader title="CRM Integrations" context="Workspace" />

      {/* TenantSwitcher: a label, then one pill per tenant (only shown for 2+). */}
      <TenantSwitcherSkeleton />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Card elevated className="space-y-4">
            <div className="flex h-7 items-center gap-2">
              <Skeleton className="size-4 shrink-0" />
              <Skeleton className="h-5 w-36" />
            </div>
            <IntroSkeleton lines={2} />

            <div className="flex flex-col gap-3 sm:flex-row">
              <Skeleton className="h-9.5 w-full rounded-sm sm:flex-1" />
              <div className="flex gap-1.5">
                {MARKET_W.map((w, i) => (
                  <Skeleton key={i} className={`h-9.5 rounded-md ${w}`} />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <ProviderTileSkeleton key={i} i={i} />
              ))}
            </div>
          </Card>

          <Card className="space-y-3">
            <div className="flex h-5 items-center gap-2">
              <Skeleton className="size-4 shrink-0" />
              <Skeleton className="h-3.5 w-32" />
            </div>
            <IntroSkeleton lines={2} />
            <Skeleton className="h-10 w-52 rounded-full" />
          </Card>
        </div>

        <div className="space-y-4">
          <div className="flex h-4 items-center justify-between">
            <Skeleton className="h-3 w-36" />
            <Skeleton className="h-3 w-14" />
          </div>
          {[0, 1, 2].map((i) => (
            <IntegrationCardSkeleton key={i} i={i} />
          ))}
        </div>
      </div>
    </>
  );
}
