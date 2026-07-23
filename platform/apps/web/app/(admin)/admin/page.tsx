import { Activity, Building2, Server } from "lucide-react";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { apiGet } from "@/lib/server-api";

/**
 * Platform-admin console (us, not customers). TODO: gate behind platform_admin
 * role once OIDC lands; tenant lifecycle, global health, model routing, cost.
 */

interface Tenant {
  id: string;
  name: string;
  status: string;
  region: string;
  call_count: number;
  device_count: number;
}

interface HealthStage {
  name: string;
  status?: string;
  queued?: number;
  in_flight?: number;
  note?: string;
}

interface Health {
  stages: HealthStage[];
  note?: string;
}

function tenantTone(status: string): "solid" | "muted" | "danger" {
  if (status === "active") return "solid";
  if (status === "suspended" || status === "delinquent") return "danger";
  return "muted";
}

function stageTone(status?: string): "solid" | "muted" | "danger" {
  if (status === "healthy" || status === "ok") return "solid";
  if (status === "degraded" || status === "down" || status === "error") return "danger";
  return "muted";
}

export default async function AdminPage() {
  const [tenantData, health] = await Promise.all([
    apiGet<{ tenants: Tenant[] }>("/v1/admin/tenants"),
    apiGet<Health>("/v1/admin/health"),
  ]);

  return (
    <main className="min-h-dvh p-4 sm:p-6 md:p-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-black text-white flex items-center justify-center font-bold font-display text-xl select-none shrink-0">
          A
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-display font-black uppercase tracking-tighter leading-none">
            Platform Admin
          </h1>
          <span className="text-[10px] font-mono font-bold text-neutral-400 block tracking-[0.2em] uppercase mt-1">
            Restricted · platform_admin
          </span>
        </div>
      </div>

      {tenantData === null && health === null ? (
        <Card shadow>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Tenants */}
          <Card shadow className="overflow-hidden p-0">
            <div className="p-5 border-b-2 border-black flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
                Tenants
              </h4>
            </div>
            {tenantData === null ? (
              <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-10 text-center">
                Tenant service unavailable
              </p>
            ) : tenantData.tenants.length === 0 ? (
              <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-10 text-center">
                No tenants provisioned yet
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left border-collapse">
                  <thead>
                    <tr className="bg-neutral-100 border-b-2 border-black font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                      <th className="py-3.5 px-5">Tenant</th>
                      <th className="py-3.5 px-4">Region</th>
                      <th className="py-3.5 px-4">Calls</th>
                      <th className="py-3.5 px-4">Devices</th>
                      <th className="py-3.5 px-4 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y-2 divide-neutral-100 text-sm">
                    {tenantData.tenants.map((t) => (
                      <tr key={t.id} className="hover:bg-neutral-50">
                        <td className="py-4 px-5">
                          <span className="font-display font-bold text-black block">{t.name}</span>
                          <span className="text-[10px] font-mono text-neutral-400">{t.id}</span>
                        </td>
                        <td className="py-4 px-4 font-mono text-xs uppercase">{t.region}</td>
                        <td className="py-4 px-4 font-mono text-xs font-bold">
                          {t.call_count.toLocaleString()}
                        </td>
                        <td className="py-4 px-4 font-mono text-xs font-bold">
                          {t.device_count.toLocaleString()}
                        </td>
                        <td className="py-4 px-4 text-right">
                          <StatusChip tone={tenantTone(t.status)}>{t.status}</StatusChip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Global health */}
          <Card shadow className="space-y-4">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4" />
              <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
                Global Pipeline Health
              </h4>
            </div>

            {health === null ? (
              <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-6 text-center">
                Health service unavailable
              </p>
            ) : (health.stages ?? []).length === 0 ? (
              <div className="flex flex-col items-center py-8 gap-3">
                <Activity className="h-8 w-8 text-neutral-300" />
                <p className="text-xs font-mono font-bold uppercase text-neutral-400">
                  No stage telemetry reported
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {health.stages.map((s) => (
                  <div key={s.name} className="p-4 rounded-none border-2 border-neutral-200 bg-white space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold uppercase tracking-wider text-black">
                        {s.name}
                      </span>
                      <StatusChip tone={stageTone(s.status)}>{s.status ?? "unknown"}</StatusChip>
                    </div>
                    <div className="flex gap-4 text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500">
                      <span>queued {s.queued ?? 0}</span>
                      <span>in-flight {s.in_flight ?? 0}</span>
                    </div>
                    {s.note ? (
                      <p className="text-[10px] font-sans text-neutral-500">{s.note}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {health?.note ? (
              <p className="text-[11px] font-mono text-neutral-400 uppercase tracking-wider font-bold border-t-2 border-neutral-200 pt-3">
                {health.note}
              </p>
            ) : null}
          </Card>
        </div>
      )}
    </main>
  );
}
