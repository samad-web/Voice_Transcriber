import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { StorageVital, storageFromOrg } from "@/components/storage-vital";
import { operatorGate } from "@/lib/operator-gate";
import { CopyValue } from "./copy-value";
import { loadVitals } from "./instance-data";
import { InstanceTabs } from "./instance-tabs";
import { Metric } from "./instance-ui";

/**
 * Chrome for every page about one customer: who they are, how they are doing,
 * and the strip that moves between their pages.
 *
 * ── WHY A LAYOUT ────────────────────────────────────────────────────────────
 *
 * All of this used to be the top of a single 1171-line page that drew five
 * panels behind a client-side tab strip. Doc 34 Part B split those panels into
 * routes and moved seven more tenant screens in beside them, which needs the
 * header and the strip to be drawn ONCE, above whichever page is showing - the
 * same reasoning the owner layout gives for `ConsoleSectionTabs`: a strip that
 * each page rendered for itself is a line thirteen pages have to remember, and
 * it would flash away and back on every tab change instead of staying put while
 * the next page's server data loads.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 *
 * `operatorGate()` first, before `loadVitals` reads anything. `(platform)`'s own
 * layout also gates, and this is not redundant: Next renders nested layouts and
 * their page in one pass, so an ancestor's `isOperator()` is not guaranteed to
 * have resolved before this file's fetch goes out. Every page nested here gates
 * for itself too, for the same reason - see `platform-pages.guard.test.ts`.
 *
 * ── WHAT IT COSTS ───────────────────────────────────────────────────────────
 *
 * `loadVitals` is six reads, and they happen on all thirteen routes - the one
 * cost the split does not remove. Deliberate: the strip is how an operator knows
 * which customer they are looking at and whether anything is wrong, and a header
 * that changed shape per route would be worse than a little repeated fetching.
 * Everything heavier - the audit ledger, the CRM catalogue, the owner logins -
 * is now paid for only by the route that renders it.
 */
export default async function InstanceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const { org, instances, owners, callStats, deviceTotal, activeKeys, flagged } =
    await loadVitals(orgId);
  const recordedMinutes = Math.round((callStats?.total_seconds ?? 0) / 60);

  return (
    <>
      {/* Breadcrumb above the title, not below it: the way back should be the
          first thing in the reading order, not something found after the page
          heading has already been read. */}
      <Link
        href="/instances"
        className="inline-flex items-center gap-1.5 self-start rounded-sm text-sm font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        All instances
      </Link>

      <PageHeader title={org.name} context="Instance" />

      {/* ── Vitals ────────────────────────────────────────────────────────
          One card in place of the old five stat cards plus a separate tenant
          card. Same numbers, a third of the height, and the cells that go
          somewhere are now real links rather than buttons driving a
          client-side tab switch. */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-subtle px-4 py-2.5 sm:px-5">
          <StatusChip tone={org.status === "active" ? "solid" : "muted"}>{org.status}</StatusChip>
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            Org
            <CopyValue value={org.id} label="org ID" className="text-text" />
          </span>
          <span className="text-xs text-text-muted">
            Region <span className="font-mono text-text">{org.region}</span>
          </span>
          <span className="text-xs text-text-muted">
            Consent{" "}
            <span className="font-mono text-text">{org.consent_policy.replace(/_/g, " ")}</span>
          </span>
          <span className="text-xs text-text-muted sm:ml-auto">
            {instances.length} {instances.length === 1 ? "instance" : "instances"} · {owners.length}{" "}
            {owners.length === 1 ? "owner login" : "owner logins"}
          </span>
        </div>

        {/* gap-px over a bg-border grid: exact 1px separators at every column
            count, without per-cell border rules that break on the last column. */}
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
          <Metric
            label="Calls"
            value={(callStats?.total ?? 0).toLocaleString()}
            hint={`${(callStats?.failed ?? 0).toLocaleString()} failed · call log`}
            href={`/instances/${orgId}/calls`}
          />
          <Metric
            label="Recorded"
            value={`${recordedMinutes.toLocaleString()} min`}
            hint={`${(callStats?.complete ?? 0).toLocaleString()} complete`}
          />
          <Metric
            label="Devices"
            value={deviceTotal.toLocaleString()}
            hint="Open fleet"
            href={`/instances/${orgId}/devices`}
          />
          <Metric
            label="Active keys"
            value={activeKeys.toLocaleString()}
            hint="Issue a key"
            href={`/instances/${orgId}/devices#enrollment`}
          />
          <Metric
            label="Retention"
            value={`${org.retention_days}d`}
            hint="Consent policy"
            href={`/instances/${orgId}/settings`}
          />
          {flagged > 0 ? (
            <Metric
              label="Needs attention"
              value={flagged.toLocaleString()}
              state="error"
              hint={flagged === 1 ? "1 handset flagged" : `${flagged} handsets flagged`}
              href={`/instances/${orgId}/devices`}
            />
          ) : (
            <Metric
              label="Fleet health"
              value={deviceTotal === 0 ? "-" : "OK"}
              hint={deviceTotal === 0 ? "No handsets yet" : "Nothing flagged"}
            />
          )}
        </div>
        {/* A row of its own rather than a seventh cell: it carries a meter, and
            the six-cell grid divides evenly at every breakpoint as it is. */}
        <div className="border-t border-border">
          <StorageVital storage={storageFromOrg(org)} retentionPaused={org.status !== "active"} />
        </div>
      </Card>

      <InstanceTabs orgId={orgId} />

      {children}
    </>
  );
}
