import type { Metadata } from "next";
import Link from "next/link";
import { Banknote, PhoneCall, Target, Trophy } from "lucide-react";
import { Card, MonoLabel, StatCard, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { TelecallerName } from "./telecaller-name";
import { formatDuration, formatValue, num, relativeTime, type Overview } from "./types";

export const metadata: Metadata = { title: "Dashboard — Aura" };

/** The "see everything" link that sits opposite a panel's own label. */
const PANEL_LINK =
  "rounded-sm text-xs font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text";

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
          <p className="mt-2 text-sm text-text-muted">
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

      <div className="flex flex-wrap items-center gap-2">
        <MonoLabel className="mr-1">Window</MonoLabel>
        {[7, 30, 90].map((d) => (
          <Link
            key={d}
            href={`/owner?days=${d}`}
            aria-current={d === days ? "true" : undefined}
            // Selected window = accent, the same "you are here" signal the
            // sidebar and the lead filters use.
            className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium tabular-nums transition-colors duration-150 ease-out ${
              d === days
                ? "border-transparent bg-accent-subtle text-accent-text"
                : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            {d} days
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Open leads"
          value={String(leads.open)}
          icon={<Target className="h-5 w-5" />}
          footer={<span>{leads.created_in_window} new in {days}d</span>}
        />
        <StatCard
          label="Pipeline value"
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

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <Card shadow className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <MonoLabel>Pipeline by stage</MonoLabel>
            <Link href="/owner/board" className={PANEL_LINK}>
              Open board →
            </Link>
          </div>
          {leads.total === 0 ? (
            <EmptyPipeline />
          ) : (
            <div className="space-y-2.5">
              {funnel.map((stage) => (
                <Link key={stage.key} href={`/owner/leads?stage=${stage.key}`} className="group block">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-text-muted transition-colors duration-150 ease-out group-hover:text-text">
                      {stage.label}
                    </span>
                    <span className="shrink-0 font-medium text-text tabular-nums">
                      {stage.count}
                      {stage.value > 0 ? (
                        <span className="font-normal text-text-muted">
                          {" "}
                          · {formatValue(stage.value)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {/* aria-hidden: the bar is a picture of the count that is
                      already written beside it in text, so announcing a second
                      unlabelled meter would just read the row twice. */}
                  <div
                    aria-hidden="true"
                    className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-border"
                  >
                    <div
                      // Lost stays neutral rather than red: a lost lead is a
                      // normal outcome, not a fault condition, and semantic
                      // colour is for status only (doc 16 §1.1).
                      className={`h-full rounded-full ${
                        stage.terminal === "lost" ? "bg-border-strong" : "bg-accent"
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
            <p className="py-10 text-center text-sm text-text-muted">No activity in this window</p>
          ) : (
            <>
              <div className="flex h-40 items-end gap-1">
                {byDay.map((d) => (
                  <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <div className="flex h-32 w-full items-end justify-center gap-0.5">
                      <div
                        title={`${d.calls} calls`}
                        className="w-1/2 rounded-t-sm bg-border-strong"
                        style={{ height: `${(d.calls / maxDay) * 100}%` }}
                      />
                      <div
                        title={`${d.leads} leads`}
                        className="w-1/2 rounded-t-sm bg-accent"
                        style={{ height: `${(d.leads / maxDay) * 100}%` }}
                      />
                    </div>
                    <span className="w-full truncate text-center text-xs text-text-muted tabular-nums">
                      {new Date(d.day).toLocaleDateString(undefined, { day: "numeric" })}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-4 border-t border-border pt-3">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-border-strong" /> Calls
                </span>
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-accent" /> Leads
                </span>
              </div>
            </>
          )}
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
          <span className="text-sm font-medium text-text">Telecaller performance</span>
          <span className="text-xs text-text-muted tabular-nums">last {days} days</span>
        </div>
        {telecallers.length === 0 ? (
          <p className="py-10 text-center text-sm text-text-muted">No handsets enrolled yet</p>
        ) : (
          // tabIndex+role so the horizontal scroll is reachable without a mouse
          // (WCAG 2.1.1) — the kit's <Table> does the same, but it draws its own
          // border and this table already sits inside a bordered Card.
          <div tabIndex={0} role="region" aria-label="Telecaller performance" className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead className="bg-bg-subtle">
                <tr>
                  <th scope="col" className="border-b border-border px-4 py-2.5 text-xs font-medium text-text-muted">
                    Telecaller
                  </th>
                  <th scope="col" className="border-b border-border px-4 py-2.5 text-right text-xs font-medium text-text-muted">
                    Calls
                  </th>
                  <th scope="col" className="border-b border-border px-4 py-2.5 text-right text-xs font-medium whitespace-nowrap text-text-muted">
                    Talk time
                  </th>
                  <th scope="col" className="border-b border-border px-4 py-2.5 text-right text-xs font-medium text-text-muted">
                    Leads
                  </th>
                  <th scope="col" className="border-b border-border px-4 py-2.5 text-right text-xs font-medium text-text-muted">
                    Won
                  </th>
                  <th scope="col" className="border-b border-border px-4 py-2.5 text-right text-xs font-medium text-text-muted">
                    Pipeline
                  </th>
                  <th scope="col" className="border-b border-border px-4 py-2.5 text-xs font-medium whitespace-nowrap text-text-muted">
                    Last call
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {telecallers.map((t) => (
                  <tr
                    key={t.id}
                    className="transition-colors duration-150 ease-out hover:bg-surface-hover"
                  >
                    <td className="px-4 py-3 align-middle text-text">
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
                    <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                      {t.calls}
                    </td>
                    <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                      {formatDuration(t.talk_seconds)}
                    </td>
                    <td className="px-4 py-3 text-right align-middle font-medium text-text tabular-nums">
                      {t.leads}
                    </td>
                    <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                      {t.won}
                    </td>
                    <td className="px-4 py-3 text-right align-middle text-text tabular-nums">
                      {formatValue(t.pipeline_value)}
                    </td>
                    <td className="px-4 py-3 align-middle text-text-muted tabular-nums">
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
          <Link href="/owner/leads" className={PANEL_LINK}>
            All leads →
          </Link>
        </div>
        {data.recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">No leads yet</p>
        ) : (
          <div className="divide-y divide-border">
            {data.recent.map((lead) => (
              <Link
                key={lead.id}
                href={`/owner/leads?focus=${lead.id}`}
                className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2.5 transition-colors duration-150 ease-out hover:bg-surface-hover"
              >
                <div className="min-w-0">
                  <span className="block truncate font-medium text-text">{lead.title}</span>
                  <span className="text-xs text-text-muted">
                    {lead.telecaller ?? "unassigned"} · {relativeTime(lead.last_activity_at)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {num(lead.value_num) === null ? null : (
                    <span className="text-xs font-medium text-text tabular-nums">
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
    <div className="space-y-2 py-8 text-center">
      <p className="text-sm font-medium text-text">No leads yet</p>
      <p className="mx-auto max-w-sm text-sm leading-relaxed text-text-muted">
        A lead appears here once a recorded call is transcribed and the AI agent
        extracts something usable from it. If calls are arriving but no leads
        are, the extraction agent may need tuning.
      </p>
    </div>
  );
}
