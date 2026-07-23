import type { Metadata } from "next";
import Link from "next/link";
import { Banknote, PhoneCall, Target, Trophy } from "lucide-react";
import { Card, MonoLabel, StatCard, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { TelecallerName } from "./telecaller-name";
import { formatDuration, formatValue, num, relativeTime, type Overview } from "./types";

export const metadata: Metadata = { title: "Dashboard — Aura" };

/**
 * The owner's landing page: how the desk is performing and what the pipeline
 * is worth, over a rolling window. Everything here is scoped by the session's
 * org — see lib/owner-context.
 */
export default async function OwnerDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days: daysParam } = await searchParams;
  const days = Math.min(365, Math.max(1, Number(daysParam) || 30));
  const data = await ownerGet<Overview>(`/v1/owner/overview?days=${days}`);

  if (!data) {
    return (
      <>
        <PageHeader title="Dashboard" context="Instance" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  const { leads, calls, funnel, telecallers, byDay } = data;
  const closed = leads.won + leads.lost;
  const winRate = closed > 0 ? Math.round((leads.won / closed) * 100) : null;
  const maxDay = Math.max(...byDay.map((d) => Math.max(d.calls, d.leads)), 1);
  const funnelMax = Math.max(...funnel.map((f) => f.count), 1);

  return (
    <>
      <PageHeader title={data.org.name || "Dashboard"} context="Instance" />

      <div className="flex items-center gap-2 flex-wrap">
        <MonoLabel className="mr-1">Window</MonoLabel>
        {[7, 30, 90].map((d) => (
          <Link
            key={d}
            href={`/owner?days=${d}`}
            className={`text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-1 border-2 border-black ${
              d === days ? "bg-black text-white" : "bg-white text-neutral-500 hover:text-black"
            }`}
          >
            {d} days
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
        <StatCard
          label="Open Leads"
          value={String(leads.open)}
          icon={<Target className="h-5 w-5" />}
          footer={<span>{leads.created_in_window} new in {days}d</span>}
        />
        <StatCard
          label="Pipeline Value"
          value={formatValue(leads.pipeline_value)}
          icon={<Banknote className="h-5 w-5" />}
          footer={<span>across open leads</span>}
        />
        <StatCard
          label="Won"
          value={String(leads.won)}
          icon={<Trophy className="h-5 w-5" />}
          footer={
            <span>
              {winRate === null ? "nothing closed yet" : `${winRate}% win rate`}
              {leads.won_value > 0 ? ` · ${formatValue(leads.won_value)}` : ""}
            </span>
          }
        />
        <StatCard
          label="Calls"
          value={String(calls.total)}
          icon={<PhoneCall className="h-5 w-5" />}
          footer={<span>{formatDuration(calls.total_seconds)} on the phone</span>}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 sm:gap-6">
        <Card shadow className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <MonoLabel>Pipeline by stage</MonoLabel>
            <Link
              href="/owner/board"
              className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500 hover:text-black"
            >
              Open board →
            </Link>
          </div>
          {leads.total === 0 ? (
            <EmptyPipeline />
          ) : (
            <div className="space-y-2.5">
              {funnel.map((stage) => (
                <Link
                  key={stage.key}
                  href={`/owner/leads?stage=${stage.key}`}
                  className="block group"
                >
                  <div className="flex items-center justify-between gap-3 text-xs font-mono font-bold">
                    <span className="uppercase tracking-wider text-neutral-500 group-hover:text-black">
                      {stage.label}
                    </span>
                    <span className="text-black shrink-0">
                      {stage.count}
                      {stage.value > 0 ? (
                        <span className="text-neutral-400 font-normal">
                          {" "}
                          · {formatValue(stage.value)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="mt-1.5 h-3 w-full bg-neutral-100 border border-black overflow-hidden">
                    <div
                      className={`h-full ${
                        stage.terminal === "lost" ? "bg-neutral-400" : "bg-black"
                      }`}
                      style={{ width: `${(stage.count / funnelMax) * 100}%` }}
                    />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card shadow className="space-y-4">
          <MonoLabel>Calls and new leads — last {days} days</MonoLabel>
          {byDay.length === 0 ? (
            <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-10 text-center">
              No activity in this window
            </p>
          ) : (
            <>
              <div className="flex items-end gap-1 h-40">
                {byDay.map((d) => (
                  <div key={d.day} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                    <div className="w-full flex items-end justify-center gap-0.5 h-32">
                      <div
                        title={`${d.calls} calls`}
                        className="w-1/2 bg-neutral-300 border border-black"
                        style={{ height: `${(d.calls / maxDay) * 100}%` }}
                      />
                      <div
                        title={`${d.leads} leads`}
                        className="w-1/2 bg-black border border-black"
                        style={{ height: `${(d.leads / maxDay) * 100}%` }}
                      />
                    </div>
                    <span className="text-[8px] font-mono text-neutral-400 font-bold truncate w-full text-center">
                      {new Date(d.day).toLocaleDateString(undefined, { day: "numeric" })}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-4 pt-2 border-t border-neutral-200">
                <span className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500">
                  <span className="w-3 h-3 bg-neutral-300 border border-black" /> Calls
                </span>
                <span className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500">
                  <span className="w-3 h-3 bg-black border border-black" /> Leads
                </span>
              </div>
            </>
          )}
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="px-5 py-3.5 border-b-2 border-black bg-neutral-50 flex items-center justify-between gap-3">
          <span className="text-xs font-display font-bold uppercase tracking-wider">
            Telecaller performance
          </span>
          <span className="text-[10px] font-mono text-neutral-400 font-bold uppercase tracking-wider">
            last {days} days
          </span>
        </div>
        {telecallers.length === 0 ? (
          <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-10 text-center">
            No handsets enrolled yet
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left border-collapse">
              <thead>
                <tr className="bg-neutral-100 border-b-2 border-neutral-200 font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                  <th className="py-3 px-5">Telecaller</th>
                  <th className="py-3 px-4 text-right">Calls</th>
                  <th className="py-3 px-4 text-right">Talk time</th>
                  <th className="py-3 px-4 text-right">Leads</th>
                  <th className="py-3 px-4 text-right">Won</th>
                  <th className="py-3 px-4 text-right">Pipeline</th>
                  <th className="py-3 px-4">Last call</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-neutral-100 text-sm">
                {telecallers.map((t) => (
                  <tr key={t.id} className="hover:bg-neutral-50">
                    <td className="py-3.5 px-5">
                      <TelecallerName
                        deviceId={t.id}
                        name={t.telecaller_name}
                        deviceLabel={t.label}
                      />
                      {t.status !== "active" ? (
                        <StatusChip tone="muted" className="mt-1.5">
                          {t.status}
                        </StatusChip>
                      ) : null}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono text-xs">{t.calls}</td>
                    <td className="py-3.5 px-4 text-right font-mono text-xs">
                      {formatDuration(t.talk_seconds)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-display font-bold">{t.leads}</td>
                    <td className="py-3.5 px-4 text-right font-mono text-xs">{t.won}</td>
                    <td className="py-3.5 px-4 text-right font-mono text-xs">
                      {formatValue(t.pipeline_value)}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-neutral-500">
                      {relativeTime(t.last_call_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card shadow className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <MonoLabel>Latest activity</MonoLabel>
          <Link
            href="/owner/leads"
            className="text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500 hover:text-black"
          >
            All leads →
          </Link>
        </div>
        {data.recent.length === 0 ? (
          <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-6 text-center">
            No leads yet
          </p>
        ) : (
          <div className="divide-y-2 divide-neutral-100">
            {data.recent.map((lead) => (
              <Link
                key={lead.id}
                href={`/owner/leads?focus=${lead.id}`}
                className="py-2.5 flex items-center justify-between gap-3 hover:bg-neutral-50"
              >
                <div className="min-w-0">
                  <span className="font-display font-bold text-black block truncate">
                    {lead.title}
                  </span>
                  <span className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider">
                    {lead.telecaller ?? "unassigned"} · {relativeTime(lead.last_activity_at)}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {num(lead.value_num) === null ? null : (
                    <span className="font-mono text-xs font-bold">
                      {formatValue(lead.value_num)}
                    </span>
                  )}
                  <StatusChip tone={lead.status === "won" ? "solid" : "muted"}>
                    {data.stages.find((s) => s.key === lead.stage)?.label ?? lead.stage}
                  </StatusChip>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * Leads only appear once a call's extraction qualifies, so an empty pipeline is
 * usually a setup gap rather than a quiet week — say which.
 */
function EmptyPipeline() {
  return (
    <div className="py-8 text-center space-y-2">
      <p className="text-xs font-mono font-bold uppercase text-neutral-400">No leads yet</p>
      <p className="text-xs text-neutral-500 font-sans max-w-sm mx-auto leading-relaxed">
        A lead appears here once a recorded call is transcribed and the AI agent
        extracts something usable from it. If calls are arriving but no leads
        are, the extraction agent may need tuning.
      </p>
    </div>
  );
}
