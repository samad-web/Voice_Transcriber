import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FormFieldsSkeleton, TenantSwitcherSkeleton } from "@/components/skeletons";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const RULE_NAME = ["w-56", "w-44", "w-64"] as const;
const RULE_FLOW = ["w-80", "w-72", "w-96"] as const;
const RUN_NAME = ["w-40", "w-32", "w-48", "w-36", "w-44"] as const;
const RUN_DETAIL = ["w-56", "w-48", "w-52", "w-44", "w-56"] as const;

/**
 * Mirrors automations/page.tsx: the tenant switcher, then three stacked cards.
 * "New rule": a two-up form (name, when, stage filter, minimum amount, then,
 * title, due in), a one-line note and the Create button. "Rules": a bordered
 * list of rules with a status chip, Pause and Delete. "Recent activity": a note
 * over a bordered log of fired / no-match runs.
 */
export default function AutomationsLoading() {
  return (
    <>
      {/* The eyebrow is the tenant's name once loaded; "Workspace" is the page's own fallback. */}
      <PageHeader title="Automations" context="Workspace" />

      {/* TenantSwitcher: a label, then one pill per tenant (only shown for 2+). */}
      <TenantSwitcherSkeleton />

      <Card>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-20" />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <FormFieldsSkeleton fields={7} submit={false} />
        </div>
        <div className="mt-3 flex h-4 items-center">
          <Skeleton className="h-3 w-full max-w-lg" />
        </div>
        <div className="mt-3">
          <Skeleton className="h-10 w-32 rounded-full" />
        </div>
      </Card>

      <Card>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="mt-3 divide-y divide-border rounded-md border border-border">
          {RULE_NAME.map((name, i) => (
            <div key={i} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex h-5 items-center">
                  <Skeleton className={`h-3.5 ${name}`} />
                </div>
                <div className="mt-0.5 flex h-4 items-center">
                  <Skeleton className={`h-3 ${RULE_FLOW[i % RULE_FLOW.length]} max-w-full`} />
                </div>
                <div className="mt-0.5 flex h-4 items-center">
                  <Skeleton className="h-2.5 w-44" />
                </div>
              </div>
              <Skeleton className="h-6 w-14 rounded-full" />
              <Skeleton className="h-10 w-16 rounded-full sm:h-8" />
              <Skeleton className="h-10 w-16 rounded-full sm:h-8" />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="mt-1 flex h-4 items-center">
          <Skeleton className="h-3 w-full max-w-2xl" />
        </div>
        <div className="mt-3 divide-y divide-border rounded-md border border-border">
          {RUN_NAME.map((name, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2">
              <Skeleton className={`h-6 shrink-0 rounded-full ${i % 2 === 0 ? "w-14" : "w-20"}`} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className={`h-3 ${name}`} />
                <Skeleton className={`h-2.5 ${RUN_DETAIL[i % RUN_DETAIL.length]} max-w-full`} />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
