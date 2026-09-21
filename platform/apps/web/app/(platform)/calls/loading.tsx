import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton, TenantSwitcherSkeleton } from "@/components/skeletons";

/**
 * Mirrors calls/page.tsx: the tenant switcher, the All calls / Follow-ups view
 * toggle, a one-line "N calls" count, then the call log - an 8-column table
 * (call, date and time, instance, device, duration, source, consent, pipeline
 * chip) in a card. The switcher is drawn as it appears for an operator with
 * several tenants.
 */
export default function CallsLoading() {
  return (
    <>
      <PageHeader title="Call Log Explorer" />

      {/* TenantSwitcher: a label, then one pill per tenant (only shown for 2+). */}
      <TenantSwitcherSkeleton />

      {/* The two views: "All calls" is the active one. */}
      <div className="flex gap-2">
        <Skeleton className="h-8.5 w-20 rounded-md" />
        <Skeleton className="h-8.5 w-24 rounded-md" />
      </div>

      {/* Pager: "N calls" (the prev/next buttons only appear past 100). */}
      <div className="flex h-4 items-center">
        <Skeleton className="h-3 w-16" />
      </div>

      <TableBlockSkeleton
        variant="ledger"
        rows={6}
        columns={[
          "primary2", // call: direction icon, name, #id and contact history
          "date", // date and time
          "text", // instance
          "text", // device
          "num", // duration
          { kind: "text", track: "minmax(0,1fr)" }, // audio source
          { kind: "text", track: "minmax(0,1fr)" }, // consent
          "chip", // pipeline status
        ]}
      />
    </>
  );
}
