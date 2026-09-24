import { formatDateKey, formatHourBand, weekdayName, weekdayOfDateKey } from "@aura/shared";

/**
 * The dashboard's chart logic (Build docs/29), kept pure so every number a
 * chart draws or a sentence states is tested here rather than eyeballed in a
 * component. The panels in app/(owner)/owner/_dashboard/ only lay these out.
 */

// ── axes ─────────────────────────────────────────────────────────────────────

const NICE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10];

/** The smallest "nice" number at or above `max`; never 0, so an empty chart keeps a scale. */
export function niceTop(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return (NICE_STEPS.find((step) => step * power >= max) ?? 10) * power;
}

/**
 * A count axis: a clean top and a midpoint label only when it is a whole number.
 *
 * Finer steps than the Reports page's niceCeiling (1/2/5/10): with those a
 * maximum of 22 gets a 50 axis and the chart is half empty. 1/2/3/4/5/6/8/10
 * keeps the tallest mark above 70% of the plot for any maximum, and every step
 * is still a number people read at a glance.
 */
export function countAxis(max: number): { top: number; mid: number | null } {
  const top = niceTop(max);
  const mid = top / 2;
  return { top, mid: top >= 2 && Number.isInteger(mid) ? mid : null };
}

/**
 * A value as a percentage of the axis top. A non-zero value never draws
 * thinner than `floor` percent - a 1 beside a 90 must still be visible, while
 * a true zero draws nothing at all, so "none" and "a little" stay different.
 */
export function barPercent(value: number, top: number, floor = 2): number {
  if (!(value > 0) || !(top > 0)) return 0;
  return Math.min(100, Math.max(floor, (value / top) * 100));
}

/**
 * The trailing mean of the last `span` points, or null until a full span
 * exists - a "7-day average" over three days would be a different claim
 * wearing the same line.
 */
export function trailingMean(values: readonly number[], span = 7): Array<number | null> {
  let running = 0;
  return values.map((v, i) => {
    running += v;
    if (i >= span) running -= values[i - span]!;
    return i >= span - 1 ? running / span : null;
  });
}

// ── comparisons ──────────────────────────────────────────────────────────────

export type DeltaKind = "up" | "down" | "flat" | "from-zero";

export interface Delta {
  kind: DeltaKind;
  /** Whole percent (percentDelta) or whole points (pointsDelta). */
  amount: number;
}

/**
 * Change against the previous window, or null when both are zero (nothing to
 * compare). From zero is its own kind: "▲ ∞%" is not a number anyone can use,
 * and "none in the previous 30 days" is the true statement.
 */
export function percentDelta(current: number, previous: number): Delta | null {
  if (current === 0 && previous === 0) return null;
  if (previous === 0) return { kind: "from-zero", amount: 0 };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { kind: "flat", amount: 0 };
  return { kind: pct > 0 ? "up" : "down", amount: Math.abs(pct) };
}

/** Change in a rate, in whole percentage points. Null when either side has no base. */
export function pointsDelta(current: number | null, previous: number | null): Delta | null {
  if (current === null || previous === null) return null;
  const points = Math.round((current - previous) * 100);
  if (points === 0) return { kind: "flat", amount: 0 };
  return { kind: points > 0 ? "up" : "down", amount: Math.abs(points) };
}

/** A tile's window after a verb: "in 30d", "in 1 – 30 Jun" - or just "today". */
export function inSpan(span: string): string {
  return span === "today" ? span : `in ${span}`;
}

/** "▲ 18% vs previous 30 days" - glyph and words, never a colour (docs/29 P2). */
export function deltaText(delta: Delta, days: number, unit: "%" | " pts" = "%"): string {
  const period = days === 1 ? "day before" : `previous ${days} days`;
  switch (delta.kind) {
    case "from-zero":
      return `none in the ${period}`;
    case "flat":
      return `no change vs ${period}`;
    default:
      return `${delta.kind === "up" ? "▲" : "▼"} ${delta.amount}${unit} vs ${period}`;
  }
}

/** A share as a fraction, or null with nothing to divide by. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * A rate as text that admits its base (docs/29 P8): "64%" normally, "3 of 4"
 * when the base is too small for a percentage to mean anything, "-" with none.
 */
export function rateText(part: number, whole: number, minBase = 5): string {
  if (whole <= 0) return "-";
  if (whole < minBase) return `${part} of ${whole}`;
  return `${Math.round((part / whole) * 100)}%`;
}

/** "24 Aug – 22 Sep" for the window the API echoed. */
export function windowLabel(from: string | undefined, to: string | undefined): string | null {
  if (!from || !to) return null;
  return from === to ? formatDateKey(to, { year: false }) : `${formatDateKey(from, { year: false })} – ${formatDateKey(to, { year: false })}`;
}

// ── the trend ────────────────────────────────────────────────────────────────

