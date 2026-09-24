import Link from "next/link";
import {
  Activity,
  Building2,
  CalendarCheck,
  DollarSign,
  HardDrive,
  HeartPulse,
  Phone,
  Users,
} from "lucide-react";
import { Card, MonoLabel, Sparkline, STATE_TONE, StatCard, StatusChip } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { deltaText, percentDelta, pointsDelta, rateText, share } from "@/lib/dashboard-charts";
import { operatorGate } from "@/lib/operator-gate";
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
  byDay: Array<{ day: string; volume: number; complete: number }>;
}

/** GET /v1/analytics/active-users. */
interface ActiveUsers {
  last24h: number;
  previous24h: number;
  last7d: number;
}

/** GET /v1/analytics/booking-rate. */
interface BookingRate {
  submissionsCurrent: number;
  bookedCurrent: number;
  submissionsPrevious: number;
  bookedPrevious: number;
}

/** GET /v1/admin/health. */
interface Health {
  stages: Array<{
    name: string;
    status: "ok" | "degraded" | "stalled";
    inFlight: number;
    failed: number;
    oldestInFlight: string | null;
  }>;
  queue: { name: string; depth: number | null; reachable: boolean };
  awaitingAudio: number;
  failedUpload: number;
  stuckAfterSeconds: number;
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
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  const [fleet, data, activeUsers, bookingRate, health] = await Promise.all([
    apiGetAdmin<Fleet>("/v1/analytics/fleet"),
    apiGetAs<Overview>("/v1/analytics/overview", orgId),
    apiGetAdmin<ActiveUsers>("/v1/analytics/active-users"),
    apiGetAdmin<BookingRate>("/v1/analytics/booking-rate"),
    apiGetAdmin<Health>("/v1/admin/health"),
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
      : "-";
  const minutes = Math.round((data?.calls.total_seconds ?? 0) / 60);
  const tokens = (data?.usage.llm_tokens_in ?? 0) + (data?.usage.llm_tokens_out ?? 0);

  // ── active users: sign-ins today vs. the same window yesterday ────────────
  const activeUsersTrend = activeUsers
    ? percentDelta(activeUsers.last24h, activeUsers.previous24h)
    : null;

  // ── booking rate: the funnel's own conversion, trailing 30d vs. previous 30d ─
  const bookingRateCurrent = bookingRate
    ? share(bookingRate.bookedCurrent, bookingRate.submissionsCurrent)
    : null;
  const bookingRatePrevious = bookingRate
    ? share(bookingRate.bookedPrevious, bookingRate.submissionsPrevious)
    : null;
  const bookingTrend = pointsDelta(bookingRateCurrent, bookingRatePrevious);

  // ── pipeline health: worst stage wins, silent when everything is ok ───────
  const unhealthyStages = health?.stages.filter((s) => s.status !== "ok") ?? [];
  const worstHealth = unhealthyStages.some((s) => s.status === "stalled")
    ? "stalled"
    : unhealthyStages.length > 0
      ? "degraded"
      : "ok";

  return (
    <>
      <PageHeader title="Platform Hub" />

      {fleet ? (
        <section className="space-y-4">
          <div>
            <h3 className="text-xl font-display font-black uppercase tracking-tight">
              Across all tenants
            </h3>
            <p className="text-xs text-text-muted font-sans font-medium mt-0.5">
              Every customer combined. The per-tenant view is below.
            </p>
          </div>

          {/* Headline row: what an operator needs to know first - is the
              platform being used, is it healthy, and is it winning business. */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            <StatCard
              label="Active Users"
              value={activeUsers ? activeUsers.last24h.toLocaleString() : "-"}
              context={activeUsers ? `${activeUsers.last7d.toLocaleString()} in the last 7 days` : "unavailable"}
              icon={<Users className="h-5 w-5" />}
              trend={
                activeUsersTrend
                  ? { kind: activeUsersTrend.kind, text: deltaText(activeUsersTrend, 1) }
                  : undefined
              }
            />
            <StatCard
              label="Tenants"
              value={fleet.tenants.total}
              context={`${fleet.tenants.active} active`}
              icon={<Building2 className="h-5 w-5" />}
            />
            <StatCard
              label="Pipeline Health"
              value={health ? `${health.stages.length - unhealthyStages.length}/${health.stages.length} healthy` : "-"}
              context={
                health
                  ? `queue depth ${health.queue.reachable ? (health.queue.depth ?? 0).toLocaleString() : "unreachable"}`
                  : "unavailable"
              }
              icon={<HeartPulse className="h-5 w-5" />}
              // Silent when every stage is ok, same pattern as the Calls tile's
              // failed-count chip below - an alarm colour that fires on every
              // page load stops meaning anything.
              state={worstHealth !== "ok" ? "error" : undefined}
              stateLabel={
                worstHealth !== "ok" ? `${unhealthyStages.length} ${worstHealth}` : undefined
              }
            />
            <StatCard
              label="Booking Rate"
              value={bookingRate ? rateText(bookingRate.bookedCurrent, bookingRate.submissionsCurrent) : "-"}
              context={
                bookingRate
                  ? `${bookingRate.bookedCurrent} of ${bookingRate.submissionsCurrent} enquiries (30d)`
                  : "unavailable"
              }
              icon={<CalendarCheck className="h-5 w-5" />}
              trend={
                bookingTrend
                  ? { kind: bookingTrend.kind, text: deltaText(bookingTrend, 30, " pts") }
                  : undefined
              }
            />
          </div>

          {/* Demoted, not deleted: still useful, just not the first thing an
              operator needs - see StatCard's own note on `tone="plain"`. */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            <StatCard
              tone="plain"
              label="Calls"
              value={fleet.calls.calls.toLocaleString()}
              context={`${fleet.calls.in_pipeline} still in flight`}
              icon={<Phone className="h-5 w-5" />}
              // `failed` is an ERROR - orange - never red (see @aura/ui's
              // state.tsx: red means a missed call, not a system failure).
              state={fleet.calls.failed > 0 ? "error" : undefined}
              stateLabel={fleet.calls.failed > 0 ? `${fleet.calls.failed} failed` : undefined}
              footer={<Sparkline values={fleet.byDay.slice(-7).map((d) => d.volume)} />}
            />
            <StatCard
              tone="plain"
              label="Recorded Time"
              value={`${fleetMinutes.toLocaleString()} min`}
              context={`${fleet.calls.complete} calls fully processed`}
              icon={<Activity className="h-5 w-5" />}
            />
            <StatCard
              tone="plain"
              label="Devices"
              value={`${fleet.devices.active}/${fleet.devices.total}`}
              context="active / enrolled"
              icon={<HardDrive className="h-5 w-5" />}
            />
          </div>

          <Card className="overflow-hidden p-0">
            <div className="px-5 py-3.5 border-b-2 border-border-strong bg-bg-subtle">
              <span className="text-xs font-display font-bold uppercase tracking-wider text-text">
                By tenant
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left border-collapse">
                <thead>
                  <tr className="bg-bg-subtle border-b-2 border-border font-mono text-[10px] text-text font-bold uppercase tracking-wider">
                    <th className="py-3 px-5">Tenant</th>
                    <th className="py-3 px-4">Calls</th>
                    <th className="py-3 px-4">Failed</th>
                    <th className="py-3 px-4">Minutes</th>
                    <th className="py-3 px-4">Last call</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-border text-sm text-text">
                  {fleet.byTenant.map((t) => (
                    <tr key={t.id} className="hover:bg-surface-hover">
                      <td className="py-3.5 px-5">
                        <Link
                          href={`/instances/${t.id}/calls`}
                          className="font-display font-bold text-text hover:underline"
                        >
                          {t.name}
                        </Link>
                        {t.status !== "active" ? (
                          <StatusChip tone="muted">{t.status}</StatusChip>
                        ) : null}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs font-bold">{t.calls}</td>
                      <td className="py-3.5 px-4 font-mono text-xs">
                        {/* Failed is an ERROR, which is orange in this console -
                            red means a missed call (@aura/ui's state.tsx). */}
                        {t.failed > 0 ? (
                          <span className={`${STATE_TONE.error.text} font-bold`}>{t.failed}</span>
                        ) : (
                          <span className="text-text-muted">0</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs">
                        {Math.round(t.total_seconds / 60)}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs text-text-muted">
                        {t.last_call_at ? <LocalTime iso={t.last_call_at} mode="date" /> : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      ) : null}

      <section className="space-y-4 border-t-2 border-border-strong pt-6">
        <div>
          <h3 className="text-xl font-display font-black uppercase tracking-tight">
            {activeTenant?.name ?? "Selected tenant"}
          </h3>
          <p className="text-xs text-text-muted font-sans font-medium mt-0.5">
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
                context={`${data.calls.complete} of ${data.calls.total} complete`}
                icon={<Activity className="h-5 w-5" />}
              />
              <Link href={`/instances/${orgId}/calls`} className="block">
                <StatCard
                  label="Recorded Time"
                  value={`${minutes} min`}
                  context="open the call log"
                  icon={<Phone className="h-5 w-5" />}
                  state={data.calls.failed > 0 ? "error" : undefined}
                  stateLabel={data.calls.failed > 0 ? `${data.calls.failed} failed` : undefined}
                />
              </Link>
              <StatCard
                label="Fleet Health"
                value={`${data.devices.active}/${data.devices.total}`}
                context="handsets active / enrolled"
                icon={<HardDrive className="h-5 w-5" />}
              />
              <StatCard
                label="LLM Tokens"
                value={tokens.toLocaleString()}
                context="metered from day one"
                icon={<DollarSign className="h-5 w-5" />}
              />
            </div>

            <Card>
              <MonoLabel>
                Call ingest - last 7 days{activeTenant ? ` · ${activeTenant.name}` : ""}
              </MonoLabel>
              {data.byDay.length === 0 ? (
                <p className="text-sm text-text-muted mt-3 font-sans">
                  No calls in the window yet.
                </p>
              ) : (
                <div className="mt-4 flex items-end gap-2 h-40">
                  {data.byDay.map((d) => {
                    const max = Math.max(...data.byDay.map((x) => x.volume), 1);
                    return (
                      <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5">
                        <div className="w-full flex flex-col justify-end h-32">
                          {/* A magnitude, not a state (see state.tsx) - the
                              sequential grey ramp, not a hue. */}
                          <div
                            className="w-full bg-chart-seq-3"
                            style={{ height: `${(d.volume / max) * 100}%` }}
                          />
                        </div>
                        <span className="text-[9px] font-mono text-text-muted font-bold">
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
