"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  describeChart,
  DESIGN_PRESETS,
  seriesColor,
  type DesignPreset,
  type Palette,
  type ResultRow,
  type Widget,
} from "@aura/shared";

/**
 * One widget, drawn.
 *
 * ── WHY EVERY CHART GOES THROUGH ONE COMPONENT ──────────────────────────
 *
 * The theme is data, not CSS classes: switching a design preset has to
 * re-theme every widget on the page at once (prompt 3.3, acceptance criterion
 * 4), and that is only true if there is exactly one place that turns a preset
 * into stroke widths and grid opacities. It is also the single seam behind
 * which the charting library sits - if the ECharts argument ever wins (design
 * doc D5), it lands in this file and nowhere else.
 *
 * ── ACCESSIBILITY IS NOT A LAYER ON TOP ─────────────────────────────────
 *
 * Recharts renders an SVG that a screen reader reads as nothing at all. So
 * every chart here carries a one-sentence summary as its `aria-label` (from
 * the shared `describeChart`) AND a real `<table>` of the same rows behind a
 * disclosure, marked up as data rather than as decoration. Acceptance
 * criterion 17 asks for "an accessible fallback"; a summary alone tells a
 * reader the shape and denies them the numbers, so this ships both.
 */

export interface WidgetResult {
  rows: ResultRow[];
  dimensionKeys: string[];
  measureKeys: string[];
  truncated: boolean;
  error?: string;
}

interface ChartSurfaceProps {
  widget: Widget;
  result: WidgetResult | undefined;
  palette: Palette;
  preset: DesignPreset;
  /** Publishes a click to the page filter bus (design doc D3). */
  onFilter?: (column: string, value: string) => void;
  /** Print mode: no interactions, no animation, fixed height. */
  frozen?: boolean;
}

const AXIS_TICK = { fontSize: 11, fill: "var(--color-text-muted)" };

export function ChartSurface({
  widget,
  result,
  palette,
  preset,
  onFilter,
  frozen,
}: ChartSurfaceProps) {
  const spec = DESIGN_PRESETS[preset].chart;

  if (widget.type === "text") {
    return (
      <div className="prose-sm max-w-none whitespace-pre-wrap text-sm leading-relaxed text-text">
        {widget.options.body ?? ""}
      </div>
    );
  }
  if (widget.type === "divider") {
    return <hr className="my-2 border-border" aria-hidden="true" />;
  }

  // ── the four states a data widget can be in, all of them visible ──────
  //
  // Prompt 3.7 is explicit that none of these may fail silently. They are
  // ordered by what the reader needs to know first: a broken widget is a
  // different problem from an unmapped one, and both are different from
  // "the query ran and there is genuinely nothing there".
  if (!widget.datasetId || !widget.query) {
    return (
      <Placeholder
        tone="hint"
        title="Not mapped yet"
        body={widget.placeholder ?? "Pick a data source and a column to chart."}
      />
    );
  }
  if (!result) {
    return <Placeholder tone="hint" title="Loading" body="Fetching this widget's data." />;
  }
  if (result.error) {
    return <Placeholder tone="error" title="This widget could not be built" body={result.error} />;
  }
  if (result.rows.length === 0) {
    return (
      <Placeholder
        tone="empty"
        title="No data in range"
        body="The query ran and matched no rows. Try widening the filters."
      />
    );
  }

  if (widget.type === "kpi") return <KpiCard widget={widget} result={result} />;
  if (widget.type === "table") return <DataTable result={result} />;

  return (
    <ChartBody
      widget={widget}
      result={result}
      palette={palette}
      spec={spec}
      onFilter={onFilter}
      frozen={frozen}
    />
  );
}

// ── KPI ────────────────────────────────────────────────────────────────────

function KpiCard({ widget, result }: { widget: Widget; result: WidgetResult }) {
  const key = result.measureKeys[0];
  const raw = key ? result.rows[0]?.[key] : null;
  const value = typeof raw === "number" ? raw : raw === null ? null : Number(raw);

  return (
    <div className="flex h-full flex-col justify-center">
      <p className="text-3xl font-semibold tabular-nums text-text">
        {value === null || Number.isNaN(value)
          ? "-"
          : formatKpi(value, widget.options.format ?? "number")}
      </p>
      {widget.subtitle ? (
        <p className="mt-1 text-xs text-text-muted">{widget.subtitle}</p>
      ) : null}
    </div>
  );
}

/**
 * `Intl`, not a hand-rolled formatter.
 *
 * The tenant's locale decides the grouping - 1,20,000 in en-IN and 120,000 in
 * en-GB are the same number written the way its reader expects, and the prompt
 * (3.7) asks for locale-aware numbers. `undefined` as the locale means "the
 * browser's", which is the right default until the platform stores a per-org
 * locale to pass in here.
 */
