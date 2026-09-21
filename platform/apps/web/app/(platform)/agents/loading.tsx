import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TenantSwitcherSkeleton } from "@/components/skeletons";

/** Complete class strings, picked by index, so Tailwind can see every one. */
const AGENT_NAME = ["w-32", "w-40", "w-28"] as const;

/**
 * A label over a control. `control` is one of the real control heights: 38px
 * (the kit's Select), 44px (the studio's hand-rolled text inputs), or a
 * textarea. A literal union, so every class is visible to Tailwind.
 */
function Field({ control }: { control: "h-9.5" | "h-11" | "h-24" }) {
  return (
    <div className="space-y-1.5">
      <div className="flex h-4 items-center">
        <Skeleton className="h-2.5 w-24" />
      </div>
      <Skeleton className={`${control} w-full rounded-sm`} />
    </div>
  );
}

/** A card heading: a 16px icon beside a `text-lg` title. */
function CardTitle({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex h-7 items-center gap-2">
      <Skeleton className="size-4 shrink-0" />
      <Skeleton className={wide ? "h-5 w-72 max-w-full" : "h-5 w-40"} />
    </div>
  );
}

/**
 * Mirrors agents/page.tsx: the tenant switcher, then the studio - a narrow
 * "Deployed Agents" list beside a wide builder column (Describe With AI, the
 * New Agent form with one extraction field, the live compiled schema) - and
 * the Sandbox card underneath.
 */
export default function AgentsLoading() {
  return (
    <>
      {/* The eyebrow is the tenant's name once loaded; "Workspace" is the page's own fallback. */}
      <PageHeader title="AI Agent Studio" context="Workspace" />

      {/* TenantSwitcher: a label, then one pill per tenant (only shown for 2+). */}
      <TenantSwitcherSkeleton />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4">
          <Card elevated>
            <div className="mb-4 flex h-4 items-center">
              <Skeleton className="h-3 w-28" />
            </div>
            <div className="space-y-3">
              {AGENT_NAME.map((name, i) => (
                <div key={i} className="rounded-md border border-border p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1.5">
                      <Skeleton className={`h-3.5 ${name}`} />
                      <Skeleton className="h-2.5 w-20" />
                    </div>
                    <Skeleton className="h-6 w-16 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card elevated className="space-y-4">
            <CardTitle />
            <IntroSkeleton lines={2} />
            <Skeleton className="h-20 w-full rounded-sm" />
            <Skeleton className="h-10 w-28 rounded-full" />
          </Card>

          <Card elevated className="space-y-4">
            <CardTitle />
            <Field control="h-9.5" />
            <Field control="h-11" />
            <Field control="h-24" />

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-2.5 w-32" />
                <Skeleton className="h-10 w-28 rounded-full" />
              </div>
              {/* One extraction field: key, type, description, enum values, then Required and remove. */}
              <div className="grid grid-cols-1 gap-3 rounded-md border border-border bg-bg-subtle p-3.5 md:grid-cols-2">
                <Skeleton className="h-11 w-full rounded-sm" />
                <Skeleton className="h-9.5 w-full rounded-sm" />
                <Skeleton className="h-11 w-full rounded-sm md:col-span-2" />
                <Skeleton className="h-11 w-full rounded-sm md:col-span-2" />
                <div className="flex items-center justify-between md:col-span-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-4 shrink-0" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                  <Skeleton className="size-8 rounded-md" />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 shrink-0" />
                <Skeleton className="h-3 w-36" />
              </div>
              <Skeleton className="h-10 w-40 rounded-full" />
            </div>
          </Card>

          <Card elevated>
            <div className="mb-2 flex h-4 items-center">
              <Skeleton className="h-2.5 w-56" />
            </div>
            <Skeleton className="h-48 w-full" />
          </Card>
        </div>
      </div>

      <Card elevated className="space-y-4">
        <CardTitle wide />
        <IntroSkeleton lines={1} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field control="h-9.5" />
          <Field control="h-11" />
          <Field control="h-11" />
        </div>
        <Skeleton className="h-10 w-full rounded-full" />
      </Card>
    </>
  );
}
