import type { Metadata } from "next";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { DEFAULT_TIME_ZONE, OWNER_ROLE_ADMINS, todayIn } from "@aura/shared";
import { DateRangeBar, DateRangeNotice, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import {
  DEFAULT_RANGE_DAYS,
  parseDateWindow,
  rangePresets,
  resolveDateWindow,
  windowTitle,
} from "@/lib/date-range";
import { normaliseStaleAfterDays } from "@/lib/deal-staleness";
import { getOwner, ownerGet, ownerTry } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import {
  closedDealsHref,
  formatDateRange,
  formatDuration,
  formatPercent,
  formatPercentPoints,
  leadsArrivedHref,
  openDealsHref,
  openLeadsHref,
  staleDealsHref,
} from "@/lib/report-dashboard";
import { formatValue } from "../types";
import { CommissionPlansClient } from "./commission-plans-client";
import type { CommissionPlan } from "./commission-actions";
import { DailyLeadsChart, type DailyLeadsRow } from "./daily-leads-chart";
import { MetricCard } from "./metric-card";
import { OverdueMetricCard } from "./overdue-metric-card";
import { StageValueChart } from "./stage-value-chart";

export const metadata: Metadata = { title: "Sales overview" };

interface ResponseTimeReport {
  from: string;
  to: string;
  kpi: {
    leads: number;
    responded: number;
    unresponded: number;
    medianMinutes: number | null;
    within1hrPct: number | null;
  };
  daily: DailyLeadsRow[];
}

interface LeadAgingReport {
  total: number;
  neverResponded: number;
}

interface PipelineListItem {
  id: string;
  is_default: boolean;
  status: "active" | "archived";
  stale_after_days?: number;
}

interface PipelineReport {
  pipeline: { id: string; name: string } | null;
  rows: Array<{
    stage: string;
    label: string;
    probability: number;
    deals: number;
    amount: number;
    weightedAmount: number;
    avgDaysInStage: number | null;
  }>;
  totals: {
    deals: number;
    amount: number;
    weightedAmount: number;
    wonDeals: number;
    avgDaysToWin: number | null;
  };
}

interface ConversionReport {
  pipeline: { id: string; name: string } | null;
  from: string;
  to: string;
  rows: Array<{
    stage: string;
    label: string;
    reached: number;
    conversionFromPrevious: number | null;
  }>;
  summary: {
    created: number;
    won: number;
    lost: number;
    open: number;
    winRate: number | null;
  } | null;
}

interface PerformanceReport {
  from: string;
  to: string;
  reps: Array<{
    repId: string | null;
    rep: string;
    openDeals: number;
    wonDeals: number;
    lostDeals: number;
    openValue: number;
    wonValue: number;
    winRate: number | null;
  }>;
  workspace: { tasksCompleted: number; tasksOverdue: number; interactions: number };
}

interface CommissionReport {
  from: string;
  to: string;
  rows: Array<{
    planId: string;
    planName: string;
    metric: "won_value" | "won_count" | "calls";
    rateType: "percent" | "flat_per_unit";
    rate: number;
    repId: string | null;
    rep: string;
    metricTotal: number;
    commission: number;
  }>;
}

interface AttainmentReport {
  attainment: Array<{
    targetId: string;
    ownerUserId: string | null;
    ownerName: string | null;
    metric: "won_value" | "won_count";
    periodStart: string;
    periodEnd: string;
    target: number;
    actual: number;
    ratio: number;
    periodElapsed: number;
    pace: number;
    status: "ahead" | "on track" | "behind" | "not started";
  }>;
  asOf: string;
}

const pct = (value: number | null): string =>
  value === null ? "-" : `${Math.round(value * 100)}%`;

/**
 * Pipeline reporting (PRD Layer 3), led by the dashboard (CRM dashboard Phase 6).
 *
 * ── ABOVE THE FOLD: SIX NUMBERS, TWO CHARTS ─────────────────────────────────
 *
 * One date-range row, then six metric cards, then two charts - and nothing
 * else before the fold. Every card and every bar opens the list of the records
 * it counted, with a filter built from what the report ECHOED
 * (lib/report-dashboard.ts), so the number and the list cannot disagree.
 *
 * Four cards are snapshots of now (pipeline value, open leads, stale deals,
 * overdue follow-ups) and say so; two follow the range (conversion, response
 * time), as do the funnel, rep performance and commission further down.
 *
 * Server-rendered in full: every figure here is an aggregate the API already
 * computes, and a dashboard whose numbers arrive after the layout is the
 * classic way to make a reader trust the wrong figure for a second. The one
 * exception is overdue follow-ups, counted in the browser for the reason
 * overdue-metric-card.tsx gives.
 *
 * The reports are fetched in parallel and degrade independently - a role that
 * may not read one still gets the others rather than an empty page. A card
 * whose report failed says "not available", never a zero.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("reports");

  // `?range=` is what this page wrote before it shared the date control;
  // bookmarks of it still open the range they were saved on.
  const { window, invalid } = parseDateWindow(await searchParams, { legacyDaysKey: "range" });
  // The reports API resolves `days` against a UTC today, so a preset is sent
  // as the workspace's own dates instead (see lib/date-range.ts).
  const owner = await getOwner();
  const zone = owner?.membership.reportingTimezone ?? DEFAULT_TIME_ZONE;
  const requested = resolveDateWindow(window, todayIn(zone));
  const days = new URLSearchParams(requested).toString();

  const [
    pipelineResult,
    conversion,
    performance,
    attainment,
    commission,
    commissionPlans,
    responseTime,
    aging,
    pipelines,
  ] = await Promise.all([
    ownerTry<PipelineReport>("/v1/reports/pipeline"),
    ownerGet<ConversionReport>(`/v1/reports/conversion?${days}`),
    ownerGet<PerformanceReport>(`/v1/reports/performance?${days}`),
    ownerGet<AttainmentReport>("/v1/targets/attainment"),
    ownerGet<CommissionReport>(`/v1/reports/commission?${days}`),
    ownerGet<{ plans: CommissionPlan[] }>("/v1/commission-plans"),
    ownerGet<ResponseTimeReport>(`/v1/reports/response-time?${days}`),
    ownerGet<LeadAgingReport>("/v1/reports/lead-aging"),
    ownerGet<{ pipelines: PipelineListItem[] }>("/v1/pipelines"),
  ]);

  // The pipeline report is the one whose reason is kept (`ownerTry`), because
  // it is the one the page-wide failure below is reported from. It still
  // degrades to null like the other eight, so every card keeps its own
  // "not available" state rather than the page blanking on one report.
  const pipeline = pipelineResult.ok ? pipelineResult.data : null;

  // Stale deals on the SAME pipeline the pipeline report chose, at that
  // pipeline's own threshold - the query the Deals table's "Idle N+ days"
  // chip runs, so the card and the list it opens count the same deals.
  const reportPipelineId = pipeline?.pipeline?.id ?? null;
  const staleAfterDays = normaliseStaleAfterDays(
    pipelines?.pipelines.find((p) => p.id === reportPipelineId)?.stale_after_days,
  );
  const stale = reportPipelineId
    ? await ownerGet<{ total: number }>(
        `/v1/deals?pipelineId=${encodeURIComponent(reportPipelineId)}&staleDays=${staleAfterDays}&limit=1`,
      )
    : null;

  const closed = conversion?.summary ? conversion.summary.won + conversion.summary.lost : 0;

  if (!pipelineResult.ok && !conversion && !performance) {
    return (
      <>
        <PageHeader title="Sales overview" context="Reports" />
        <LoadFailure what="your reports" failure={pipelineResult} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Sales overview" context="Reports" />

      {/* The one filter row, above everything it scopes (dataviz: filters sit
          in a single row above the charts, never inside a card). */}
      <DateRangeBar
        path="/owner/reports"
        presets={rangePresets("/owner/reports", window)}
        from={conversion?.from ?? requested.from}
        to={conversion?.to ?? requested.to}
        today={todayIn(zone)}
      />
      {invalid ? <DateRangeNotice fallbackDays={DEFAULT_RANGE_DAYS} /> : null}
      <DateRangeSummary
        from={conversion?.from ?? requested.from}
        to={conversion?.to ?? requested.to}
        zone={zone}
      />

      <section aria-label="Key metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Conversion rate"
          scope="range"
          value={formatPercent(conversion?.summary?.winRate)}
          hint={
            !conversion?.summary
              ? "No pipeline yet."
              : closed === 0
                ? `None of the ${conversion.summary.created} deals created have closed yet.`
                : `${conversion.summary.won} won of ${closed} closed · deals created in range`
          }
          href={conversion?.summary ? closedDealsHref(conversion.pipeline?.id ?? null, conversion.from, conversion.to) : null}
          unavailable={!conversion}
        />
        <MetricCard
          label="Open pipeline value"
          scope="now"
          value={pipeline ? formatValue(pipeline.totals.amount) : "-"}
          hint={
            pipeline
              ? `${pipeline.totals.deals} open deal${pipeline.totals.deals === 1 ? "" : "s"} · ${formatValue(pipeline.totals.weightedAmount)} weighted`
              : undefined
          }
          href={pipeline?.pipeline ? openDealsHref(pipeline.pipeline.id) : null}
          unavailable={!pipeline}
        />
        <MetricCard
          label="Median first response"
          scope="range"
          value={formatDuration(responseTime?.kpi.medianMinutes)}
          hint={
            !responseTime
              ? undefined
              : responseTime.kpi.leads === 0
                ? "No leads arrived in this range."
                : `${responseTime.kpi.responded} of ${responseTime.kpi.leads} leads answered · ${formatPercentPoints(responseTime.kpi.within1hrPct)} within 1 h`
          }
          href={responseTime ? leadsArrivedHref(responseTime.from, responseTime.to) : null}
          unavailable={!responseTime}
        />
        <MetricCard
          label="Open leads"
          scope="now"
          value={aging ? String(aging.total) : "-"}
          hint={aging ? `${aging.neverResponded} never contacted` : undefined}
          href={openLeadsHref()}
          unavailable={!aging}
        />
        <MetricCard
          label="Stale deals"
          scope="now"
          value={stale ? String(stale.total) : "-"}
          hint={`Open and idle ${staleAfterDays}+ days`}
          href={staleDealsHref(reportPipelineId)}
          unavailable={!stale}
        />
        <OverdueMetricCard />
      </section>

      <section aria-label="Charts" className="grid gap-6 lg:grid-cols-2">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-text">Open pipeline by stage</h2>
            <span className="text-xs text-text-muted">Value · open deals · right now</span>
          </div>
          {!pipeline ? (
            <NotPermitted />
          ) : !pipeline.pipeline ? (
            <EmptyState title="No pipeline yet" description="Create a deal to see where the value sits." />
          ) : (
            <StageValueChart rows={pipeline.rows} pipelineId={pipeline.pipeline.id} />
          )}
        </Card>
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-text">New leads per day</h2>
            <span className="text-xs text-text-muted">{windowTitle(window, responseTime ?? undefined)}</span>
          </div>
          {!responseTime ? (
            <NotPermitted />
          ) : (
            <DailyLeadsChart rows={responseTime.daily} from={responseTime.from} to={responseTime.to} />
          )}
        </Card>
      </section>

      {attainment && attainment.attainment.length > 0 ? (
        <Card>
          <MonoLabel>Against target</MonoLabel>
          <p className="mt-1 text-xs text-text-muted">
            Measured against PACE, not against the whole number - 40% of a quarter&rsquo;s target is
            ahead in week two and behind in week eleven.
          </p>
          <ul className="mt-3 space-y-3">
            {attainment.attainment.map((row) => (
              <li key={row.targetId}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-text">
                    {row.ownerName ?? "Whole team"}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusChip
                      tone={
                        row.status === "behind"
                          ? "muted"
                          : row.status === "not started"
                            ? "muted"
                            : "solid"
                      }
                    >
                      {row.status}
                    </StatusChip>
                    <span className="text-xs text-text-muted tabular-nums">
                      {row.metric === "won_count"
                        ? `${row.actual} of ${row.target}`
                        : `${formatValue(row.actual)} of ${formatValue(row.target)}`}
                      {" · "}
                      {pct(row.ratio)}
                    </span>
                  </span>
                </div>
                {/* Two marks on one bar: filled = actual, the tick = where a
                    steady seller would be today. The tick is the reason this
                    is a bar rather than a percentage - it turns a number into
                    a comparison without needing a sentence. */}
                <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-surface-hover">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.min(100, Math.round(row.ratio * 100))}%` }}
                  />
                  <div
                    aria-hidden="true"
                    title={`Pace: ${pct(row.periodElapsed)} through the period`}
                    className="absolute top-0 h-full w-0.5 bg-text-subtle"
                    style={{ left: `${Math.min(100, Math.round(row.periodElapsed * 100))}%` }}
                  />
                </div>
                <span className="mt-1 block text-xs text-text-subtle tabular-nums">
                  {row.periodStart} → {row.periodEnd} · {pct(row.periodElapsed)} elapsed
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonoLabel>Forecast by stage</MonoLabel>
          <ExportLink report="pipeline" />
        </div>
        {pipeline?.pipeline ? (
          <p className="mt-2 text-xs text-text-muted">
            Weighted forecast{" "}
            <span className="font-medium text-text">{formatValue(pipeline.totals.weightedAmount)}</span> · average{" "}
            <span className="font-medium text-text">
              {pipeline.totals.avgDaysToWin === null ? "-" : pipeline.totals.avgDaysToWin}
            </span>{" "}
            days to win across {pipeline.totals.wonDeals} won deal{pipeline.totals.wonDeals === 1 ? "" : "s"}
          </p>
        ) : null}
        {!pipeline ? (
          <NotPermitted />
        ) : pipeline.rows.length === 0 ? (
          <EmptyState title="No pipeline yet" description="Create a deal to see a forecast." />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead>
                <tr>
                  <Th>Stage</Th>
                  <Th right>Deals</Th>
                  <Th right>Value</Th>
                  <Th right>Likelihood</Th>
                  <Th right>Weighted</Th>
                  <Th right>Avg days</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pipeline.rows.map((row) => (
                  <tr key={row.stage}>
                    <Td>{row.label}</Td>
                    <Td right>{row.deals}</Td>
                    <Td right>{formatValue(row.amount)}</Td>
                    <Td right>{pct(row.probability)}</Td>
                    <Td right>{formatValue(row.weightedAmount)}</Td>
                    <Td right>{row.avgDaysInStage ?? "-"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonoLabel>Conversion funnel</MonoLabel>
          <ExportLink report="conversion" />
        </div>
        {!conversion ? (
          <NotPermitted />
        ) : (
          <>
            {conversion.summary ? (
              <p className="mt-2 text-xs text-text-muted">
                {conversion.summary.created} deals created {formatDateRange(conversion.from, conversion.to)} ·{" "}
                {conversion.summary.won} won · {conversion.summary.lost} lost · win rate{" "}
                <span className="font-medium text-text">{pct(conversion.summary.winRate)}</span>
              </p>
            ) : null}
            <ul className="mt-3 space-y-2">
              {conversion.rows.map((row, i) => {
                const top = conversion.rows[0]?.reached || 1;
                return (
                  <li key={row.stage}>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="font-medium text-text">{row.label}</span>
                      <span className="text-text-muted tabular-nums">
                        {row.reached}
                        {i > 0 && row.conversionFromPrevious !== null
                          ? ` · ${pct(row.conversionFromPrevious)} of previous`
                          : ""}
                      </span>
                    </div>
                    <div
                      className="mt-1 h-2 rounded-full bg-surface-hover"
                      role="img"
                      aria-label={`${row.label}: ${row.reached} deals`}
                    >
                      <div
                        className="h-2 rounded-full bg-accent"
                        style={{ width: `${Math.max(2, Math.round((row.reached / top) * 100))}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-text-muted">
              Inferred from each deal&apos;s current stage - there is no per-stage history yet, so a
              deal that skipped a stage still counts as having passed it, and a lost deal counts
              only as having entered the pipeline.
            </p>
          </>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonoLabel>Rep performance</MonoLabel>
          <ExportLink report="performance" />
        </div>
        {!performance ? (
          <NotPermitted />
        ) : performance.reps.length === 0 ? (
          <EmptyState title="Nothing in this window" description="No deals were created in this date range." />
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                <thead>
                  <tr>
                    <Th>Rep</Th>
                    <Th right>Open</Th>
                    <Th right>Won</Th>
                    <Th right>Lost</Th>
                    <Th right>Open value</Th>
                    <Th right>Won value</Th>
                    <Th right>Win rate</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {performance.reps.map((rep) => (
                    <tr key={rep.repId ?? "unassigned"}>
                      <Td>{rep.rep}</Td>
                      <Td right>{rep.openDeals}</Td>
                      <Td right>{rep.wonDeals}</Td>
                      <Td right>{rep.lostDeals}</Td>
                      <Td right>{formatValue(rep.openValue)}</Td>
                      <Td right>{formatValue(rep.wonValue)}</Td>
                      <Td right>{pct(rep.winRate)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusChip tone="outline">
                {performance.workspace.tasksCompleted} tasks completed
              </StatusChip>
              <StatusChip tone={performance.workspace.tasksOverdue > 0 ? "solid" : "outline"}>
                {performance.workspace.tasksOverdue} overdue
              </StatusChip>
              <StatusChip tone="outline">
                {performance.workspace.interactions} interactions logged
              </StatusChip>
            </div>
            <p className="mt-2 text-xs text-text-muted">
              Task and interaction totals are workspace-wide, not per rep: a rep is a telecaller,
              while a task assignee is a console user, and nothing maps between the two yet.
            </p>
          </>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MonoLabel>Commission</MonoLabel>
          <ExportLink report="commission" />
        </div>
        {!commission ? (
          <NotPermitted />
        ) : commission.rows.length === 0 ? (
          <EmptyState
            title="Nothing to show yet"
            description="Add an active commission plan below, and any rep with activity in this window will appear here."
          />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead>
                <tr>
                  <Th>Plan</Th>
                  <Th>Rep</Th>
                  <Th right>Metric total</Th>
                  <Th right>Commission</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {commission.rows.map((row) => (
                  <tr key={`${row.planId}-${row.repId ?? "unassigned"}`}>
                    <Td>{row.planName}</Td>
                    <Td>{row.rep}</Td>
                    <Td right>
                      {row.metric === "won_value" ? formatValue(row.metricTotal) : row.metricTotal}
                    </Td>
                    <Td right>{formatValue(row.commission)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-text-muted">
          Rate × attainment for the window, recomputed on every load - not payroll: no accrual, no
          claw-back, no approval trail. Calls-based plans are not narrowed by record scope, the same
          disconnect rep performance&apos;s task/interaction totals document: a rep is a telecaller,
          not a console user, and nothing maps between the two.
        </p>
      </Card>

      <Card>
        <MonoLabel>Commission plans</MonoLabel>
        {!commissionPlans ? (
          <NotPermitted />
        ) : (
          <div className="mt-3">
            <CommissionPlansClient
              plans={commissionPlans.plans}
              canEdit={owner ? OWNER_ROLE_ADMINS.includes(owner.membership.ownerRole) : false}
            />
          </div>
        )}
      </Card>
    </>
  );
}

/** A plain link, so the browser downloads rather than JS holding the bytes. */
function ExportLink({ report }: { report: string }) {
  return (
    <a
      href={`/owner/reports/export/${report}`}
      className="text-xs font-medium text-accent-text hover:underline"
    >
      Export CSV
    </a>
  );
}

function NotPermitted() {
  return <p className="mt-2 text-sm text-text-muted">Not visible with your permissions.</p>;
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`border-b border-border px-3 py-2 text-xs font-medium text-text-muted ${
        right ? "text-right" : ""
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td className={`px-3 py-2 text-text ${right ? "text-right tabular-nums" : ""}`}>{children}</td>
  );
}
