import Link from "next/link";
import { Activity, Building2, DollarSign, HardDrive, Phone } from "lucide-react";
import { Card, MonoLabel, StatCard, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { apiGetAdmin, apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";

interface Overview {
  calls: { total: number; complete: number; failed: number; total_seconds: number };
  devices: { total: number; active: number };
  usage: Record<string, number>;
  byDay: Array<{ day: string; volume: number; complete: number }>;
}

interface Fleet {
  calls: {
    calls: number;
    complete: number;
    failed: number;
    in_pipeline: number;
    total_seconds: number;
  };
  tenants: { total: number; active: number };
  devices: { total: number; active: number };
  byTenant: Array<{
    id: string;
    name: string;
    status: string;
    calls: number;
    failed: number;
    total_seconds: number;
    last_call_at: string | null;
  }>;
}

/**
 * Two questions, kept apart because conflating them is what made this page
 * misleading: the fleet block is a true cross-tenant rollup, and everything
 * below it is one tenant, named by the switcher. Previously only the second
 * existed and was titled as if it were the first.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  const [fleet, data] = await Promise.all([
    apiGetAdmin<Fleet>("/v1/analytics/fleet"),
    apiGetAs<Overview>("/v1/analytics/overview", orgId),
  ]);

  if (!data && !fleet) {
    return (
      <>
        <PageHeader title="Platform Hub" />
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Start the API with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      </>
    );
  }

  const fleetMinutes = Math.round((fleet?.calls.total_seconds ?? 0) / 60);
  const successRate =
    data && data.calls.total > 0
      ? ((data.calls.complete / data.calls.total) * 100).toFixed(1)
      : "—";
  const minutes = Math.round((data?.calls.total_seconds ?? 0) / 60);
  const tokens = (data?.usage.llm_tokens_in ?? 0) + (data?.usage.llm_tokens_out ?? 0);

  return (
    <>
      <PageHeader title="Platform Hub" />

      {fleet ? (
        <section className="space-y-4">
          <div>
            <h3 className="text-xl font-display font-black uppercase tracking-tight">
              Across all tenants
            </h3>
            <p className="text-xs text-neutral-500 font-sans font-medium mt-0.5">
              Every customer combined. The per-tenant view is below.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            <StatCard
              label="Tenants"
              value={String(fleet.tenants.total)}
              icon={<Building2 className="h-5 w-5" />}
              footer={<span>{fleet.tenants.active} active</span>}
            />
            <StatCard
              label="Calls"
              value={fleet.calls.calls.toLocaleString()}
              icon={<Phone className="h-5 w-5" />}
              footer={
                <span>
                  {fleet.calls.failed} failed · {fleet.calls.in_pipeline} in flight
                </span>
              }
            />
            <StatCard
              label="Recorded Time"
              value={`${fleetMinutes.toLocaleString()} min`}
              icon={<Activity className="h-5 w-5" />}
              footer={<span>{fleet.calls.complete} complete</span>}
            />
            <StatCard
              label="Devices"
              value={`${fleet.devices.active}/${fleet.devices.total}`}
              icon={<HardDrive className="h-5 w-5" />}
              footer={<span>active / enrolled</span>}
            />
          </div>

          <Card className="overflow-hidden p-0">
            <div className="px-5 py-3.5 border-b-2 border-black bg-neutral-50">
              <span className="text-xs font-display font-bold uppercase tracking-wider">
                By tenant
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left border-collapse">
                <thead>
                  <tr className="bg-neutral-100 border-b-2 border-neutral-200 font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                    <th className="py-3 px-5">Tenant</th>
                    <th className="py-3 px-4">Calls</th>
                    <th className="py-3 px-4">Failed</th>
                    <th className="py-3 px-4">Minutes</th>
                    <th className="py-3 px-4">Last call</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-neutral-100 text-sm">
                  {fleet.byTenant.map((t) => (
                    <tr key={t.id} className="hover:bg-neutral-50">
                      <td className="py-3.5 px-5">
                        <Link
                          href={`/instances/${t.id}/calls`}
                          className="font-display font-bold text-black hover:underline"
                        >
                          {t.name}
                        </Link>
                        {t.status !== "active" ? (
                          <StatusChip tone="muted">{t.status}</StatusChip>
                        ) : null}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs font-bold">{t.calls}</td>
                      <td className="py-3.5 px-4 font-mono text-xs">
                        {t.failed > 0 ? (
                          <span className="text-red-700 font-bold">{t.failed}</span>
                        ) : (
                          <span className="text-neutral-400">0</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs">
                        {Math.round(t.total_seconds / 60)}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs text-neutral-500">
                        {t.last_call_at ? new Date(t.last_call_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      ) : null}

      <section className="space-y-4 border-t-2 border-black pt-6">
        <div>
          <h3 className="text-xl font-display font-black uppercase tracking-tight">
            {activeTenant?.name ?? "Selected tenant"}
          </h3>
          <p className="text-xs text-neutral-500 font-sans font-medium mt-0.5">
            One customer. Switch tenants to compare.
          </p>
        </div>

        <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/dashboard" />

        {data ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
              <StatCard
                label="Capture Success"
                value={`${successRate}%`}
                icon={<Activity className="h-5 w-5" />}
                footer={
                  <span>
                    {data.calls.complete}/{data.calls.total} complete
                  </span>
                }
              />
              <Link href={`/instances/${orgId}/calls`} className="block">
                <StatCard
                  label="Recorded Time"
                  value={`${minutes} min`}
                  icon={<Phone className="h-5 w-5" />}
                  footer={<span>{data.calls.failed} failed · view calls</span>}
                />
              </Link>
              <StatCard
                label="Fleet Health"
                value={`${data.devices.active}/${data.devices.total}`}
                icon={<HardDrive className="h-5 w-5" />}
                footer={<span>active devices</span>}
              />
              <StatCard
                label="LLM Tokens"
                value={tokens.toLocaleString()}
                icon={<DollarSign className="h-5 w-5" />}
                footer={<span>metered from day one</span>}
              />
            </div>

            <Card>
              <MonoLabel>
                Call ingest — last 7 days{activeTenant ? ` · ${activeTenant.name}` : ""}
              </MonoLabel>
              {data.byDay.length === 0 ? (
                <p className="text-sm text-neutral-500 mt-3 font-sans">
                  No calls in the window yet.
                </p>
              ) : (
                <div className="mt-4 flex items-end gap-2 h-40">
                  {data.byDay.map((d) => {
                    const max = Math.max(...data.byDay.map((x) => x.volume), 1);
                    return (
                      <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5">
                        <div className="w-full flex flex-col justify-end h-32">
                          <div
                            className="w-full bg-black border-2 border-black"
                            style={{ height: `${(d.volume / max) * 100}%` }}
                          />
                        </div>
                        <span className="text-[9px] font-mono text-neutral-400 font-bold">
                          {new Date(d.day).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </>
        ) : (
          <Card>
            <MonoLabel>Tenant unreadable</MonoLabel>
            <p className="mt-2 text-sm text-text-muted">
              Could not read analytics for this tenant.
            </p>
          </Card>
        )}
      </section>
    </>
  );
}
