import Link from "next/link";
import { Card, MonoLabel, STATE_TONE } from "@aura/ui";
import { formatDateKey } from "@aura/shared";
import { barPercent, countAxis, dayName, rateText, trailingMean, trendInsight } from "@/lib/dashboard-charts";
import { leadsArrivedHref } from "@/lib/report-dashboard";
import type { OverviewDay } from "../types";
import { AXIS_TEXT, ChartTable, Insight, StateKey, SwatchKey, TD, TD_NUM, TH, TH_NUM, TOOLTIP, edgeAlign } from "./chart-parts";

/**
 * Bottom to top. THIS ORDER IS A CORRECTNESS RULE, not a preference (Build
 * docs/29 §4.1): with missed stacked on answered, red touches green and the
 * pair fails deuteranopia (dE 5.0); with outgoing between them the worst
 * adjacent pair is dE 29.9. Missed on top also puts the number an owner scans
 * for at the silhouette's edge.
 */
const STACK = ["answered", "outgoing", "missed"] as const;

/**
 * Calls and new leads, as two plots on ONE time axis (docs/29 §3.3).
 *
 * ── WHY TWO PLOTS ───────────────────────────────────────────────────────────
 *
 * Calls outnumber new leads five to twenty times. The chart this replaced drew
 * both against one scale, so the leads were slivers and the only trend a
 * marketer reads it for was invisible; a second y-axis would invent a
 * correlation. Small multiples sharing the x-axis give each its own honest
 * scale and still line the days up.
 *
 * ── WHAT IS DRAWN ───────────────────────────────────────────────────────────
 *
 * A: calls per day, stacked by state - total as height, make-up as segments.
 * B: new leads per day, ink columns, plus a trailing 7-day mean (only when the
 *    window has two weeks to average over; a "7-day average" over three days
 *    would be a different claim).
 *
 * Every calendar day of the window has a column, zeros included - the API
 * gap-fills in the org's zone, so a quiet week reads as quiet (docs/29 A2).
 *
 * ── OPERATING IT ────────────────────────────────────────────────────────────
 *
 * The whole day slot, both plots, is one hover target with one tooltip listing
 * every series (the crosshair rule for discrete days). Plot A's area opens that
 * day's calls when the reader may open the call log; plot B's opens that day's
 * leads. The plot is aria-hidden; the table twin carries the same numbers and
 * links for keyboard and screen-reader readers.
 */
