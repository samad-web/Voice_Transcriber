import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import {
  StatGridSkeleton,
  TableBlockSkeleton,
  TenantSwitcherSkeleton,
} from "@/components/skeletons";

/**
 * Mirrors usage/page.tsx: the header (its title is static, only the eyebrow is
 * the tenant's name), the client switcher, the billing-period chip, four KPI
 * tiles, then two side-by-side cards - storage (a size and one meter) and
 * invoices (an invoice / period / amount / status table).
 */
export default function UsageLoading() {
  return (
    <>
      <PageHeader title="Usage & Billing" context="Workspace" />

      {/* TenantSwitcher: a caption over one pill per client. */}
      <TenantSwitcherSkeleton />

      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-44 rounded-full" />
      </div>

      <StatGridSkeleton count={4} columns={4} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* The Storage vital (doc 27 §6.4): label and count, the size, a meter. */}
        <Card elevated className="space-y-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-2 w-full rounded-full" />
        </Card>

        <Card elevated className="space-y-4">
          <Skeleton className="h-3 w-20" />
          <TableBlockSkeleton columns={["text", "date", "num", "chip"]} rows={4} />
        </Card>
      </div>
    </>
  );
}
