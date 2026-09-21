import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FormFieldsSkeleton, TenantSwitcherSkeleton } from "@/components/skeletons";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const TARGET_NAME = ["w-32", "w-24", "w-28"] as const;
const TARGET_DETAIL = ["w-72", "w-64", "w-80"] as const;

/**
 * Mirrors targets/page.tsx: the tenant switcher, then the "New target" form (a
 * three-up grid of who / measure / target / from / to, the month and quarter
 * shortcuts, a Set target button) over the "Current targets" card - a bordered
 * list of targets, each with its period, attainment, status chip and Delete.
 */
export default function TargetsLoading() {
  return (
    <>
      {/* The eyebrow is the tenant's name once loaded; "Workspace" is the page's own fallback. */}
      <PageHeader title="Targets" context="Workspace" />

      {/* TenantSwitcher: a label, then one pill per tenant (only shown for 2+). */}
      <TenantSwitcherSkeleton />

      <Card>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FormFieldsSkeleton fields={5} submit={false} />
          <div className="flex items-end gap-2">
            <Skeleton className="h-10 w-24 rounded-full sm:h-8" />
            <Skeleton className="h-10 w-28 rounded-full sm:h-8" />
          </div>
        </div>
        <div className="mt-3">
          <Skeleton className="h-10 w-28 rounded-full" />
        </div>
      </Card>

      <Card>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="mt-3 divide-y divide-border rounded-md border border-border">
          {TARGET_NAME.map((name, i) => (
            <div key={i} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex h-5 items-center">
                  <Skeleton className={`h-3.5 ${name}`} />
                </div>
                <div className="mt-0.5 flex h-4 items-center">
                  <Skeleton
                    className={`h-3 ${TARGET_DETAIL[i % TARGET_DETAIL.length]} max-w-full`}
                  />
                </div>
              </div>
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-6 w-16 rounded-full" />
              <Skeleton className="h-10 w-16 rounded-full sm:h-8" />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
