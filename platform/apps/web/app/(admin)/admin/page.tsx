import Link from "next/link";
import { Activity, ArrowDown, Building2, Server } from "lucide-react";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { bytesToGb, formatBytes } from "@aura/shared";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAdmin } from "@/lib/server-api";
import { Provisioning } from "./provisioning";
import { StorageQuotaForm } from "./storage-quota-form";

/**
 * Platform-admin console (us, not customers). Gated by `(admin)/layout.tsx`
 * (isOperator()) and, here, by operatorGate() itself - the layout's decision
 * and this page's own data-fetching are not guaranteed to be sequenced by
 * Next's renderer, so the check has to be the first thing this function does
 * too. See operator-gate.tsx.
 */

interface Tenant {
  id: string;
  name: string;
  status: string;
  region: string;
  call_count: number;
  device_count: number;
  /** Migration 0072/0093 - what this client is provisioned for. */
  enabled_modules: string[];
  enabled_features: string[];
  whatsapp_provider: string;
  /** Doc 27 §6.4 - the worker's hourly snapshot (null before the first sweep) and the quota. */
  storage_bytes?: string | null;
  storage_recordings?: number | null;
  storage_quota_bytes?: string | null;
}

interface HealthStage {
  name: string;
  status?: string;
  inFlight?: number;
  failed?: number;
  oldestInFlight?: string | null;
}

interface Health {
  stages: HealthStage[];
  queue?: { name: string; depth: number | null; reachable: boolean };
  awaitingAudio?: number;
  failedUpload?: number;
  stuckAfterSeconds?: number;
}

function tenantTone(status: string): "solid" | "muted" | "danger" {
  if (status === "active") return "solid";
  if (status === "suspended" || status === "delinquent") return "danger";
  return "muted";
}

function stageTone(status?: string): "solid" | "muted" | "danger" {
  if (status === "ok") return "solid";
  // A stalled stage is the one worth waking someone for: the worker is holding
  // a call rather than merely erroring on it.
  if (status === "stalled" || status === "degraded") return "danger";
  return "muted";
}

/**
 * The strip above each of the two panel cards below. Mirrors the equivalent
 * `PANEL_HEAD` in instances/[id]/page.tsx - same 1px rule, same subtle fill,
 * same label weight - so this page reads as part of the same console rather
 * than a leftover from the old neo-brutalist system.
 */