export interface TrendDay {
  day: string;
  calls: number;
  missed: number;
  leads: number;
}

/** "Tue 16 Sep" for a calendar date - no zone, it is already the org's day. */
export function dayName(day: string): string {
  return `${weekdayOfDateKey(day)} ${formatDateKey(day, { year: false })}`;
}

/**
 * The trend's one-line insight (docs/29 P7): the busiest day and the day with
 * the most missed calls. Ties go to the most RECENT day - the one a reader can
 * still do something about. Null parts are left out, and a window with no
 * calls at all says nothing.
 */
export function trendInsight(days: readonly TrendDay[]): string | null {
  let busiest: TrendDay | null = null;
  let mostMissed: TrendDay | null = null;
  for (const d of days) {
    if (d.calls > 0 && (!busiest || d.calls >= busiest.calls)) busiest = d;
    if (d.missed > 0 && (!mostMissed || d.missed >= mostMissed.missed)) mostMissed = d;
  }
  const parts: string[] = [];
  if (busiest) parts.push(`Busiest: ${dayName(busiest.day)}, ${busiest.calls} ${busiest.calls === 1 ? "call" : "calls"}`);
  if (mostMissed) parts.push(`Most missed: ${dayName(mostMissed.day)}, ${mostMissed.missed}`);
  return parts.length ? parts.join(" · ") : null;
}

// ── the missed-call heatmap ──────────────────────────────────────────────────

export interface HeatCellInput {
  dow: number;
  hour: number;
  inbound: number;
  missed: number;
}

export interface HeatGrid {
  /** The columns: every hour that had an inbound call, widened to always include 09-18. */
  hours: number[];
  rows: Array<{
    dow: number;
    label: string;
    cells: Array<{ hour: number; inbound: number; missed: number }>;
    inbound: number;
    missed: number;
  }>;
  maxMissed: number;
  totalMissed: number;
  totalInbound: number;
}

/**
 * Lay the API's sparse cells out as a Monday-first, 7-row grid. The hour range
 * is widened to 09:00-18:59 whatever the data says, so the grid does not
 * change shape from one week to the next and a quiet morning is visibly quiet
 * rather than missing.
 */
export function heatGrid(cells: readonly HeatCellInput[]): HeatGrid {
  const byKey = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));
  const seen = cells.filter((c) => c.inbound > 0).map((c) => c.hour);
  const first = Math.min(9, ...seen);
  const last = Math.max(18, ...seen);
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  let maxMissed = 0;
  let totalMissed = 0;
  let totalInbound = 0;
  const rows = [1, 2, 3, 4, 5, 6, 7].map((dow) => {
    const rowCells = hours.map((hour) => {
      const c = byKey.get(`${dow}:${hour}`);
      return { hour, inbound: c?.inbound ?? 0, missed: c?.missed ?? 0 };
    });
    const inbound = rowCells.reduce((s, c) => s + c.inbound, 0);
    const missed = rowCells.reduce((s, c) => s + c.missed, 0);
    for (const c of rowCells) maxMissed = Math.max(maxMissed, c.missed);
    totalMissed += missed;
    totalInbound += inbound;
    return { dow, label: weekdayName(dow), cells: rowCells, inbound, missed };
  });
  return { hours, rows, maxMissed, totalMissed, totalInbound };
}

/**
 * Upper edges of the missed-call classes: at most FOUR, because four is how
 * many steps of the missed hue pass the ordinal checks (docs/29 §4.3). Edges
 * split the window's own maximum into quarters, so the ramp is always fully
 * used; a small maximum gets one class per count instead of empty classes.
 */
export function missedEdges(maxMissed: number): number[] {
  if (maxMissed <= 0) return [];
  const edges: number[] = [];
  for (let k = 1; k <= 4; k++) {
    const edge = Math.max(k, Math.ceil((maxMissed * k) / 4));
    const capped = Math.min(edge, maxMissed);
    if (!edges.length || capped > edges[edges.length - 1]!) edges.push(capped);
  }
  return edges;
}

/** 0 for no missed calls, else 1..edges.length. */
export function missedClass(missed: number, edges: readonly number[]): number {
  if (missed <= 0) return 0;
  const i = edges.findIndex((edge) => missed <= edge);
  return i === -1 ? edges.length : i + 1;
}

/** "1", "2–3", "4–6" ... one per class, for the scale legend. */
export function edgeLabels(edges: readonly number[]): string[] {
  return edges.map((edge, i) => {
    const low = i === 0 ? 1 : edges[i - 1]! + 1;
    return low === edge ? String(edge) : `${low}–${edge}`;
  });
}

/**
 * The heatmap's insight: its worst cell, and - only when there IS a pattern - the
 * two-hour band that holds at least a third of all missed calls. Below six
 * missed calls a "pattern" is noise, so it stays quiet.
 */
