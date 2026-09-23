import { Card, MonoLabel } from "@aura/ui";
import { formatHourBand } from "@aura/shared";
import { edgeLabels, heatGrid, heatInsight, missedClass, missedEdges, rateText } from "@/lib/dashboard-charts";
import type { CallHeatCell } from "../types";
import { AXIS_TEXT, ChartTable, Insight, TD, TD_NUM, TH, TH_NUM, TOOLTIP, edgeAlign } from "./chart-parts";

/**
 * The missed-call ramp, class 1..4 (Build docs/29 §4.3): the MISSED state's own
 * hue as a magnitude, validated as an ordinal ramp in both modes. Literal class
 * names because Tailwind only generates what it can see in source.
 */
const MISSED_FILL = ["", "bg-chart-missed-1", "bg-chart-missed-2", "bg-chart-missed-3", "bg-chart-missed-4"] as const;

/** Inbound calls came in and every one was answered - neutral, not a state. */
const ANSWERED_ONLY = "bg-border";

/**
 * When inbound calls go unanswered - weekday × hour (docs/29 §3.4).
 *
 * ── WHY A HEATMAP ───────────────────────────────────────────────────────────
 *
 * "We miss calls" is not actionable; "we miss calls on Tuesdays between one
 * and two" is a staffing decision. Two ordered dimensions and one magnitude is
 * exactly a heatmap's job - a bar per hour loses the weekday, and seven small
 * line charts ask the reader to compare seven shapes.
 *
 * ── WHY THE COLOUR IS A COUNT, NOT A RATE ───────────────────────────────────
 *
 * A rate makes one-of-one at 07:00 the darkest cell on the grid. The count is
 * the business actually lost, which is what staffing fixes; the rate and its
 * base are in the tooltip and the table.
 *
 * ── THREE STATES THAT MUST LOOK DIFFERENT ───────────────────────────────────
 *
 * No inbound calls (an outlined empty cell), inbound but none missed (neutral
 * grey - the phones rang and we answered), and missed (the ramp). Collapsing
 * the first two would make a closed office look like a perfect one.
 *
 * Hours are the WORKSPACE's hours (docs/30): in UTC an Indian lunch hour would
 * draw at 07:30.
 */
export function MissedHeatmap({
  cells,
  days,
  period,
  label = "When inbound calls go unanswered",
}: {
  cells: CallHeatCell[];
  days: number;
  /** The window in words when it is not "last N days" - a custom range's dates. */
  period?: string;
  label?: string;
}) {
  const grid = heatGrid(cells);
  const edges = missedEdges(grid.maxMissed);
  const legend = edgeLabels(edges);
  const insight = heatInsight(grid);
  const cols = grid.hours.length;

  return (
    <Card elevated className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>{label}</MonoLabel>
        <span className="text-xs text-text-muted tabular-nums">
          <span className="font-medium text-text">{grid.totalMissed}</span> missed of {grid.totalInbound} inbound · {period ?? `last ${days} days`}
        </span>
      </div>

      {grid.totalInbound === 0 ? (
        <p className="py-10 text-center text-sm text-text-muted">
          No inbound calls in these {days} days. Missed calls are plotted here by weekday and hour as they arrive.
        </p>
      ) : (
        <>
          {/* Scrolls sideways on a phone; the weekday column stays pinned. */}
          <div tabIndex={0} role="region" aria-label={`${label} - scroll for more hours`} className="overflow-x-auto">
            <div aria-hidden="true" className="inline-grid min-w-full gap-[2px]" style={{ gridTemplateColumns: `2.25rem repeat(${cols}, minmax(14px, 1fr)) 2.5rem` }}>
              <span />
              {grid.hours.map((h) => (
                <span key={h} className={`text-center ${AXIS_TEXT}`}>
                  {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                </span>
              ))}
              <span className={`text-right ${AXIS_TEXT}`}>Missed</span>

              {grid.rows.map((row) => (
                <HeatRow key={row.dow} row={row} edges={edges} cols={cols} />
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex gap-[2px]" aria-hidden="true">
                {edges.map((_, k) => (
                  <span key={k} className={`h-3 w-3 rounded-[3px] ${MISSED_FILL[k + 1]}`} />
                ))}
              </span>
              Missed calls {legend.length > 1 ? `(${legend[0]} to ${legend[legend.length - 1]})` : `(${legend[0] ?? 0})`}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`h-3 w-3 rounded-[3px] ${ANSWERED_ONLY}`} />
              Calls came in, none missed
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-3 w-3 rounded-[3px] border border-border" />
              No inbound calls
            </span>
          </div>

          {insight ? <Insight>{insight}</Insight> : null}

          <ChartTable>
            <table className="w-full min-w-[360px] border-collapse">
              <caption className="sr-only">{label}, by weekday and hour</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Day</th>
                  <th scope="col" className={TH}>Hour</th>
                  <th scope="col" className={TH_NUM}>Inbound</th>
                  <th scope="col" className={TH_NUM}>Missed</th>
                  <th scope="col" className={TH_NUM}>Missed share</th>
                </tr>
              </thead>
              <tbody>
                {grid.rows.flatMap((row) =>
                  row.cells
                    .filter((c) => c.inbound > 0)
                    .map((c) => (
                      <tr key={`${row.dow}:${c.hour}`}>
                        <th scope="row" className={`${TD} font-normal`}>{row.label}</th>
                        <td className={TD}>{formatHourBand(c.hour)}</td>
                        <td className={TD_NUM}>{c.inbound}</td>
                        <td className={TD_NUM}>{c.missed}</td>
                        <td className={TD_NUM}>{rateText(c.missed, c.inbound)}</td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </ChartTable>
        </>
      )}
    </Card>
  );
}

function HeatRow({
  row,
  edges,
  cols,
}: {
  row: ReturnType<typeof heatGrid>["rows"][number];
  edges: number[];
  cols: number;
}) {
  return (
    <>
      <span className={`sticky left-0 z-10 flex items-center bg-surface pr-1 ${AXIS_TEXT}`}>{row.label}</span>
      {row.cells.map((c, i) => {
        const k = missedClass(c.missed, edges);
        const fill = c.inbound === 0 ? "border border-border" : k === 0 ? ANSWERED_ONLY : MISSED_FILL[k];
        return (
          <span key={c.hour} className="group relative">
            <span
              className={`block h-5 rounded-sm transition-[outline] duration-150 ease-out group-hover:outline-2 group-hover:outline-offset-1 group-hover:outline-text ${fill}`}
            />
            {/* The grid scrolls sideways, and overflow-x clips vertically too - so
                the top rows open their tooltip downward and the rest upward, and
                none is cut off by its own scroll box. */}
            <span className={`${TOOLTIP} ${row.dow <= 3 ? "top-full mt-1" : "bottom-full mb-1"} ${edgeAlign(i, cols)}`}>
              <span className="block font-medium text-text">
                {row.label} · {formatHourBand(c.hour)}
              </span>
              {c.inbound === 0 ? (
                <span className="block">No inbound calls</span>
              ) : (
                <span className="block tabular-nums">
                  <span className="font-semibold text-text">{c.missed}</span> missed of {c.inbound} inbound
                  {c.inbound >= 5 ? ` (${Math.round((c.missed / c.inbound) * 100)}%)` : ""}
                </span>
              )}
            </span>
          </span>
        );
      })}
      <span className={`flex items-center justify-end ${AXIS_TEXT}`}>{row.missed}</span>
    </>
  );
}