const PANEL_HEAD = "flex items-center gap-2 border-b border-border bg-bg-subtle px-5 py-3.5";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;
  // Doc 27 §6.4: the tenants table can be ordered by storage used, largest
  // first - the question an operator asks before a quota conversation.
  const { sort } = await searchParams;
  const byStorage = sort === "storage";

  const [tenantData, health] = await Promise.all([
    apiGetAdmin<{ tenants: Tenant[] }>("/v1/admin/tenants"),
    apiGetAdmin<Health>("/v1/admin/health"),
  ]);

  return (
    <main className="min-h-dvh p-4 sm:p-6 md:p-8 space-y-6">
      <div className="flex items-center gap-3">
        {/* The mark: bg-text/text-bg rather than literal black/white, so it
            still reads as a filled square with an inverted glyph once dark
            mode flips which of those tokens is actually dark. */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-text text-lg font-semibold text-bg select-none">
          A
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl leading-none font-extrabold tracking-tight text-text sm:text-3xl md:text-4xl">
            Platform Admin
          </h1>
          <MonoLabel className="mt-1">Restricted · platform_admin</MonoLabel>
        </div>
      </div>

      {tenantData === null && health === null ? (
        <Card elevated>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API - start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Provisioning first, above the read-only tenant table. This is the
              page's only surface an operator ACTS on, and burying an action
              below two panels of reporting is how a console teaches people that
              the thing they came for is somewhere further down. */}
          {tenantData === null ? null : (
            <Provisioning
              tenants={tenantData.tenants.map((t) => ({
                id: t.id,
                name: t.name,
                // Defaulted here rather than trusted: an API running ahead of
                // migration 0093 returns neither, and a crash on `.includes`
                // of undefined would take the whole admin console down over a
                // column that is only a provisioning preference.
                enabled_modules: t.enabled_modules ?? [],
                enabled_features: t.enabled_features ?? [],
                whatsapp_provider: t.whatsapp_provider ?? "none",
              }))}
            />
          )}

          {/* Tenants */}
          <Card elevated className="overflow-hidden p-0">
            <div className={PANEL_HEAD}>
              <Building2 aria-hidden="true" className="h-4 w-4 text-text-muted" />
              <h4 className="text-sm font-semibold text-text">Tenants</h4>
            </div>
            {tenantData === null ? (
              <p className="py-10 text-center text-sm text-text-muted">Tenant service unavailable</p>
            ) : tenantData.tenants.length === 0 ? (
              <p className="py-10 text-center text-sm text-text-muted">No tenants provisioned yet</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-label="Tenants"
                className="overflow-x-auto"
              >
                <table className="w-full min-w-[920px] border-collapse text-left text-sm">
                  <caption className="sr-only">Tenants</caption>
                  <thead className="bg-bg-subtle">
                    <tr>
                      <th scope="col" className="border-b border-border px-5 py-2.5 text-xs font-medium text-text-muted">
                        Tenant
                      </th>
                      <th scope="col" className="border-b border-border px-4 py-2.5 text-xs font-medium text-text-muted">
                        Region
                      </th>
                      <th scope="col" className="border-b border-border px-4 py-2.5 text-xs font-medium text-text-muted">
                        Calls
                      </th>
                      <th scope="col" className="border-b border-border px-4 py-2.5 text-xs font-medium text-text-muted">
                        Devices
                      </th>
                      <th
                        scope="col"
                        aria-sort={byStorage ? "descending" : "none"}
                        className="border-b border-border px-4 py-2.5 text-xs font-medium text-text-muted"
                      >
                        <Link
                          href={byStorage ? "/admin" : "/admin?sort=storage"}
                          className="inline-flex items-center gap-1 hover:text-text"
                        >
                          Storage
                          <ArrowDown
                            aria-hidden="true"
                            className={byStorage ? "h-3 w-3 text-text" : "h-3 w-3 text-text-subtle"}
                          />
                        </Link>
                      </th>
                      <th scope="col" className="border-b border-border px-4 py-2.5 text-xs font-medium text-text-muted">
                        Quota
                      </th>
                      <th scope="col" className="border-b border-border px-4 py-2.5 text-right text-xs font-medium text-text-muted">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(byStorage
                      ? [...tenantData.tenants].sort((a, b) => Number(b.storage_bytes ?? -1) - Number(a.storage_bytes ?? -1))
                      : tenantData.tenants
                    ).map((t) => (
                      <tr key={t.id} className="transition-colors duration-150 ease-out hover:bg-surface-hover">
                        <td className="px-5 py-3 align-middle">
                          <span className="block text-sm font-medium text-text">{t.name}</span>
                          <span className="font-mono text-xs text-text-muted">{t.id}</span>
                        </td>
                        <td className="px-4 py-3 align-middle font-mono text-xs text-text">{t.region}</td>
                        <td className="px-4 py-3 align-middle font-mono text-xs tabular-nums text-text">
                          {t.call_count.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 align-middle font-mono text-xs tabular-nums text-text">
                          {t.device_count.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 align-middle font-mono text-xs tabular-nums text-text">
                          {t.storage_bytes == null ? (
                            <span className="text-text-muted">-</span>
                          ) : (
                            <>
                              {formatBytes(Number(t.storage_bytes))}
                              <span className="block text-text-muted">
                                {(t.storage_recordings ?? 0).toLocaleString()} rec.
                              </span>
                            </>
                          )}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          <StorageQuotaForm
                            orgId={t.id}
                            quotaGb={t.storage_quota_bytes ? bytesToGb(Number(t.storage_quota_bytes)) : null}
                          />
                        </td>
                        <td className="px-4 py-3 text-right align-middle">
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
          <Card elevated className="space-y-4">
            <div className="flex items-center gap-2">
              <Server aria-hidden="true" className="h-4 w-4 text-text-muted" />
              <h4 className="text-sm font-semibold text-text">Global Pipeline Health</h4>
            </div>

            {health === null ? (
              <p className="py-6 text-center text-sm text-text-muted">Health service unavailable</p>
            ) : (health.stages ?? []).length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <Activity aria-hidden="true" className="h-8 w-8 text-text-subtle" />
                <p className="text-sm text-text-muted">No stage telemetry reported</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {health.stages.map((s) => (
                  <div key={s.name} className="space-y-2 rounded-md border border-border bg-surface p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-medium text-text">{s.name}</span>
                      <StatusChip tone={stageTone(s.status)}>{s.status ?? "unknown"}</StatusChip>
                    </div>
                    <div className="flex gap-4 text-xs text-text-muted">
                      <span>in-flight {s.inFlight ?? 0}</span>
                      <span className={s.failed ? "font-medium text-danger-text" : undefined}>
                        failed {s.failed ?? 0}
                      </span>
                    </div>
                    {s.oldestInFlight ? (
                      <p className="text-xs text-text-muted">
                        oldest since {new Date(s.oldestInFlight).toLocaleString()}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {health ? (
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-text-muted">
                <StatusChip tone={health.queue?.reachable ? "solid" : "danger"}>
                  queue {health.queue?.reachable ? `${health.queue.depth} waiting` : "unreachable"}
                </StatusChip>
                <span>awaiting audio {health.awaitingAudio ?? 0}</span>
                <span className={health.failedUpload ? "font-medium text-danger-text" : undefined}>
                  failed upload {health.failedUpload ?? 0}
                </span>
                <span>stalled after {Math.round((health.stuckAfterSeconds ?? 0) / 60)}m</span>
              </div>
            ) : null}
          </Card>
        </div>
      )}
    </main>
  );
}
