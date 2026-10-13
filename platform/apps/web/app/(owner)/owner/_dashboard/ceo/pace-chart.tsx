import { formatDateKey } from "@aura/shared";
import { countAxis } from "@/lib/dashboard-charts";
import type { ForecastDay, Grain, GrainBucket, SeriesKey } from "@/lib/ceo-dashboard";
import { AXIS_TEXT, ChartTable, Insight, SwatchKey, TD, TD_NUM, TH, TH_NUM } from "../chart-parts";
import { Panel, PanelEmpty, PanelHead } from "./panel";

/**
 * Calls, new leads, missed inbound and the rolling lead rate, on ONE plot,
 * each projected a fortnight past the window (Build docs/46).
 *
 * ── ONE PLOT, AND WHAT KEEPS IT HONEST ──────────────────────────────────────
 *
 * The standing rule against two y-scales exists because a second axis lets the
 * author set the ratio between two series, and any pair can then be made to
 * look correlated - or anti-correlated - by choosing it. Nothing on the chart
 * tells the reader what was chosen.
 *
 * What makes one plot defensible here is that three of the four series are the
 * SAME UNIT and belong on one scale on their merits: calls, new leads and
 * missed inbound are all counts of the same events, and they NEST - missed
 * inbound is a subset of calls, new leads are what calls produced. On a shared
 * count axis they are a real comparison, and the reader sees directly that
 * leads are a thin slice of dials, which is the finding the page is about.
 *
 * Only `Leads / 100 calls` is a rate, and it takes the right-hand axis. So
 * there is exactly ONE arbitrary ratio on the chart rather than three, it is
 * between a rate and the counts it is derived from, and the right axis is
 * drawn and labelled only while that series is on - a reader who never turns
 * it on never sees a second scale at all. Its legend key says "(right)".
 *
 * A future series in a FOURTH unit does not get a third axis. Give it its own
 * card, or index it to a common base.
 *
 * ── THE MARK ────────────────────────────────────────────────────────────────
 *
 * A 2px line, solid across the window and dotted across the forecast, the two
 * sharing their last point so the projection reads as the same series
 * continuing rather than a second one starting. An SVG stretched over the plot
 * with `preserveAspectRatio="none"` and `non-scaling-stroke`: geometry in
 * column units so every series lands on the shared x exactly, and the stroke
 * stays 2px however wide the card gets.
 *
 * ── THE FORECAST IS FLAT AND SAYS SO ────────────────────────────────────────
 *
 * The band past today is the recent pace carried forward, with its dates
 * asterisked and a legend key that calls it "forecast at current pace". It is
 * not a model. See `forecast()` for why a fitted one would be worse.
 */

const PLOT = 180;

export interface PaneSpec {
  key: SeriesKey;
  label: string;
  /** Actual values, one per bucket, aligned with `buckets`. */
  values: Array<number | null>;
  /** The projection, one per forecast bucket. Empty where a series has none. */
  projected: number[];
  /** The series' mark colour, as literal classes (Tailwind cannot see a computed one). */
  fill: string;
  text: string;
  /** A rate rather than a count - reads the RIGHT axis, and prints a decimal. */
  rate?: boolean;
  /** The earlier half's mean, drawn as a reference rule when comparing. */
  earlier?: number | null;
}

interface Scale {
  top: number;
  mid: number;
}

