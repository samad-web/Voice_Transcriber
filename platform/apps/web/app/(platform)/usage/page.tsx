import { Clock, Cpu, FileText, Phone, Smartphone } from "lucide-react";
import { Card, MonoLabel, ProgressBar, StatCard, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/server-api";

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

/** Safe integer display — SUM() over no rows returns null once data is cleared. */
function n(value: number | null | undefined) {
  return (value ?? 0).toLocaleString();
}

function pct(used: number | null | undefined, limit: number | null | undefined) {
  if (!limit || limit <= 0) return 0;
  return ((used ?? 0) / limit) * 100;
}

function formatLimit(value: number | null | undefined) {
  return value == null ? "unlimited" : value.toLocaleString();
}

function formatPeriod(period: UsageData["period"]): string | null {
  if (!period) return null;
  if (typeof period === "string") return period;
  const day = (s?: string) => (s ? new Date(s).toLocaleDateString() : "");
  const start = day(period.start);
  const end = day(period.end);
  return start && end ? `${start} – ${end}` : start || end || null;
}

export default async function UsagePage() {
  const [usage, billing] = await Promise.all([
    apiGet<UsageData>("/v1/usage"),
    apiGet<{ invoices: Invoice[] }>("/v1/billing/invoices"),
  ]);

  const periodLabel = usage ? formatPeriod(usage.period) : null;
  const tokensUsed = usage
    ? (usage.metrics.llmTokensIn ?? 0) + (usage.metrics.llmTokensOut ?? 0)
    : 0;

  return (
    <>
      <PageHeader title="Usage & Billing" />

      {usage === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
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
              icon={<Phone className="h-5 w-5" />}
              footer={<span>of {formatLimit(usage.limits.callsPerMonth)} / month</span>}
            />
            <StatCard
              label="Recorded Minutes"
              value={n(usage.metrics.minutes)}
              icon={<Clock className="h-5 w-5" />}
              footer={<span>metered from ingest</span>}
            />
            <StatCard
              label="LLM Tokens"
              value={n(tokensUsed)}
              icon={<Cpu className="h-5 w-5" />}
              footer={
                <span>
                  {n(usage.metrics.llmTokensIn)} in / {n(usage.metrics.llmTokensOut)} out
                </span>
              }
            />
            <StatCard
              label="Active Devices"
              value={n(usage.metrics.devices)}
              icon={<Smartphone className="h-5 w-5" />}
              footer={<span>{n(usage.metrics.apiKeys)} API keys</span>}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card shadow className="space-y-4">
              <MonoLabel>Plan Limits</MonoLabel>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono font-bold uppercase tracking-wider">
                  <span className="text-black">Calls</span>
                  <span className="text-neutral-500">
                    {n(usage.metrics.calls)} / {formatLimit(usage.limits.callsPerMonth)}
                  </span>
                </div>
                <ProgressBar
                  percent={pct(usage.metrics.calls, usage.limits.callsPerMonth)}
                  tone={pct(usage.metrics.calls, usage.limits.callsPerMonth) >= 90 ? "danger" : "solid"}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono font-bold uppercase tracking-wider">
                  <span className="text-black">Tokens</span>
                  <span className="text-neutral-500">
                    {n(tokensUsed)} / {formatLimit(usage.limits.tokensPerMonth)}
                  </span>
                </div>
                <ProgressBar
                  percent={pct(tokensUsed, usage.limits.tokensPerMonth)}
                  tone={pct(tokensUsed, usage.limits.tokensPerMonth) >= 90 ? "danger" : "solid"}
                />
              </div>
            </Card>

            <Card shadow className="space-y-4">
              <div className="flex items-center justify-between">
                <MonoLabel>Invoices</MonoLabel>
                {billing === null ? <StatusChip tone="outline">unavailable</StatusChip> : null}
              </div>

              {billing === null ? (
                <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-6 text-center">
                  Billing service unavailable
                </p>
              ) : (billing.invoices ?? []).length === 0 ? (
                <div className="flex flex-col items-center py-8 gap-3">
                  <FileText className="h-8 w-8 text-neutral-300" />
                  <p className="text-xs font-mono font-bold uppercase text-neutral-400">
                    No invoices yet — metered usage bills at period close
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left border-collapse">
                    <thead>
                      <tr className="bg-neutral-100 border-b-2 border-black font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                        <th className="py-3 px-4">Invoice</th>
                        <th className="py-3 px-4">Period</th>
                        <th className="py-3 px-4">Amount</th>
                        <th className="py-3 px-4 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-neutral-100 text-sm">
                      {billing.invoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-neutral-50">
                          <td className="py-3 px-4 font-mono text-xs font-bold">
                            {inv.hosted_invoice_url ? (
                              <a
                                href={inv.hosted_invoice_url}
                                target="_blank"
                                rel="noreferrer"
                                className="underline hover:text-neutral-600"
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
                              : "—"}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs font-bold">
                            {inv.amount_due != null
                              ? `${(inv.amount_due / 100).toFixed(2)} ${(inv.currency ?? "usd").toUpperCase()}`
                              : "—"}
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
