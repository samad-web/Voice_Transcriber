import { viewHref } from "./list-views";

/**
 * The Reports dashboard's pure parts (CRM dashboard, Phase 6): the date range,
 * how its numbers are worded, and - the part that matters - the link each
 * number opens.
 *
 * ── EVERY NUMBER IS A FILTER ────────────────────────────────────────────────
 *
 * A metric card or a chart bar opens the list of the records it counted. That
 * is only honest if the list's filter is the SAME predicate the metric used, so
 * every link here is built from what the report response ECHOED (its `from`,
 * `to` and `pipeline.id`), never from a window the console computed itself -
 * and the list endpoints' matching filters copy the report's SQL (see the
 * `createdFrom` comments in deals.controller.ts and leads.controller.ts).
 */

export const REPORT_RANGES = [7, 30, 90] as const;
export type ReportRange = (typeof REPORT_RANGES)[number];
export const DEFAULT_REPORT_RANGE: ReportRange = 30;

export function parseReportRange(value: string | string[] | undefined): ReportRange {
  const raw = Number(Array.isArray(value) ? value[0] : value);
  return (REPORT_RANGES as readonly number[]).includes(raw) ? (raw as ReportRange) : DEFAULT_REPORT_RANGE;
}

/** `/owner/reports`, keeping the range unless it is the default. */
export function reportsHref(range: ReportRange): string {
  return range === DEFAULT_REPORT_RANGE ? "/owner/reports" : `/owner/reports?range=${range}`;
}

/**
 * A FRACTION as a percentage: 0.4167 -> "42%". Null (nothing to divide by) -> "-".
 *
 * The reports do not agree on scale: `conversion.winRate` is a fraction (0-1),
 * while the SLA reports' `*Pct` fields are already percentages (0-100, sla.ts
 * `pctOf`). Feeding one to the other's formatter printed "5000%" - use
 * formatPercentPoints for the SLA fields.
 */
export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${Math.round(value * 100)}%`;
}

/** A value ALREADY in percent (0-100), as the SLA reports return it: 50 -> "50%". */
export function formatPercentPoints(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${Math.round(value)}%`;
}

/**
 * A response time a floor manager reads at a glance: minutes under an hour,
 * hours under two days, days after that. Null when nothing was answered.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "-";
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15 Sep" from `YYYY-MM-DD`. A fixed table, not Intl: ICU builds disagree ("Sep"/"Sept"), and server and browser must render the same text. */
export function formatDay(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1] ?? ""}`.trim();
}

/** "17 Aug – 15 Sep" for a window; one date when the two agree. */
export function formatDateRange(from: string, to: string): string {
  return from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;
}

// ── drill-down links ─────────────────────────────────────────────────────────

/** Deals created in the window that have closed - the conversion rate's denominator. */
export function closedDealsHref(pipelineId: string | null, from: string, to: string): string {
  return viewHref("deals", {
    view: "table",
    status: "closed",
    createdFrom: from,
    createdTo: to,
    ...(pipelineId ? { pipelineId } : {}),
  });
}

/** Open deals, largest first - the pipeline value card. `stage` narrows to one bar of the chart. */
export function openDealsHref(pipelineId: string | null, stage?: string): string {
  return viewHref("deals", {
    view: "table",
    status: "open",
    sort: "amount",
    ...(stage ? { stage } : {}),
    ...(pipelineId ? { pipelineId } : {}),
  });
}

/** Open deals past the pipeline's idle threshold. */
export function staleDealsHref(pipelineId: string | null): string {
  return viewHref("deals", { view: "table", stale: "1", ...(pipelineId ? { pipelineId } : {}) });
}

/** Leads that arrived in the window - optionally only the ones nobody has answered. */
export function leadsArrivedHref(from: string, to: string, onlyUnanswered = false): string {
  return viewHref("leads", {
    createdFrom: from,
    createdTo: to,
    ...(onlyUnanswered ? { responded: "no" } : {}),
  });
}

export function openLeadsHref(): string {
  return viewHref("leads", { status: "open" });
}

export function overdueTasksHref(): string {
  return viewHref("tasks", { due: "overdue" });
}

// ── chart data ───────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` + n days, calendar arithmetic only. */
function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One entry per calendar day from `from` to `to`, zero where the report had no
 * row. The report omits empty days; a column chart that skipped them would draw
 * a quiet week as if it were not there.
 */
export function fillDays<T extends { date: string }>(
  rows: readonly T[],
  from: string,
  to: string,
  empty: (date: string) => T,
): T[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: T[] = [];
  // Bounded: a malformed window cannot spin forever.
  for (let d = from, i = 0; d <= to && i < 400; d = shift(d, 1), i++) {
    out.push(byDate.get(d) ?? empty(d));
  }
  return out;
}

/**
 * A clean top for a count axis: 1, 2, 5 or 10 × a power of ten, at or above
 * the largest value. Never 0, so an empty chart still has a scale.
 */
export function niceCeiling(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}