export function PaceChart({
  buckets,
  forecastDays,
  panes,
  grain,
  compare,
  insight,
  clock,
}: {
  buckets: readonly GrainBucket[];
  forecastDays: readonly ForecastDay[];
  panes: readonly PaneSpec[];
  grain: Grain;
  compare: boolean;
  insight: string | null;
  clock: string;
}) {
  const n = buckets.length;
  if (n === 0 || panes.length === 0) {
    return (
      <Panel>
        <PanelHead title="Pace" clock={clock} />
        <PanelEmpty>No activity in this window.</PanelEmpty>
      </Panel>
    );
  }

  // The forecast shares the actual series' grain, so a weekly chart does not
  // sprout fourteen daily columns on its right-hand edge.
  const perBucket = grain === "weekly" ? 7 : 1;
  const futureCols = Math.max(0, Math.round(forecastDays.length / perBucket));
  const cols = n + futureCols;
  const colPct = 100 / cols;

  const countScale = scaleOver(panes.filter((p) => !p.rate), false);
  const rateScale = scaleOver(panes.filter((p) => p.rate), true);
  const scaleFor = (p: PaneSpec) => (p.rate ? rateScale : countScale)!;

  const xAt = (i: number) => i + 0.5;
  /** A value's y in the 0-100 box, where 0 is the TOP, on its own scale. */
  const yOn = (s: Scale, v: number) => 100 - Math.min(100, (v / s.top) * 100);
  /** The same, as a CSS `bottom` percentage. */
  const bottomOn = (s: Scale, v: number) => 100 - yOn(s, v);

  return (
    <Panel>
      <PanelHead
        title="Pace"
        clock={clock}
        note={
          forecastDays.length > 0
            ? `forecast to ${formatDateKey(forecastDays.at(-1)!.day, { year: false })}`
            : undefined
        }
      />

      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2">
        {/* Left axis - the counts. */}
        <div className={`relative w-8 ${AXIS_TEXT}`} style={{ height: PLOT }}>
          {countScale ? (
            <>
              <span className="absolute right-0 top-0 -translate-y-1/2">{Math.round(countScale.top)}</span>
              <span className="absolute right-0 top-1/2 -translate-y-1/2">{Math.round(countScale.mid)}</span>
              <span className="absolute right-0 bottom-0 translate-y-1/2">0</span>
            </>
          ) : null}
        </div>

        {/* The plot. */}
        <div className="relative" style={{ height: PLOT }}>
          {/* The forecast region - a tinted band, not a second chart. */}
          {futureCols > 0 ? (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 border-l border-dashed border-border-strong bg-bg-subtle"
              style={{ left: `${100 - futureCols * colPct}%`, right: 0 }}
            />
          ) : null}

          <span aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-border" />
          <span aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border" />
          <span aria-hidden="true" className="absolute inset-x-0 bottom-0 border-t border-border-strong" />

          {/* Each series' earlier-half average, where the reader asked for it. */}
          {compare
            ? panes.map((p) =>
                p.earlier != null && p.earlier > 0 ? (
                  <span
                    key={p.key}
                    aria-hidden="true"
                    className={`absolute inset-x-0 border-t border-dashed opacity-60 ${p.text}`}
                    style={{ bottom: `${bottomOn(scaleFor(p), p.earlier)}%`, borderTopColor: "currentColor" }}
                  />
                ) : null,
              )
            : null}

          {panes.map((p) => {
            const s = scaleFor(p);
            const { runs, forecastPath } = geometry(p, n, futureCols, xAt, (v) => yOn(s, v));
            return (
              <svg
                key={p.key}
                aria-hidden="true"
                className={`pointer-events-none absolute inset-0 h-full w-full ${p.text}`}
                viewBox={`0 0 ${cols} 100`}
                preserveAspectRatio="none"
              >
                {runs.map((run, i) => (
                  <polyline
                    key={i}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    points={run.map((pt) => `${pt.x},${pt.y}`).join(" ")}
                  />
                ))}
                {forecastPath.length > 1 ? (
                  <polyline
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="1 2"
                    vectorEffect="non-scaling-stroke"
                    points={forecastPath.map((pt) => `${pt.x},${pt.y}`).join(" ")}
                    opacity={0.75}
                  />
                ) : null}
              </svg>
            );
          })}

          {/*
            ── EVERY LINE IS NAMED ON THE PLOT, NOT ONLY IN THE LEGEND ───────

            This is not decoration, it is what makes four overlaid series
            legal. Two of the four hues are pinned by meaning - red is MISSED
            (state.tsx) and blue is the outgoing-call hue - and with those
            fixed there is no pair of further hues that clears the CVD
            separation floor against both: the validator puts the best
            candidate (amber) at dE 4.4 against red under deuteranopia in dark
            mode, and the dark lightness band is too narrow to re-step out of
            it. Re-stepping cannot solve this; a second encoding can.

            So each line says its own name at its right-hand end, in its own
            colour, and a reader never has to resolve identity by hue. The
            labels are pushed apart vertically where two lines finish close
            together, which on this chart is often - the forecast is flat, so
            several series converge near the baseline on the right.
          */}
          {endLabels(panes, scaleFor, yOn).map((l) => (
            <span
              key={l.key}
              aria-hidden="true"
              // A backing chip, not just lifted type: these labels sit in the
              // forecast region where every series is FLAT, so wherever the
              // label lands some line is running through it horizontally.
              // Lifting alone left the last one struck out by its own series.
              className={`absolute right-1 rounded-[3px] bg-bg-subtle px-1 py-px whitespace-nowrap text-[10px] font-medium ${l.text}`}
              // Sits just ABOVE its line rather than centred on it: a flat
              // series - which the forecast always is - would otherwise run
              // straight through its own label and read as struck out.
              style={{ top: `${l.at}%`, transform: "translateY(-135%)" }}
            >
              {l.label}
            </span>
          ))}

          {/*
            One hit area per bucket carrying ONE tooltip for every series - a
            crosshair read, not a per-series one. With four lines on one plot,
            a tooltip per series would mean four overlapping hit areas and a
            reader hunting for the one that answers "what happened that day".
          */}
          <div className="absolute inset-0 flex">
            {buckets.map((b, i) => (
              <span key={b.day} className="group relative h-full shrink-0" style={{ width: `${colPct}%` }}>
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-strong opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100"
                />
                {panes.map((p) =>
                  p.values[i] != null ? (
                    <span
                      key={p.key}
                      aria-hidden="true"
                      className={`absolute left-1/2 h-1.5 w-1.5 -translate-x-1/2 translate-y-1/2 rounded-full opacity-0 ring-2 ring-surface transition-opacity duration-150 ease-out group-hover:opacity-100 ${p.fill}`}
                      style={{ bottom: `${bottomOn(scaleFor(p), p.values[i]!)}%` }}
                    />
                  ) : null,
                )}
                <span
                  className={`pointer-events-none invisible pointer-coarse:hidden absolute bottom-full z-20 mb-1 w-max max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text-muted shadow-md group-hover:visible ${tooltipAlign(i, n)}`}
                >
                  <span className="mb-1 block font-medium text-text">{bucketLabel(b)}</span>
                  {panes.map((p) => (
                    <span key={p.key} className="flex items-center gap-1.5 whitespace-nowrap">
                      <span aria-hidden="true" className={`h-0.5 w-3 shrink-0 rounded-full ${p.fill}`} />
                      {p.label}
                      <span className="ml-auto pl-3 font-semibold text-text tabular-nums">{cellText(p, i)}</span>
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </div>
        </div>

        {/* Right axis - the rate, and only while a rate series is on. */}
        <div className={`relative w-8 ${AXIS_TEXT}`} style={{ height: PLOT }}>
          {rateScale ? (
            <>
              <span className="absolute left-0 top-0 -translate-y-1/2">{rateScale.top.toFixed(1)}</span>
              <span className="absolute left-0 top-1/2 -translate-y-1/2">{rateScale.mid.toFixed(1)}</span>
              <span className="absolute left-0 bottom-0 translate-y-1/2">0</span>
            </>
          ) : null}
        </div>

        {/* The shared x-axis. Ticks sit at their own column's centre, with the
            end labels anchored to the edges so neither is clipped. */}
        <span />
        <div className={`relative mt-2 h-4 ${AXIS_TEXT}`}>
          {axisTicks(buckets, forecastDays, cols, perBucket).map((t, i, all) => {
            if (i === 0) return <span key={t.at} className="absolute top-0 left-0 whitespace-nowrap">{t.label}</span>;
            if (i === all.length - 1) return <span key={t.at} className="absolute top-0 right-0 whitespace-nowrap">{t.label}</span>;
            return (
              <span
                key={t.at}
                className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
                style={{ left: `${(t.at + 0.5) * colPct}%` }}
              >
                {t.label}
              </span>
            );
          })}
        </div>
        <span />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {panes.map((p) => (
          <SwatchKey
            key={p.key}
            swatch={p.fill}
            // The right axis is named on the series that reads it, so the two
            // scales are never something the reader has to work out.
            label={p.rate && rateScale ? `${p.label} (right axis)` : p.label}
            line
          />
        ))}
        {forecastDays.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
            <span aria-hidden="true" className="h-0.5 w-3.5 border-t-2 border-dotted border-text-muted" />
            Forecast at current pace
          </span>
        ) : null}
        {compare ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
            <span aria-hidden="true" className="h-0.5 w-3.5 border-t border-dashed border-text-subtle" />
            Earlier half&apos;s average
          </span>
        ) : null}
      </div>

      {insight ? <Insight>{insight}</Insight> : null}

      <ChartTable>
        <table className="w-full min-w-[320px] border-collapse">
          <caption className="sr-only">
            {panes.map((p) => p.label).join(", ")} per {grain === "weekly" ? "week" : "day"}
          </caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>{grain === "weekly" ? "Week of" : "Day"}</th>
              {panes.map((p) => (
                <th key={p.key} scope="col" className={TH_NUM}>{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => (
              <tr key={b.day}>
                <th scope="row" className={`${TD} font-normal`}>{formatDateKey(b.day, { year: false })}</th>
                {panes.map((p) => (
                  <td key={p.key} className={TD_NUM}>{cellText(p, i)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ChartTable>
    </Panel>
  );
}

/**
 * The polylines for one series: contiguous runs of real values, plus the
 * forecast anchored on the last real point.
 *
 * Runs rather than one line, because `null` means "not measurable here" - the
 * rolling rate before it has a full week - and a polyline across that gap
 * would draw a segment nobody measured.
 */
function geometry(
  pane: PaneSpec,
  realCols: number,
  futureCols: number,
  xAt: (i: number) => number,
  y: (v: number) => number,
) {
  const runs: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < realCols; i += 1) {
    const v = pane.values[i];
    if (v == null) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push({ x: xAt(i), y: y(v) });
  }
  if (run.length > 0) runs.push(run);
  // A lone point draws nothing as a polyline, so it gets a zero-length
  // segment and its round cap renders as a dot.
  for (const r of runs) if (r.length === 1) r.push({ ...r[0]! });

  const lastReal = runs.at(-1)?.at(-1) ?? null;
  const forecastPath =
    futureCols > 0 && pane.projected.length > 0
      ? [
          ...(lastReal ? [lastReal] : []),
          ...Array.from({ length: futureCols }, (_, i) => ({
            x: xAt(realCols + i),
            y: y(pane.projected[i] ?? pane.projected[0] ?? 0),
          })),
        ]
      : [];

  return { runs, forecastPath };
}

/**
 * Where each series' name goes at the right-hand end of the plot.
 *
 * Anchored on the series' LAST drawn value - the end of the forecast where
 * there is one - then pushed apart so two labels never overprint. A simple
 * one-pass separation: sort by y, and walk down shunting any label that
 * landed within `MIN_GAP` of the one above it. Good enough because the list
 * is at most four long and the plot is only 180px tall; a force simulation
 * for four labels would be a lot of machinery for the same answer.
 *
 * The last label is clamped inside the plot rather than allowed to run off
 * the bottom, which is the case that actually happens: the forecast is flat,
 * so on a quiet floor three series finish on the baseline together.
 */
function endLabels(
  panes: readonly PaneSpec[],
  scaleFor: (p: PaneSpec) => Scale,
  yOn: (s: Scale, v: number) => number,
) {
  const MIN_GAP = 11;
  const rows = panes
    .map((p) => {
      const last =
        p.projected.length > 0
          ? p.projected.at(-1)
          : [...p.values].reverse().find((v): v is number => v != null);
      if (last == null) return null;
      return { key: p.key, label: p.label, text: p.text, at: yOn(scaleFor(p), last) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.at - b.at);

  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]!;
    if (rows[i]!.at - prev.at < MIN_GAP) rows[i]!.at = prev.at + MIN_GAP;
  }
  // Having pushed down, pull the whole stack back up if it overflowed, then
  // keep every label inside the plot - the top one is lifted clear of its
  // line, so it needs headroom of its own.
  const overflow = (rows.at(-1)?.at ?? 0) - (100 - MIN_GAP / 2);
  if (overflow > 0) for (const r of rows) r.at -= overflow;
  for (const r of rows) r.at = Math.min(100, Math.max(9, r.at));

  return rows;
}

/**
 * One scale across every series that shares it - so two count series are
 * directly comparable, which is the whole reason they share an axis. Null
 * when no series reads it, which is what hides the right-hand axis.
 */
function scaleOver(panes: readonly PaneSpec[], rate: boolean): Scale | null {
  if (panes.length === 0) return null;
  const seen = panes.flatMap((p) => [...p.values.filter((v): v is number => v != null), ...p.projected]);
  const max = Math.max(0, ...seen);
  if (!rate) {
    const { top } = countAxis(max);
    return { top, mid: top / 2 };
  }
  // A rate axis rounds up to a half, so 1.3 gets a 1.5 top rather than a 2
  // that leaves the series hugging the floor.
  const top = Math.max(0.5, Math.ceil(max * 2) / 2);
  return { top, mid: top / 2 };
}

function cellText(pane: PaneSpec, i: number): string {
  const v = pane.values[i];
  if (v == null) return "–";
  return pane.rate ? v.toFixed(1) : String(v);
}

function bucketLabel(b: GrainBucket): string {
  return b.span === 1
    ? formatDateKey(b.day, { year: false })
    : `${formatDateKey(b.day, { year: false })} – ${formatDateKey(b.endDay, { year: false })}`;
}

/** A tooltip near an edge opens inward so it never leaves the card. */
function tooltipAlign(index: number, count: number): string {
  if (index < count / 4) return "left-0";
  if (index >= (3 * count) / 4) return "right-0";
  return "left-1/2 -translate-x-1/2";
}

/**
 * Four or five x labels, never one per column.
 *
 * A thirty-day axis with thirty dates on it is a grey smear; the reader needs
 * to know where they are, not to read every tick. Forecast dates carry an
 * asterisk, which the legend explains - a future date printed plainly beside
 * past ones is the chart's most quietly misleading element.
 */
function axisTicks(
  buckets: readonly GrainBucket[],
  forecastDays: readonly ForecastDay[],
  cols: number,
  perBucket: number,
) {
  const dayAt = (i: number) =>
    i < buckets.length
      ? buckets[i]!.day
      : forecastDays[Math.min(forecastDays.length - 1, (i - buckets.length) * perBucket)]?.day;

  const every = Math.max(1, Math.ceil(cols / 5));
  const at = new Set<number>();
  for (let i = 0; i < cols; i += every) at.add(i);
  // The last column always gets a label - it is the one the reader looks for,
  // and an even stride almost never lands on it.
  at.add(cols - 1);
  if (at.has(cols - 2)) at.delete(cols - 2);

  return [...at]
    .sort((a, b) => a - b)
    .flatMap((i) => {
      const day = dayAt(i);
      return day ? [{ at: i, label: `${formatDateKey(day, { year: false })}${i >= buckets.length ? "*" : ""}` }] : [];
    });
}