export function TrendChart({
  byDay,
  days,
  title,
  leadNoun = "leads",
  showCalls = true,
  callLogHref,
}: {
  byDay: OverviewDay[];
  days: number;
  title: string;
  /** Plural, lower case: "leads", "deals", "arrivals". */
  leadNoun?: string;
  /** False for personas measured on demand, not phones: plot B alone, taller. */
  showCalls?: boolean;
  /** The call log for one day, when this reader may open it. */
  callLogHref?: (day: string) => string;
}) {
  const n = byDay.length;
  const totals = byDay.reduce(
    (t, d) => ({
      calls: t.calls + d.calls,
      answered: t.answered + d.answered,
      missed: t.missed + d.missed,
      leads: t.leads + d.leads,
    }),
    { calls: 0, answered: 0, missed: 0, leads: 0 },
  );
  const axisA = countAxis(Math.max(0, ...byDay.map((d) => d.calls)));
  const axisB = countAxis(Math.max(0, ...byDay.map((d) => d.leads)));
  const mean = n >= 14 ? trailingMean(byDay.map((d) => d.leads), 7) : [];
  const gap = n > 45 ? "gap-px" : "gap-[2px]";
  const singular = leadNoun.replace(/s$/, "");
  const empty = totals.calls === 0 && totals.leads === 0;

  // Plot heights, in px, because the gridlines are laid across every column
  // at fixed offsets and must land exactly on each plot's top/mid/baseline.
  const A = showCalls ? 160 : 0;
  const GAP = showCalls ? 20 : 0;
  const B = showCalls ? 96 : 160;

  const insight = showCalls
    ? trendInsight(byDay)
    : (() => {
        const top = byDay.reduce<OverviewDay | null>((best, d) => (d.leads > 0 && (!best || d.leads >= best.leads) ? d : best), null);
        return top ? `Most ${leadNoun}: ${dayName(top.day)}, ${top.leads}` : null;
      })();

  return (
    <Card elevated className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>{title}</MonoLabel>
        <span className="text-xs text-text-muted tabular-nums">
          {showCalls ? (
            <>
              <span className="font-medium text-text">{totals.calls.toLocaleString("en-IN")}</span> calls ·{" "}
              <span className="font-medium text-text">{rateText(totals.missed, totals.answered + totals.missed)}</span> of inbound
              missed ·{" "}
            </>
          ) : null}
          <span className="font-medium text-text">{totals.leads.toLocaleString("en-IN")}</span> new {leadNoun}
        </span>
      </div>

      {empty ? (
        <p className="py-10 text-center text-sm text-text-muted">
          No {showCalls ? "calls or " : ""}new {leadNoun} in these {days} days.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {showCalls ? STACK.map((s) => <StateKey key={s} state={s} label={STATE_TONE[s].label} />) : null}
            <SwatchKey swatch="bg-text" label={`New ${leadNoun}`} />
            {mean.length ? <SwatchKey swatch="bg-text-muted" label="7-day average" line /> : null}
          </div>

          <div aria-hidden="true" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
            {/* y-axes: clean top, whole midpoint, zero - for each plot. */}
            <div className={`relative w-7 ${AXIS_TEXT}`} style={{ height: A + GAP + B }}>
              {/* Plot A drops its zero: its baseline sits right above plot B's top label, and the rule itself says zero. */}
              {showCalls ? <AxisLabels top={0} height={A} axis={axisA} zero={false} /> : null}
              <AxisLabels top={A + GAP} height={B} axis={axisB} />
            </div>

            <div className="relative" style={{ height: A + GAP + B }}>
              {/* Recessive hairlines: top and middle one step off the surface, the baseline stronger. */}
              {showCalls ? <Gridlines top={0} height={A} /> : null}
              <Gridlines top={A + GAP} height={B} />

              <div className={`absolute inset-0 flex ${gap}`}>
                {byDay.map((d, i) => {
                  const segments = STACK.map((s) => ({ state: s, value: d[s] })).filter((s) => s.value > 0);
                  const plotA = (
                    <span className="flex h-full w-full items-end justify-center">
                      {d.calls > 0 ? (
                        <span
                          className="flex w-full max-w-6 flex-col-reverse transition-opacity duration-150 ease-out group-hover:opacity-80"
                          style={{ height: `${barPercent(d.calls, axisA.top)}%` }}
                        >
                          {segments.map((seg, k) => (
                            <span
                              key={seg.state}
                              // The 2px surface gap between segments is a border in the
                              // card's own surface colour, INSIDE each segment's height
                              // (border-box) - so the stack stays exactly as tall as its
                              // total, and nothing strokes around a mark.
                              className={`${STATE_TONE[seg.state].mark} ${k > 0 ? "border-b-2 border-surface" : ""} ${
                                k === segments.length - 1 ? "rounded-t" : ""
                              }`}
                              style={{ height: `${(seg.value / d.calls) * 100}%` }}
                            />
                          ))}
                        </span>
                      ) : null}
                    </span>
                  );
                  const plotB = (
                    <span className="flex h-full w-full items-end justify-center">
                      {d.leads > 0 ? (
                        <span
                          className="w-full max-w-6 rounded-t bg-text transition-opacity duration-150 ease-out group-hover:opacity-80"
                          style={{ height: `${barPercent(d.leads, axisB.top)}%` }}
                        />
                      ) : null}
                    </span>
                  );
                  return (
                    <div key={d.day} className="group relative flex min-w-0 flex-1 flex-col">
                      <span className="absolute inset-0 rounded-sm transition-colors duration-150 ease-out group-hover:bg-surface-hover" />
                      {showCalls ? (
                        callLogHref && d.calls > 0 ? (
                          <Link href={callLogHref(d.day)} tabIndex={-1} className="relative block" style={{ height: A }}>
                            {plotA}
                          </Link>
                        ) : (
                          <span className="relative block" style={{ height: A }}>
                            {plotA}
                          </span>
                        )
                      ) : null}
                      {showCalls ? <span style={{ height: GAP }} /> : null}
                      {d.leads > 0 ? (
                        <Link href={leadsArrivedHref(d.day, d.day)} tabIndex={-1} className="relative block" style={{ height: B }}>
                          {plotB}
                        </Link>
                      ) : (
                        <span className="relative block" style={{ height: B }}>
                          {plotB}
                        </span>
                      )}

                      <span className={`${TOOLTIP} bottom-full mb-1 ${edgeAlign(i, n)}`}>
                        <span className="block font-medium text-text">{dayName(d.day)}</span>
                        {showCalls ? (
                          <>
                            {[...STACK].reverse().map((s) => (
                              <span key={s} className="mt-1 flex items-center gap-1.5 tabular-nums">
                                <span className={`h-0.5 w-2.5 rounded-full ${STATE_TONE[s].mark}`} />
                                <span className="font-semibold text-text">{d[s]}</span>
                                {STATE_TONE[s].label.toLowerCase()}
                              </span>
                            ))}
                            <span className="mt-1 block tabular-nums">
                              <span className="font-semibold text-text">{d.calls}</span> {d.calls === 1 ? "call" : "calls"} in all
                            </span>
                          </>
                        ) : null}
                        <span className="mt-1 flex items-center gap-1.5 tabular-nums">
                          <span className="h-0.5 w-2.5 rounded-full bg-text" />
                          <span className="font-semibold text-text">{d.leads}</span> new {d.leads === 1 ? singular : leadNoun}
                        </span>
                        {mean[i] !== null && mean[i] !== undefined ? (
                          <span className="mt-1 block tabular-nums">7-day average {mean[i]!.toFixed(1)}</span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>

              {mean.length ? (
                // The trailing mean: a 2px line that stays 2px however far the
                // SVG is stretched (non-scaling stroke), across plot B only.
                // w-full is required: an absolutely positioned <svg> is a replaced
                // element and keeps its 300px intrinsic width however it is inset.
                <svg
                  className="pointer-events-none absolute inset-x-0 w-full text-text-muted"
                  style={{ top: A + GAP, height: B }}
                  viewBox={`0 0 ${n} 100`}
                  preserveAspectRatio="none"
                >
                  <polyline
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    points={mean
                      .map((m, i) => (m === null ? null : `${i + 0.5},${100 - barPercent(m, axisB.top, 0)}`))
                      .filter(Boolean)
                      .join(" ")}
                  />
                </svg>
              ) : null}
            </div>

            <span />
            <div className={`mt-1.5 flex justify-between ${AXIS_TEXT}`}>
              <span>{formatDateKey(byDay[0]!.day, { year: false })}</span>
              {n > 2 ? <span className="max-sm:hidden">{formatDateKey(byDay[Math.floor((n - 1) / 2)]!.day, { year: false })}</span> : null}
              <span>{formatDateKey(byDay[n - 1]!.day, { year: false })}</span>
            </div>
          </div>

          {insight ? <Insight>{insight}</Insight> : null}

          <ChartTable>
            <table className="w-full min-w-[420px] border-collapse">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Day</th>
                  {showCalls ? (
                    <>
                      <th scope="col" className={TH_NUM}>Answered</th>
                      <th scope="col" className={TH_NUM}>Outgoing</th>
                      <th scope="col" className={TH_NUM}>Missed</th>
                      <th scope="col" className={TH_NUM}>Calls</th>
                    </>
                  ) : null}
                  <th scope="col" className={TH_NUM}>New {leadNoun}</th>
                </tr>
              </thead>
              <tbody>
                {byDay.map((d) => (
                  <tr key={d.day}>
                    <th scope="row" className={`${TD} font-normal`}>
                      {dayName(d.day)}
                    </th>
                    {showCalls ? (
                      <>
                        <td className={TD_NUM}>{d.answered}</td>
                        <td className={TD_NUM}>{d.outgoing}</td>
                        <td className={TD_NUM}>{d.missed}</td>
                        <td className={TD_NUM}>
                          {callLogHref && d.calls > 0 ? (
                            <Link href={callLogHref(d.day)} className="hover:underline">
                              {d.calls}
                            </Link>
                          ) : (
                            d.calls
                          )}
                        </td>
                      </>
                    ) : null}
                    <td className={TD_NUM}>
                      {d.leads > 0 ? (
                        <Link href={leadsArrivedHref(d.day, d.day)} className="hover:underline">
                          {d.leads}
                        </Link>
                      ) : (
                        0
                      )}
                    </td>
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

/** Top, whole midpoint and zero for one plot, placed at that plot's offset. */
function AxisLabels({
  top,
  height,
  axis,
  zero = true,
}: {
  top: number;
  height: number;
  axis: { top: number; mid: number | null };
  zero?: boolean;
}) {
  return (
    <>
      <span className="absolute right-0 -translate-y-1/2" style={{ top }}>
        {axis.top}
      </span>
      {axis.mid !== null ? (
        <span className="absolute right-0 -translate-y-1/2" style={{ top: top + height / 2 }}>
          {axis.mid}
        </span>
      ) : null}
      {zero ? (
        <span className="absolute right-0 -translate-y-1/2" style={{ top: top + height }}>
          0
        </span>
      ) : null}
    </>
  );
}

function Gridlines({ top, height }: { top: number; height: number }) {
  return (
    <>
      <span className="absolute inset-x-0 border-t border-border" style={{ top }} />
      <span className="absolute inset-x-0 border-t border-border" style={{ top: top + height / 2 }} />
      <span className="absolute inset-x-0 border-t border-border-strong" style={{ top: top + height }} />
    </>
  );
}
