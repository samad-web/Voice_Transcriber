import type { Metadata } from "next";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { formatValue } from "../types";

export const metadata: Metadata = { title: "Reports — Aura" };

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
  rows: Array<{ stage: string; label: string; reached: number; conversionFromPrevious: number | null }>;
  summary: { created: number; won: number; lost: number; open: number; winRate: number | null } | null;
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
  value === null ? "—" : `${Math.round(value * 100)}%`;

/**
 * Pipeline reporting (PRD Layer 3).
 *
 * Server-rendered in full: every figure here is an aggregate the API already
 * computes, and a dashboard whose numbers arrive after the layout is the
 * classic way to make a reader trust the wrong figure for a second.
 *
 * The three reports are fetched in parallel and degrade independently — a
 * role that may not read one still gets the others rather than an empty page.
 */
export default async function ReportsPage() {
  const [pipeline, conversion, performance, attainment] = await Promise.all([
    ownerGet<PipelineReport>("/v1/reports/pipeline"),
    ownerGet<ConversionReport>("/v1/reports/conversion"),
    ownerGet<PerformanceReport>("/v1/reports/performance"),
    ownerGet<AttainmentReport>("/v1/targets/attainment"),
  ]);

  if (!pipeline && !conversion && !performance) {
    return (
      <>
        <PageHeader title="Reports" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Reports" context="Pipeline" />

      {pipeline?.pipeline ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Open pipeline" value={formatValue(pipeline.totals.amount)} />
          <Stat
            label="Weighted forecast"
            value={formatValue(pipeline.totals.weightedAmount)}
            hint="Discounted by each stage's likelihood of closing"
          />
          <Stat label="Open deals" value={String(pipeline.totals.deals)} />
          <Stat
            label="Avg days to win"
            value={pipeline.totals.avgDaysToWin === null ? "—" : String(pipeline.totals.avgDaysToWin)}
            hint={`${pipeline.totals.wonDeals} won so far`}
          />
        </div>
      ) : null}

      {attainment && attainment.attainment.length > 0 ? (
        <Card>
          <MonoLabel>Against target</MonoLabel>
          <p className="mt-1 text-xs text-text-muted">
            Measured against PACE, not against the whole number — 40% of a quarter&rsquo;s target is
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
                    is a bar rather than a percentage — it turns a number into
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
                    <Td right>{row.avgDaysInStage ?? "—"}</Td>
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
                {conversion.summary.created} deals created since {conversion.from} ·{" "}
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
              Inferred from each deal&apos;s current stage — there is no per-stage history yet, so a
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
          <EmptyState title="Nothing in this window" description="No deals were created since the window opened." />
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
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <MonoLabel>{label}</MonoLabel>
      <p className="mt-1 text-2xl font-semibold text-text tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
    </Card>
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
  return (
    <p className="mt-2 text-sm text-text-muted">Not visible with your permissions.</p>
  );
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
