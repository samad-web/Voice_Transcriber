import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { rateText, sourceRows } from "@/lib/dashboard-charts";
import { CHANNEL_LABELS, PANEL_LINK } from "../dashboard-panels";
import { formatValue, type Overview } from "../types";
import { ChartTable, SwatchKey, TD, TD_NUM, TH, TH_NUM, TOOLTIP_BOX } from "./chart-parts";

/**
 * Which channel is worth the money - volume and conversion side by side
 * (Build docs/29 §3.9).
 *
 * ── ALIGNED ROWS, NOT A SCATTER, NOT A DUAL AXIS ────────────────────────────
 *
 * A scatter of volume against rate needs a label on every dot, and with long
 * channel names they collide; a bar-plus-rate-line needs a second y-axis,
 * which invents a correlation. So each channel is one row carrying three
 * readings that share it: leads as a bar, conversion as a DOT on a fixed 0-100%
 * track, won value as text.
 *
 * "Won so far", never "converted": it is won ÷ ARRIVED in the window, a cohort
 * that is still mostly open - a different number from the KPI row's win rate
 * (won ÷ CLOSED). Two figures both called "converted" on one page, 9% and 63%,
 * would read as a contradiction.
 *
 * A dot, because a rate is a POSITION on a fixed scale compared against the
 * average - the reference tick is the all-channel rate - and a bar would read
 * as a quantity piled up. Under five leads the dot is hollow and the rate
 * prints as "2 of 3": a confident percentage over a thin base is how a channel
 * that produced nothing keeps its budget.
 *
 * All ink. The accent-blue bars this replaced broke the console's colour rule
 * (blue means an outgoing call here), and brandable accent is not a data hue.
 */
export function SourceEffectiveness({
  bySource,
  days,
  period,
}: {
  bySource: Overview["bySource"];
  days: number;
  /** The window in words when it is not "last N days" - a custom range's dates. */
  period?: string;
}) {
  const { rows, overall, maxLeads } = sourceRows(bySource);
  const arrived = period ?? `in the last ${days} days`;

  return (
    <Card elevated className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="space-y-0.5">
          <MonoLabel>Where leads came from, and what they became</MonoLabel>
          <p className="text-xs text-text-muted">Leads that arrived {arrived}, and how many are won so far</p>
        </div>
        <Link href="/owner/lead-sources" className={PANEL_LINK}>
          Lead sources →
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm font-medium text-text">No leads arrived {arrived}</p>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-text-muted">
            Connect a channel on Lead sources - a web form, an inbox, Meta Lead Ads or a CSV - and arrivals are
            attributed here automatically.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <SwatchKey swatch="bg-text" label="Leads" />
            <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-text" /> Won so far
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <span aria-hidden="true" className="h-3 w-px bg-text-muted" /> All channels{overall !== null ? ` (${Math.round(overall * 100)}%)` : ""}
            </span>
          </div>

          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Channels">
            <div aria-hidden="true" className="min-w-[520px] space-y-2">
              <div className="grid grid-cols-[minmax(7rem,10rem)_minmax(0,1.3fr)_minmax(0,1fr)_4.5rem] gap-4 text-[11px] text-text-subtle">
                <span>Channel</span>
                <span>Leads</span>
                <span>Won so far (0-100%)</span>
                <span className="text-right">Won value</span>
              </div>
              {rows.map((row) => (
                <div key={row.channel} className="grid grid-cols-[minmax(7rem,10rem)_minmax(0,1.3fr)_minmax(0,1fr)_4.5rem] items-center gap-4">
                  <span className="truncate text-sm text-text">{CHANNEL_LABELS[row.channel] ?? row.channel}</span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-3.5 shrink-0 rounded-r bg-text" style={{ width: `max(3px, calc((100% - 2.5rem) * ${(row.leads / Math.max(1, maxLeads)).toFixed(4)}))` }} />
                    <span className="text-xs text-text tabular-nums">{row.leads}</span>
                  </span>
                  <span className="group relative flex h-5 items-center">
                    {/* The fixed 0-100% track, the all-channel reference, and the dot. */}
                    <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
                    {overall !== null ? (
                      <span className="absolute top-0.5 bottom-0.5 w-px bg-text-muted" style={{ left: `${overall * 100}%` }} />
                    ) : null}
                    {row.rate !== null ? (
                      <span
                        className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface ${
                          row.small ? "border-2 border-text bg-surface" : "bg-text"
                        }`}
                        style={{ left: `${row.rate * 100}%` }}
                      />
                    ) : null}
                    <span className={`${TOOLTIP_BOX} bottom-full left-0 mb-1 group-hover:visible`}>
                      <span className="block font-semibold text-text tabular-nums">{rateText(row.won, row.leads)} won so far</span>
                      <span className="block tabular-nums">
                        {row.won} won of {row.leads} {row.leads === 1 ? "lead" : "leads"}
                        {overall !== null ? ` · all channels ${Math.round(overall * 100)}%` : ""}
                      </span>
                    </span>
                  </span>
                  <span className="text-right text-xs text-text tabular-nums">{row.won_value > 0 ? formatValue(row.won_value) : "-"}</span>
                </div>
              ))}
            </div>
          </div>

          <ChartTable>
            <table className="w-full min-w-[420px] border-collapse">
              <caption className="sr-only">Leads by channel that arrived {arrived}, and how many are won</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Channel</th>
                  <th scope="col" className={TH_NUM}>Leads</th>
                  <th scope="col" className={TH_NUM}>Won</th>
                  <th scope="col" className={TH_NUM}>Share won so far</th>
                  <th scope="col" className={TH_NUM}>Won value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.channel}>
                    <th scope="row" className={`${TD} font-normal`}>{CHANNEL_LABELS[row.channel] ?? row.channel}</th>
                    <td className={TD_NUM}>{row.leads}</td>
                    <td className={TD_NUM}>{row.won}</td>
                    <td className={TD_NUM}>{rateText(row.won, row.leads)}</td>
                    <td className={TD_NUM}>{formatValue(row.won_value)}</td>
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