function formatKpi(value: number, format: NonNullable<Widget["options"]["format"]>): string {
  if (format === "percent") {
    return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(
      value,
    );
  }
  if (format === "duration") {
    const minutes = Math.round(value / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  if (format === "currency") {
    // INR is the platform's operating currency (invoices default to it). A
    // per-org currency belongs on `organizations` and would be threaded
    // through here; hardcoding it is the honest v1 rather than showing a
    // rupee figure with a dollar sign.
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

// ── table ──────────────────────────────────────────────────────────────────

function DataTable({ result }: { result: WidgetResult }) {
  const keys = [...result.dimensionKeys, ...result.measureKeys];
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr>
            {keys.map((key) => (
              <th
                key={key}
                className="border-b border-border px-2 py-1.5 font-medium text-text-muted"
              >
                {key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {result.rows.map((row, i) => (
            <tr key={i}>
              {keys.map((key) => (
                <td
                  key={key}
                  className={`px-2 py-1.5 text-text ${
                    result.measureKeys.includes(key) ? "text-right tabular-nums" : ""
                  }`}
                >
                  {row[key] === null || row[key] === undefined ? "-" : String(row[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── charts ─────────────────────────────────────────────────────────────────

function ChartBody({
  widget,
  result,
  palette,
  spec,
  onFilter,
  frozen,
}: {
  widget: Widget;
  result: WidgetResult;
  palette: Palette;
  spec: (typeof DESIGN_PRESETS)[DesignPreset]["chart"];
  onFilter?: (column: string, value: string) => void;
  frozen?: boolean;
}) {
  const dimension = result.dimensionKeys[0];
  const measures = result.measureKeys;
  const chart = widget.chart ?? "bar";

  const summary = useMemo(
    () => describeChart(widget.title ?? "Chart", result.rows, dimension, measures),
    [widget.title, result.rows, dimension, measures],
  );

  const grid = spec.gridOpacity > 0 && widget.options.showGrid !== false;
  const legend = widget.options.showLegend !== false && measures.length > 1;
  const animate = !frozen;

  const handleClick = (payload: { activeLabel?: string | number }) => {
    const key = widget.options.filterKey;
    if (!key || !onFilter || frozen) return;
    if (payload?.activeLabel === undefined || payload.activeLabel === null) return;
    onFilter(key, String(payload.activeLabel));
  };

  const annotations = (widget.options.annotations ?? []).map((a, i) => (
    <ReferenceLine
      key={i}
      y={a.value}
      stroke={a.color ?? "var(--color-danger)"}
      strokeDasharray="4 4"
      label={{ value: a.label ?? String(a.value), position: "right", fontSize: 10 }}
    />
  ));

  const cartesianAxes = (
    <>
      {grid ? (
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--color-border)"
          opacity={spec.gridOpacity}
          vertical={false}
        />
      ) : null}
      <XAxis
        dataKey={dimension}
        tick={AXIS_TICK}
        axisLine={spec.axisLine ? { stroke: "var(--color-border-strong)" } : false}
        tickLine={false}
        // Long category labels are the commonest reason a bar chart's bottom
        // edge turns to mush. Truncating with an ellipsis keeps the axis
        // readable; the full value is still in the tooltip and the fallback
        // table below.
        tickFormatter={(v: unknown) => truncate(String(v), 14)}
        interval="preserveStartEnd"
      />
      <YAxis
        tick={AXIS_TICK}
        axisLine={spec.axisLine ? { stroke: "var(--color-border-strong)" } : false}
        tickLine={false}
        width={52}
        tickFormatter={(v: number) => compact(v)}
      />
      <Tooltip
        contentStyle={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          fontSize: 12,
        }}
      />
      {legend ? <Legend wrapperStyle={{ fontSize: 11 }} /> : null}
      {annotations}
    </>
  );

  const body = () => {
    switch (chart) {
      case "line":
        return (
          <LineChart data={result.rows} onClick={handleClick}>
            {cartesianAxes}
            {measures.map((m, i) => (
              <Line
                key={m}
                type="monotone"
                dataKey={m}
                stroke={seriesColor(palette, i)}
                strokeWidth={spec.strokeWidth}
                dot={spec.dot ? { r: 3 } : false}
                isAnimationActive={animate}
              />
            ))}
          </LineChart>
        );

      case "area":
        return (
          <AreaChart data={result.rows} onClick={handleClick}>
            {cartesianAxes}
            {measures.map((m, i) => (
              <Area
                key={m}
                type="monotone"
                dataKey={m}
                stroke={seriesColor(palette, i)}
                fill={seriesColor(palette, i)}
                fillOpacity={spec.fillOpacity}
                strokeWidth={spec.strokeWidth}
                stackId={widget.options.stacked ? "1" : undefined}
                isAnimationActive={animate}
              />
            ))}
          </AreaChart>
        );

      case "scatter":
      case "bubble":
        return (
          <ScatterChart>
            {cartesianAxes}
            {chart === "bubble" && measures[1] ? (
              <ZAxis dataKey={measures[1]} range={[40, 400]} />
            ) : null}
            <Scatter
              data={result.rows}
              fill={seriesColor(palette, 0)}
              isAnimationActive={animate}
            />
          </ScatterChart>
        );

      case "radar":
        return (
          <RadarChart data={normalizeForRadar(result.rows, measures)}>
            <PolarGrid stroke="var(--color-border)" opacity={spec.gridOpacity} />
            <PolarAngleAxis dataKey={dimension} tick={AXIS_TICK} />
            <PolarRadiusAxis tick={AXIS_TICK} domain={[0, 100]} />
            <Tooltip contentStyle={{ fontSize: 12 }} />
            {legend ? <Legend wrapperStyle={{ fontSize: 11 }} /> : null}
            {measures.map((m, i) => (
              <Radar
                key={m}
                dataKey={m}
                stroke={seriesColor(palette, i)}
                fill={seriesColor(palette, i)}
                fillOpacity={spec.fillOpacity}
                isAnimationActive={animate}
              />
            ))}
          </RadarChart>
        );

      case "pie":
      case "donut":
        return (
          <PieChart>
            <Tooltip contentStyle={{ fontSize: 12 }} />
            {widget.options.showLegend !== false ? (
              <Legend wrapperStyle={{ fontSize: 11 }} />
            ) : null}
            <Pie
              data={result.rows}
              dataKey={measures[0]}
              nameKey={dimension}
              innerRadius={chart === "donut" ? "55%" : 0}
              outerRadius="80%"
              paddingAngle={1}
              isAnimationActive={animate}
              onClick={(entry: { name?: string | number }) => {
                const key = widget.options.filterKey;
                if (key && onFilter && !frozen && entry?.name !== undefined) {
                  onFilter(key, String(entry.name));
                }
              }}
            >
              {result.rows.map((_, i) => (
                <Cell key={i} fill={seriesColor(palette, i)} />
              ))}
            </Pie>
          </PieChart>
        );

      default:
        return (
          <BarChart data={result.rows} onClick={handleClick}>
            {cartesianAxes}
            {measures.map((m, i) => (
              <Bar
                key={m}
                dataKey={m}
                fill={seriesColor(palette, i)}
                radius={[spec.cornerRadius, spec.cornerRadius, 0, 0]}
                stackId={widget.options.stacked ? "1" : undefined}
                isAnimationActive={animate}
              />
            ))}
          </BarChart>
        );
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          {body()}
        </ResponsiveContainer>
      </div>

      {result.truncated ? (
        <p className="mt-1 text-[11px] text-text-subtle">
          Showing the top values; the rest are grouped as &ldquo;Other&rdquo;.
        </p>
      ) : null}

      {/* The accessible fallback (AC 17). A real table, not an aria hack -
          a keyboard user who wants the numbers gets the numbers. Hidden by
          default so it does not compete with the chart visually, and always
          expanded in print. */}
      <details className="mt-1 print:open" open={frozen}>
        <summary className="cursor-pointer text-[11px] text-text-subtle hover:text-text-muted">
          View as table
        </summary>
        <div className="mt-1 max-h-40 overflow-auto">
          <DataTable result={result} />
        </div>
      </details>
      <span className="sr-only">{summary}</span>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * A radar's axes must share a scale or the shape means nothing.
 *
 * Recharts cannot give each series its own domain (design doc D5), so every
 * measure is rescaled to 0-100 against its own maximum. That makes the chart a
 * PROFILE comparison rather than a value chart - the widget's subtitle says so,
 * because a reader who thinks they are reading values off a normalised radar
 * is reading them wrong.
 */
function normalizeForRadar(rows: ResultRow[], measures: string[]): ResultRow[] {
  const maxima = new Map<string, number>();
  for (const measure of measures) {
    let max = 0;
    for (const row of rows) {
      const n = Number(row[measure]);
      if (Number.isFinite(n) && n > max) max = n;
    }
    maxima.set(measure, max);
  }
  return rows.map((row) => {
    const out: ResultRow = { ...row };
    for (const measure of measures) {
      const max = maxima.get(measure) ?? 0;
      const n = Number(row[measure]);
      out[measure] = max > 0 && Number.isFinite(n) ? Math.round((n / max) * 100) : 0;
    }
    return out;
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Axis ticks, short. 1.2M beats 1200000 on an axis 52px wide. */
function compact(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

function Placeholder({
  tone,
  title,
  body,
}: {
  tone: "hint" | "empty" | "error";
  title: string;
  body: string;
}) {
  const border =
    tone === "error"
      ? "border-danger/40 bg-danger-subtle"
      : tone === "empty"
        ? "border-border bg-bg-subtle"
        : "border-dashed border-border-strong bg-bg-subtle";
  const heading = tone === "error" ? "text-danger-text" : "text-text";

  return (
    <div
      className={`flex h-full min-h-24 flex-col items-center justify-center gap-1 rounded-md border px-3 py-4 text-center ${border}`}
    >
      <p className={`text-xs font-medium ${heading}`}>{title}</p>
      <p className="max-w-xs text-[11px] leading-snug text-text-muted">{body}</p>
    </div>
  );
}
