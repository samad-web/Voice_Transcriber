import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import {
  FormFieldsSkeleton,
  IntroSkeleton,
  TablePanelSkeleton,
  TabsSkeleton,
  TenantSwitcherSkeleton,
} from "@/components/skeletons";

/**
 * Mirrors client-config/page.tsx on its default (Team) tab: the header (the
 * title is fixed, the eyebrow becomes the client's name), a three-line intro,
 * the client switcher, the three boxed section tabs, then TeamManager's grid -
 * on the left a Members card (a head strip over a table of name-over-email, a
 * role chip stacked on its dropdown, a CRM-role dropdown, the listen/export
 * chips and a remove button) above an Add-member form; on the right a
 * Workspaces card.
 *
 * The tab lives in the query string and a loader cannot read it, so the Roles
 * and API keys tabs show this shape while they load. It is the default tab, and
 * the one an operator arrives on from the rail.
 */
export default function ClientConfigLoading() {
  return (
    <>
      <PageHeader title="Client Configuration" context="Client" />
      <IntroSkeleton lines={3} />
      <TenantSwitcherSkeleton />
      <TabsSkeleton variant="boxed" tabs={3} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <TablePanelSkeleton
            columns={["primary2", "chipSelect", "select", "chip", "actions"]}
            rows={4}
          />

          <Card className="space-y-4">
            <div className="flex h-5 items-center gap-2">
              <Skeleton className="size-4 shrink-0" />
              <Skeleton className="h-3.5 w-24" />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <FormFieldsSkeleton fields={3} submit={false} />
              <div className="flex flex-wrap items-end gap-4 pb-1">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-16" />
              </div>
            </div>
            <div className="flex items-center justify-end">
              <Skeleton className="h-9 w-36 rounded-full" />
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="space-y-4">
            <Skeleton className="h-3 w-24" />
            <div className="space-y-3">
              {[0, 1].map((i) => (
                <div key={i} className="rounded-md border border-border bg-surface p-3.5">
                  <div className="flex h-5 items-center">
                    <Skeleton className="h-3.5 w-32" />
                  </div>
                  <div className="flex h-4 items-center">
                    <Skeleton className="h-2.5 w-40" />
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2 border-t border-border pt-4">
              <FormFieldsSkeleton fields={1} submit={false} />
              <Skeleton className="h-9 w-full rounded-full" />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
