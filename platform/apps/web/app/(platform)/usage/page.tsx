import { Clock, Cpu, FileText, Phone, Smartphone } from "lucide-react";
import { Card, MonoLabel, StatCard, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { StorageVital, storageFromOrg, type OrgStorageFields } from "@/components/storage-vital";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";

interface UsageData {
  // The API returns a {start,end} range; tolerate a plain string too.
  period: { start: string; end: string } | string | null;
  metrics: {
    calls: number | null;
    minutes: number | null;
    llmTokensIn: number | null;
    llmTokensOut: number | null;
    devices: number | null;
    apiKeys: number | null;
  };
  limits: {
    callsPerMonth: number | null;
    tokensPerMonth: number | null;
  };
}

interface Invoice {
  id: string;
  number?: string;
  amount_due?: number;
  currency?: string;
  status?: string;
  period_start?: string;
  period_end?: string;
  hosted_invoice_url?: string;
}

/** Safe integer display - SUM() over no rows returns null once data is cleared. */
function n(value: number | null | undefined) {
  return (value ?? 0).toLocaleString();
}

function formatPeriod(period: UsageData["period"]): string | null {
  if (!period) return null;
  if (typeof period === "string") return period;
  const day = (s?: string) => (s ? new Date(s).toLocaleDateString() : "");
  const start = day(period.start);
  const end = day(period.end);
  return start && end ? `${start} - ${end}` : start || end || null;
}

/**
 * Metering and invoices for ONE customer. This page pinned itself to the
 * environment's dev org, which on a billing screen is the most expensive
 * possible default: every tenant's page showed the same tenant's consumption.
 */
export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  const [usage, billing, orgRow] = await Promise.all([
    apiGetAs<UsageData>("/v1/usage", orgId),
    apiGetAs<{ invoices: Invoice[] }>("/v1/billing/invoices", orgId),
    apiGetAs<OrgStorageFields & { status: string }>("/v1/org", orgId),
  ]);

  const periodLabel = usage ? formatPeriod(usage.period) : null;
  const tokensUsed = usage
    ? (usage.metrics.llmTokensIn ?? 0) + (usage.metrics.llmTokensOut ?? 0)
    : 0;

  return (
    <>
      <PageHeader title="Usage & Billing" context={activeTenant?.name ?? "Workspace"} />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/usage" />

      {usage === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API - start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {periodLabel ? (
            <div className="flex items-center gap-2">
              <MonoLabel>Billing period</MonoLabel>
              <StatusChip tone="muted">{periodLabel}</StatusChip>
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            <StatCard
              label="Calls Processed"
              value={n(usage.metrics.calls)}
              context="this billing period"
              icon={<Phone className="h-5 w-5" />}
            />
            <StatCard
              label="Recorded Minutes"
              value={n(usage.metrics.minutes)}
              context="metered from ingest"
              icon={<Clock className="h-5 w-5" />}
            />
            <StatCard
              label="LLM Tokens"
              value={n(tokensUsed)}
              context={`${n(usage.metrics.llmTokensIn)} in / ${n(usage.metrics.llmTokensOut)} out`}
              icon={<Cpu className="h-5 w-5" />}
            />
            <StatCard
              label="Active Devices"
              value={n(usage.metrics.devices)}
              context={`${n(usage.metrics.apiKeys)} API keys`}
              icon={<Smartphone className="h-5 w-5" />}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Storage, not "Plan Limits" (doc 27 §6.4). The old card drew a meter
                against a hard-coded 50,000 calls a month - a limit nobody set,
                which read as a real one to whoever opened this page. The one
                real per-tenant limit is the storage quota; without one this
                shows usage alone. */}
            <Card elevated className="overflow-hidden p-0">
              <StorageVital
                storage={orgRow ? storageFromOrg(orgRow) : null}
                retentionPaused={orgRow ? orgRow.status !== "active" : false}
              />
            </Card>

            <Card elevated className="space-y-4">
              <div className="flex items-center justify-between">
                <MonoLabel>Invoices</MonoLabel>
                {billing === null ? <StatusChip tone="outline">unavailable</StatusChip> : null}
              </div>

              {billing === null ? (
                <p className="text-xs font-mono font-bold uppercase text-text-subtle py-6 text-center">
                  Billing service unavailable
                </p>
              ) : (billing.invoices ?? []).length === 0 ? (
                <div className="flex flex-col items-center py-8 gap-3">
                  <FileText className="h-8 w-8 text-text-subtle" />
                  <p className="text-xs font-mono font-bold uppercase text-text-subtle">
                    No invoices yet - metered usage bills at period close
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left border-collapse">
                    <thead>
                      <tr className="bg-bg-subtle border-b-2 border-border-strong font-mono text-[10px] text-text font-bold uppercase tracking-wider">
                        <th className="py-3 px-4">Invoice</th>
                        <th className="py-3 px-4">Period</th>
                        <th className="py-3 px-4">Amount</th>
                        <th className="py-3 px-4 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-border text-sm">
                      {billing.invoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-surface-hover">
                          <td className="py-3 px-4 font-mono text-xs font-bold">
                            {inv.hosted_invoice_url ? (
                              <a
                                href={inv.hosted_invoice_url}
                                target="_blank"
                                rel="noreferrer"
                                className="underline hover:text-text"
                              >
                                {inv.number ?? inv.id.slice(0, 10)}
                              </a>
                            ) : (
                              (inv.number ?? inv.id.slice(0, 10))
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono text-[11px]">
                            {inv.period_start
                              ? new Date(inv.period_start).toLocaleDateString()
                              : "-"}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs font-bold">
                            {inv.amount_due != null
                              ? `${(inv.amount_due / 100).toFixed(2)} ${(inv.currency ?? "usd").toUpperCase()}`
                              : "-"}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <StatusChip tone={inv.status === "paid" ? "solid" : "muted"}>
                              {inv.status ?? "draft"}
                            </StatusChip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