export function heatInsight(grid: HeatGrid): string | null {
  let worst: { dow: number; hour: number; missed: number; inbound: number } | null = null;
  for (const row of grid.rows) {
    for (const c of row.cells) {
      if (c.missed > 0 && (!worst || c.missed > worst.missed)) worst = { dow: row.dow, ...c };
    }
  }
  if (!worst) return null;
  const parts = [`Most missed: ${weekdayName(worst.dow)} ${formatHourBand(worst.hour)} (${worst.missed} of ${worst.inbound})`];
  if (grid.totalMissed >= 6) {
    const perHour = grid.hours.map((h, i) => grid.rows.reduce((s, r) => s + r.cells[i]!.missed, 0));
    let best = { start: -1, missed: 0 };
    for (let i = 0; i + 1 < perHour.length; i++) {
      const band = perHour[i]! + perHour[i + 1]!;
      if (band > best.missed) best = { start: i, missed: band };
    }
    const pct = Math.round((best.missed / grid.totalMissed) * 100);
    if (best.start >= 0 && best.missed * 3 >= grid.totalMissed) {
      const from = grid.hours[best.start]!;
      parts.push(`${pct}% of missed calls fall between ${String(from).padStart(2, "0")}:00 and ${String((from + 2) % 24).padStart(2, "0")}:00`);
    }
  }
  return parts.join(". ") + ".";
}

// ── pipeline health ──────────────────────────────────────────────────────────

export interface StageInput {
  key: string;
  label: string;
  terminal?: "won" | "lost";
  count: number;
  value: number;
}

export interface StageHealthRow {
  key: string;
  label: string;
  /** Open records in the stage - the bar's length, and the sum of `buckets`. */
  open: number;
  value: number;
  /** Open records per age bucket, in AGING_BUCKETS order. */
  buckets: number[];
  /** Records in the oldest bucket (30+ days in this stage). */
  stuck: number;
}

/**
 * The open stages, in pipeline order, each with its time-in-stage split.
 * Terminal stages are left out: a bar for "Lost" all-time only ever grows.
 */
export function stageHealth(
  funnel: readonly StageInput[],
  aging: ReadonlyArray<{ stage: string }>,
  bucketKeys: readonly string[],
): { rows: StageHealthRow[]; max: number } {
  const byStage = new Map(aging.map((a) => [a.stage, a]));
  const rows = funnel
    .filter((s) => !s.terminal)
    .map((s) => {
      const a = byStage.get(s.key);
      const counts = a as Record<string, unknown> | undefined;
      const buckets = bucketKeys.map((k) => Number(counts?.[k] ?? 0));
      return {
        key: s.key,
        label: s.label,
        open: buckets.reduce((x, y) => x + y, 0),
        value: s.value,
        buckets,
        stuck: buckets[buckets.length - 1] ?? 0,
      };
    });
  return { rows, max: Math.max(0, ...rows.map((r) => r.open)) };
}

// ── response speed ───────────────────────────────────────────────────────────

export type SlaFit = "within" | "partial" | "beyond" | "never";

export interface ResponseBucketInput {
  key: string;
  label: string;
  min_minutes: number | null;
  max_minutes: number | null;
  never: boolean;
  count: number;
}

/**
 * Where each response bucket sits against the org's SLA: wholly inside it,
 * straddling it (the SLA falls inside the bucket's range), wholly beyond, or
 * the separate "no response yet" row. The headline percentage is computed
 * exactly on the server; this only decides how each bar is drawn.
 */
export function slaFit(bucket: ResponseBucketInput, slaMinutes: number): SlaFit {
  if (bucket.never) return "never";
  const low = bucket.min_minutes ?? 0;
  if (bucket.max_minutes !== null && bucket.max_minutes <= slaMinutes) return "within";
  if (low < slaMinutes) return "partial";
  return "beyond";
}

/** "60-minute" / "4-hour" / "1-day" - an SLA said the way a manager says it. */
export function slaPhrase(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0 && minutes >= 120) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

// ── source effectiveness ─────────────────────────────────────────────────────

export interface SourceInput {
  channel: string;
  leads: number;
  won: number;
  won_value: number;
}

/**
 * Channels by volume with their conversion (won so far ÷ arrived in the
 * window), and the all-channel rate the dot plot marks as its reference.
 * `small` flags a base too thin for a percentage (docs/29 P8).
 */
export function sourceRows(rows: readonly SourceInput[], minBase = 5) {
  const leads = rows.reduce((s, r) => s + r.leads, 0);
  const won = rows.reduce((s, r) => s + r.won, 0);
  return {
    overall: share(won, leads),
    maxLeads: Math.max(0, ...rows.map((r) => r.leads)),
    rows: [...rows]
      .sort((a, b) => b.leads - a.leads || b.won - a.won)
      .map((r) => ({ ...r, rate: share(r.won, r.leads), small: r.leads < minBase })),
  };
}
