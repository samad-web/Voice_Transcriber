import { formatReportRange, isCalendarDate, shiftDateKey } from "@aura/shared";

/**
 * THE DATE RANGE EVERY REPORT SCREEN SHARES.
 *
 * Call insights settled how a person picks a period: three "Last N days" pills
 * for the answer anyone asks for, then a From/To pair for the one they don't,
 * then a line that prints the dates actually shown. Every screen with a period
 * now reads it the same way, from the same URL shape, so a link copied from one
 * report means the same thing pasted into another:
 *
 *   (nothing)                        the page's default preset
 *   ?days=N                          the last N days, ending today
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   exactly those days
 *
 * `days` stays a COUNT in the URL, so "last 7 days" still means the last seven
 * days when the link is opened next month. "Today" is the ORG's today: an API
 * that resolves the count in the org's calendar is sent the count, and one that
 * only takes dates is sent `resolveDateWindow(window, todayIn(zone))` - never
 * this server's date, which is UTC and the wrong day for five and a half hours
 * of every Indian evening. Either way the summary line prints the API's echo.
 *
 * Parsing is forgiving because these come from an address bar and a shared
 * link: a lone date is that one day, a reversed pair is put the right way
 * round. What cannot be read at all falls back to the default and says so
 * (`invalid`), rather than rendering a page-sized 400.
 */

export type DateWindow = { kind: "relative"; days: number } | { kind: "fixed"; from: string; to: string };

/** 1 is "Today" - the org's today, the same count the API resolves in its zone. */
export const RANGE_PRESETS = [1, 7, 30, 90] as const;
export const DEFAULT_RANGE_DAYS = 30;
/** A year and a day, so "this time last year" is always expressible. */
export const MAX_RANGE_DAYS = 366;

type SearchParams = Record<string, string | string[] | undefined>;

export interface ParsedDateWindow {
  window: DateWindow;
  /** The URL asked for something unreadable; `window` is the default instead. */
  invalid: boolean;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Days in an inclusive `YYYY-MM-DD` range: the same day twice is 1. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function parseDateWindow(
  sp: SearchParams,
  opts: { defaultDays?: number; maxDays?: number; legacyDaysKey?: string } = {},
): ParsedDateWindow {
  const defaultDays = opts.defaultDays ?? DEFAULT_RANGE_DAYS;
  const maxDays = opts.maxDays ?? MAX_RANGE_DAYS;
  const fallback: ParsedDateWindow = { window: { kind: "relative", days: defaultDays }, invalid: true };

  const from = first(sp.from);
  const to = first(sp.to);
  if (from || to) {
    const a = (from || to) as string;
    const b = (to || from) as string;
    if (!isCalendarDate(a) || !isCalendarDate(b)) return fallback;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (spanDays(lo, hi) > maxDays) return fallback;
    return { window: { kind: "fixed", from: lo, to: hi }, invalid: false };
  }

  const raw = first(sp.days) ?? (opts.legacyDaysKey ? first(sp[opts.legacyDaysKey]) : undefined);
  if (raw === undefined || raw === "") return { window: { kind: "relative", days: defaultDays }, invalid: false };
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > maxDays) return fallback;
  return { window: { kind: "relative", days }, invalid: false };
}

/**
 * The window as dates, for an API that takes only dates. `today` must be the
 * ORG's today - `todayIn(owner.membership.reportingTimezone)` - never this
 * server's, which is UTC and a day ahead of an Indian floor until 5:30 AM.
 */
export function resolveDateWindow(window: DateWindow, today: string): { from: string; to: string } {
  if (window.kind === "fixed") return { from: window.from, to: window.to };
  return { from: shiftDateKey(today, -(window.days - 1)), to: today };
}

/** The window as query parameters - for the API and for links alike. */
export function dateWindowParams(window: DateWindow): Record<string, string> {
  return window.kind === "fixed" ? { from: window.from, to: window.to } : { days: String(window.days) };
}

/** `days=30` or `from=…&to=…`, ready to put after a `?` or an `&`. */
export function dateWindowQuery(window: DateWindow): string {
  return new URLSearchParams(dateWindowParams(window)).toString();
}

export function isPresetWindow(window: DateWindow, days: number): boolean {
  return window.kind === "relative" && window.days === days;
}

type Keep = Record<string, string | null | undefined>;

/**
 * `path` with the window, then whatever else the page keeps (a sort, a
 * filter). The default window is left out so the plain path stays the
 * canonical address of the default view.
 */
export function dateWindowHref(
  path: string,
  window: DateWindow,
  opts: { defaultDays?: number; keep?: Keep } = {},
): string {
  const params = new URLSearchParams(
    isPresetWindow(window, opts.defaultDays ?? DEFAULT_RANGE_DAYS) ? {} : dateWindowParams(window),
  );
  for (const [key, value] of Object.entries(opts.keep ?? {})) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** One pill. The call log's named periods ("Today", "This month") are pills too. */
export interface RangePreset {
  key: string;
  label: string;
  href: string;
  active: boolean;
}

/** A preset as its pill reads: "Today", then "Last N days". */
export function presetLabel(days: number): string {
  return days === 1 ? "Today" : `Last ${days} days`;
}

/** The pills: one per preset, lit when it is the window showing. */
export function rangePresets(
  path: string,
  window: DateWindow,
  opts: { defaultDays?: number; keep?: Keep; presets?: readonly number[] } = {},
): RangePreset[] {
  return (opts.presets ?? RANGE_PRESETS).map((days) => ({
    key: String(days),
    label: presetLabel(days),
    href: dateWindowHref(path, { kind: "relative", days }, opts),
    active: isPresetWindow(window, days),
  }));
}

/**
 * Pills for a page whose periods are NAMED rather than counted - the call
 * log's "Today", "This month" and the rest, which travel as `?period=` and the
 * API resolves in the org's zone. "Any date" comes first and is the page's
 * default: no date filter at all. Every other parameter in `keep` rides along;
 * the caller leaves the page offset out, because a new range is a new list.
 */
export function periodPresets(
  path: string,
  periods: readonly { key: string; label: string }[],
  selected: string | null,
  keep: Keep = {},
): RangePreset[] {
  const href = (dates: Record<string, string>) => {
    const params = new URLSearchParams(dates);
    for (const [key, value] of Object.entries(keep)) if (value) params.set(key, value);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  };
  return [
    { key: "any", label: "Any date", href: href({}), active: selected === null },
    ...periods.map((p) => ({ key: p.key, label: p.label, href: href({ period: p.key }), active: selected === p.key })),
  ];
}

/**
 * The window in words, for a subtitle or a comparison: "last 30 days" for a
 * preset, the dates for a custom range. `from`/`to` are the API's echo, used
 * for a custom range so the words and the numbers name the same days.
 */
export function windowPhrase(window: DateWindow, echo?: { from?: string; to?: string }): string {
  if (window.kind === "relative") return window.days === 1 ? "today" : `last ${window.days} days`;
  return formatReportRange(echo?.from ?? window.from, echo?.to ?? window.to);
}

/** `windowPhrase` opening a line: "Last 30 days", "1 – 30 Sep 2026". */
export function windowTitle(window: DateWindow, echo?: { from?: string; to?: string }): string {
  const phrase = windowPhrase(window, echo);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
