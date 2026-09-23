import Link from "next/link";
import { Hourglass } from "lucide-react";
import { Card, MonoLabel } from "@aura/ui";
import { stageHealth } from "@/lib/dashboard-charts";
import { EmptyPipeline, PANEL_LINK } from "../dashboard-panels";
import { formatValue, type Overview } from "../types";
import { ChartTable, SwatchKey, TD, TD_NUM, TH, TH_NUM, TOOLTIP_BOX } from "./chart-parts";

/**
 * The grey ordinal ramp, light = fresh, dark = old (Build docs/29 §4.2). One
 * step per AGING_BUCKET, in order. Literal class names for Tailwind's scanner.
 */
const AGE_FILL = ["bg-chart-seq-1", "bg-chart-seq-2", "bg-chart-seq-3", "bg-chart-seq-4", "bg-chart-seq-5"] as const;

/**
 * Pipeline health: where the open pipeline is, AND how long it has been there
 * (docs/29 §3.6).
 *
 * ── WHY ONE BAR DOES BOTH ───────────────────────────────────────────────────
 *
 * The bar this replaced showed only where records ARE, so a 142-lead "New"
 * column looked healthy while 31 of them were a month old. Here the bar's
 * LENGTH is the open count and its SEGMENTS are time in the current stage:
 * length says where, darkness says how long, and the stuck stage is the dark
 * one. A second chart for age would make the reader match stages across two
 * pictures.
 *
 * ── WHY NOT A FUNNEL ────────────────────────────────────────────────────────
 *
 * Stage counts are a snapshot. A funnel's stage-to-stage conversion needs the
 * transition ledger, which leads have only had since 2026-09-21 - it would
 * print invented rates. The honest cohort funnel is on Reports.
 *
 * ── WHY GREY ────────────────────────────────────────────────────────────────
 *
 * Age is an ORDERED magnitude, not a state, so it takes the grey ordinal ramp;
 * amber and red are spoken for (packages/ui state.tsx). Darker already reads
 * as "more". The 30+ bucket also gets words and the hourglass the deals board
 * uses for stale, so the message never rests on shade alone.
 */
export function PipelineHealth({
  data,
  crmPrimary,
  scoped,
  pipelineHref,
  pipelineLinkLabel,
  stageHref,
  label = "Pipeline health",
  showValue = true,
}: {
  data: Overview;
  crmPrimary: boolean;
  scoped?: boolean;
  pipelineHref: string;
  pipelineLinkLabel: string;
  stageHref: (key: string) => string;
  label?: string;
  /** False for a telecaller - no rupee totals on an activity-measured desk (Phase 1 rule). */
  showValue?: boolean;
}) {
  const buckets = data.agingBuckets ?? [];
  const { rows, max } = stageHealth(data.funnel, data.stageAging ?? [], buckets.map((b) => b.key));
  const noun = crmPrimary ? "deals" : "leads";
  const closed = data.closed;
  const stuckTotal = rows.reduce((s, r) => s + r.stuck, 0);
  const openTotal = rows.reduce((s, r) => s + r.open, 0);

  return (
    <Card elevated className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="space-y-0.5">
          <MonoLabel>{label}</MonoLabel>
          <p className="text-xs text-text-muted">Open {noun} by stage, shaded by how long each has sat in it · now</p>
        </div>
        <Link href={pipelineHref} className={PANEL_LINK}>
          {pipelineLinkLabel}
        </Link>
      </div>

      {data.leads.total === 0 ? (
        <EmptyPipeline crmPrimary={crmPrimary} scoped={scoped} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {buckets.map((b, i) => (
              <SwatchKey key={b.key} swatch={AGE_FILL[i] ?? AGE_FILL[4]} label={b.label} />
            ))}
            <span className="text-xs text-text-muted">in the current stage</span>
          </div>

          <ul className="space-y-1">
            {rows.map((row) => (
              <li key={row.key}>
                <Link
                  href={stageHref(row.key)}
                  className="group grid grid-cols-1 gap-x-3 gap-y-1 rounded-md px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-surface-hover sm:grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_minmax(8.5rem,auto)] sm:items-center"
                >
                  <span className="truncate text-sm text-text">{row.label}</span>
                  <span aria-hidden="true" className="flex h-4 min-w-0 items-center">
                    {row.open > 0 ? (
                      <span className="flex h-full gap-[2px]" style={{ width: `${Math.max(1.5, (row.open / max) * 100)}%` }}>
                        {row.buckets.map((count, i) =>
                          count > 0 ? (
                            <span
                              key={i}
                              // Square at the baseline, 4px round at the data end only.
                              className={`group/seg relative h-full last:rounded-r ${AGE_FILL[i] ?? AGE_FILL[4]}`}
                              style={{ flexGrow: count, flexBasis: 0, minWidth: 3 }}
                            >
                              <span className={`${TOOLTIP_BOX} bottom-full left-0 mb-1 group-hover/seg:visible`}>
                                <span className="block font-semibold text-text tabular-nums">
                                  {count} {count === 1 ? noun.replace(/s$/, "") : noun}
                                </span>
                                <span className="block">
                                  {row.label} · {buckets[i]?.label ?? ""} in stage
                                </span>
                              </span>
                            </span>
                          ) : null,
                        )}
                      </span>
                    ) : (
                      // A stage with nothing in it still exists - a hairline, not a gap.
                      <span className="h-full w-px bg-border-strong" />
                    )}
                  </span>
                  <span className="flex items-center justify-end gap-2 text-xs text-text-muted tabular-nums sm:justify-start">
                    <span className="font-medium text-text">{row.open}</span>
                    {showValue && row.value > 0 ? <span>· {formatValue(row.value)}</span> : null}
                    {row.stuck > 0 ? (
                      <span className="inline-flex items-center gap-1 text-text">
                        <Hourglass aria-hidden="true" className="h-3.5 w-3.5 text-warning" />
                        {row.stuck} over 30 days
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-text-muted tabular-nums">
            <span>
              <span className="font-medium text-text">{openTotal}</span> open
              {stuckTotal > 0 ? (
                <>
                  , <span className="font-medium text-text">{stuckTotal}</span> of them stuck over 30 days in one stage
                </>
              ) : null}
            </span>
            {closed ? (
              <span>
                Closed in the window: <span className="font-medium text-text">{closed.won}</span> won
                {showValue && closed.won_value > 0 ? ` (${formatValue(closed.won_value)})` : ""} ·{" "}
                <span className="font-medium text-text">{closed.lost}</span> lost
              </span>
            ) : null}
          </div>

          <ChartTable>
            <table className="w-full min-w-[480px] border-collapse">
              <caption className="sr-only">{label}: open {noun} by stage and days in stage</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Stage</th>
                  {buckets.map((b) => (
                    <th key={b.key} scope="col" className={TH_NUM}>
                      {b.label}
                    </th>
                  ))}
                  <th scope="col" className={TH_NUM}>Open</th>
                  {showValue ? (
                    <th scope="col" className={TH_NUM}>
                      Value
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className={`${TD} font-normal`}>
                      <Link href={stageHref(row.key)} className="hover:underline">
                        {row.label}
                      </Link>
                    </th>
                    {row.buckets.map((count, i) => (
                      <td key={i} className={TD_NUM}>
                        {count}
                      </td>
                    ))}
                    <td className={TD_NUM}>{row.open}</td>
                    {showValue ? <td className={TD_NUM}>{formatValue(row.value)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </ChartTable>
        </>
      )}
    </Card>
  );
}
