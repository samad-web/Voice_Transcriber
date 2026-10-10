import {
  DEFAULT_FY_START_MONTH,
  fiscalPeriod,
  formatReportRange,
  isCalendarDate,
  previousPeriod,
  samePeriodLastYear,
  shiftDateKey,
} from "@aura/shared";

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

/**
 * A CALENDAR period - "this week", "this month" - as opposed to a rolling count.
 *
 * ── WHY THIS IS A THIRD KIND AND NOT A FIXED RANGE ──────────────────────────
 *
 * The obvious implementation resolves "This month" to `?from=2026-09-01&to=
 * 2026-09-30` when the pill is rendered, and it is wrong for the reason the
 * header above already gives for `days`: a link copied today would still mean
 * September when somebody opened it in November. "This month" has to stay
 * SYMBOLIC in the URL and be resolved against the org's own today on each read,
 * exactly as `days` is.
 *
 * ── AND WHY IT IS NOT JUST ANOTHER `days` COUNT ─────────────────────────────
 *
 * Because they answer different questions and people ask both. "Last 30 days" is
 * a rolling window - it is the right shape for "how are we doing lately", and it
 * never changes length. "This month" is a period somebody is accountable FOR: it
 * is what a target is set against, what a review covers, and it gets longer every
 * day until it resets. On the 2nd of the month the two differ by twenty-nine days
 * and only one of them answers "are we going to make the number".
 */
/**
 * ── THE SET GREW FOR §2'S REPORTING CYCLES ──────────────────────────────────
 *
 * Build docs/indian-business-finance-documents-cycles-import §2 asks for "a
 * period selector: day, week, month, quarter, half-year, financial year,
 * custom range". `day` and `custom range` were already here - `?days=1` and
 * `?from=&to=` - so what was missing is the three accounting periods.
 *
 * They are `calendar` units rather than `relative` counts for the reason this
 * type exists at all: "this quarter" has to stay SYMBOLIC in the URL and be
 * resolved against the org's own today on each read, or a link copied in
 * August means July-September forever.
 *
 * The three new ones differ from `week`/`month` in one way that matters: they
 * depend on the org's `fy_start_month`, which the browser does not know until
 * the page tells it. So `calendarStart` takes it as an argument and
 * `resolveDateWindow` threads it through - which is why that function grew a
 * second parameter rather than reading a constant.
 */
export type CalendarUnit = "week" | "month" | "quarter" | "half" | "year";

export type DateWindow =
  | { kind: "relative"; days: number }
  | { kind: "calendar"; unit: CalendarUnit }
  | { kind: "fixed"; from: string; to: string };

/** 1 is "Today" - the org's today, the same count the API resolves in its zone. */
export const RANGE_PRESETS = [1, 7, 30, 90] as const;

/**
 * The calendar pills, in the order they are offered.
 *
 * Week before month, and both after "Today", so the row reads shortest-first like
 * the rolling presets do and the eye does not have to sort it.
 */
export const CALENDAR_PRESETS = ["week", "month"] as const;

/**
 * The accounting periods, offered separately.
 *
 * NOT merged into `CALENDAR_PRESETS`, deliberately. That row is already five
 * pills wide on the three analytics screens, and a tenant looking at "how are
 * we doing lately" does not want "This financial year" beside "Last 7 days".
 * A page that is about a PERIOD somebody is accountable for - the compliance
 * calendar, the close checklist, a P&L - passes `accounting: true` and gets
 * these instead.
 */
export const ACCOUNTING_PRESETS = ["month", "quarter", "half", "year"] as const;

/**
 * Every unit `?period=` may carry.
 *
 * `parseDateWindow` validates against THIS, not against either pill list.
 * Validating against `CALENDAR_PRESETS` was the bug the first version of the
 * accounting periods shipped with: the pills rendered `?period=quarter`
 * correctly, the URL was then rejected as unreadable, and the page silently
 * fell back to the last 30 days - a link that looked like it worked and showed
 * the wrong figures.
 */
export const CALENDAR_UNITS = ["week", "month", "quarter", "half", "year"] as const;

export const CALENDAR_LABEL: Record<CalendarUnit, string> = {
  week: "This week",
  month: "This month",
  quarter: "This quarter",
  half: "This half-year",
  // "Financial year" and not "This year": for eleven months of an Indian
  // financial year the two are different, and the whole point of making the
  // start month configurable is that the label has to say which one it means.
  year: "Financial year",
};
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

  // Before `days`, and both before the default: a URL carrying both is a caller
  // contradicting itself, and the named period is the more specific request.
  const period = first(sp.period);
  if (period !== undefined && period !== "") {
    if (!(CALENDAR_UNITS as readonly string[]).includes(period)) return fallback;
    return { window: { kind: "calendar", unit: period as CalendarUnit }, invalid: false };
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
export function resolveDateWindow(
  window: DateWindow,
  today: string,
  /**
   * The org's `fy_start_month` (migration 0126, default 4).
   *
   * Only `quarter`, `half` and `year` read it. Passing it is how a page that
   * offers the accounting periods stays correct for a tenant on a January
   * financial year - and the default means every existing caller keeps the
   * behaviour it had.
   */
  fyStartMonth: number = DEFAULT_FY_START_MONTH,
): { from: string; to: string } {
  if (window.kind === "fixed") return { from: window.from, to: window.to };
  if (window.kind === "calendar") {
    return { from: calendarStart(window.unit, today, fyStartMonth), to: today };
  }
  return { from: shiftDateKey(today, -(window.days - 1)), to: today };
}

/**
 * The first day of the calendar period `today` falls in.
 *
 * ── TWO DECISIONS WORTH STATING ─────────────────────────────────────────────
 *
 * The week starts MONDAY. `weekdayName` in @aura/shared is Monday-first (ISO)
 * and the missed-call heatmap's rows already are, so a Sunday-first week here
 * would be the only Sunday-first thing in the console.
 *
 * The period ends TODAY, not on its last calendar day. A range running to the
 * 30th on the 3rd of the month would report twenty-seven days of zeroes and
 * every rate would be computed over a denominator that has not happened - which
 * is how "this month's conversion rate" reads as a collapse on the 2nd. Every
 * figure on these pages is therefore period-to-date, and the summary line prints
 * the two real dates so nobody has to infer it.
 */
function calendarStart(unit: CalendarUnit, today: string, fyStartMonth: number): string {
  if (unit === "month") return `${today.slice(0, 7)}-01`;
  // The three accounting periods are the same arithmetic the API and the
  // worker use - `fiscalPeriod` in @aura/shared - rather than a second
  // implementation here. A console that disagreed with the compliance
  // calendar about when the quarter started would be the worst possible place
  // for that bug to live, because both numbers look plausible.
  if (unit === "quarter" || unit === "half" || unit === "year") {
    return fiscalPeriod(unit, today, fyStartMonth).from;
  }
  // getUTCDay is 0 for Sunday; shift it to an ISO 1-7 so Monday is the origin.
  const dow = new Date(`${today.slice(0, 10)}T00:00:00Z`).getUTCDay();
  const iso = dow === 0 ? 7 : dow;
  return shiftDateKey(today, -(iso - 1));
}

/** The window as query parameters - for the API and for links alike. */
export function dateWindowParams(window: DateWindow): Record<string, string> {
  if (window.kind === "fixed") return { from: window.from, to: window.to };
  if (window.kind === "calendar") return { period: window.unit };
  return { days: String(window.days) };
}

/** `days=30` or `from=…&to=…`, ready to put after a `?` or an `&`. */
export function dateWindowQuery(window: DateWindow): string {
  return new URLSearchParams(dateWindowParams(window)).toString();
}

export function isPresetWindow(window: DateWindow, days: number): boolean {
  return window.kind === "relative" && window.days === days;
}

export function isCalendarWindow(window: DateWindow, unit: CalendarUnit): boolean {
  return window.kind === "calendar" && window.unit === unit;
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
  opts: {
    defaultDays?: number;
    keep?: Keep;
    presets?: readonly number[];
    /**
     * Also offer "This week" and "This month".
     *
     * Opt-in rather than on everywhere, because a calendar period is only
     * meaningful where the page's figures are period-to-date. It is right on the
     * three analytics screens and wrong on, say, a call log whose default is "any
     * date" - there, a pill that silently means "since Monday" is a filter
     * somebody did not ask for. Pass `calendar: true` on a page that wants both
     * shapes.
     */
    calendar?: boolean;
  } = {},
): RangePreset[] {
  const rolling = (opts.presets ?? RANGE_PRESETS).map((days) => ({
    key: String(days),
    label: presetLabel(days),
    href: dateWindowHref(path, { kind: "relative", days }, opts),
    active: isPresetWindow(window, days),
  }));
  if (!opts.calendar) return rolling;
  const calendar = CALENDAR_PRESETS.map((unit) => ({
    key: unit,
    label: CALENDAR_LABEL[unit],
    href: dateWindowHref(path, { kind: "calendar", unit }, opts),
    active: isCalendarWindow(window, unit),
  }));
  // "Today" first, then the two calendar periods, then the rolling windows: the
  // row reads shortest-first, and a reader looking for "this month" finds it
  // beside "this week" rather than after "Last 90 days".
  return [rolling[0]!, ...calendar, ...rolling.slice(1)];
}

/**
 * §2's accounting periods as pills: month, quarter, half-year, financial year.
 *
 * A separate function from `rangePresets` rather than a flag on it, because
 * the two answer different questions and a page wants one or the other. See
 * `ACCOUNTING_PRESETS` for why they are not simply appended to the rolling row.
 */
export function accountingPresets(
  path: string,
  window: DateWindow,
  opts: { keep?: Keep; defaultUnit?: CalendarUnit } = {},
): RangePreset[] {
  const fallback = opts.defaultUnit ?? "month";
  return ACCOUNTING_PRESETS.map((unit) => ({
    key: unit,
    label: CALENDAR_LABEL[unit],
    // The page's default unit gets the bare path, so that stays the canonical
    // address of the default view - the same rule `dateWindowHref` applies to
    // the default day count.
    href:
      unit === fallback
        ? dateWindowHref(path, { kind: "relative", days: DEFAULT_RANGE_DAYS }, { keep: opts.keep })
        : dateWindowHref(path, { kind: "calendar", unit }, { keep: opts.keep }),
    active: isCalendarWindow(window, unit) || (unit === fallback && window.kind === "relative"),
  }));
}

/**
 * §2's "comparison to the previous period and the same period last year".
 *
 * Returns the two comparison windows for a calendar period, or null for a
 * rolling or custom one - where "the same period last year" has no meaning
 * anybody agrees on. A caller that wants a comparison on "last 30 days" is
 * asking for the previous 30 days, which is `shiftDateKey` arithmetic it can
 * do itself; the point of this function is the periods where that arithmetic
 * is WRONG, because a quarter is 90 or 92 days depending which one.
 */
export function comparisonWindows(
  window: DateWindow,
  today: string,
  fyStartMonth: number = DEFAULT_FY_START_MONTH,
): { previous: { from: string; to: string; label: string }; lastYear: { from: string; to: string; label: string } } | null {
  if (window.kind !== "calendar") return null;
  const current = fiscalPeriod(window.unit, today, fyStartMonth);
  const prev = previousPeriod(current, fyStartMonth);
  const year = samePeriodLastYear(current, fyStartMonth);
  return {
    previous: { from: prev.from, to: prev.to, label: prev.label },
    lastYear: { from: year.from, to: year.to, label: year.label },
  };
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
  // "so far" is load-bearing: the period runs to TODAY, not to its last calendar
  // day, and a comparison sentence reading "this month" would invite the reader
  // to take it as the whole month.
  if (window.kind === "calendar") return window.unit === "week" ? "this week so far" : "this month so far";
  return formatReportRange(echo?.from ?? window.from, echo?.to ?? window.to);
}

/** `windowPhrase` opening a line: "Last 30 days", "1 – 30 Sep 2026". */
export function windowTitle(window: DateWindow, echo?: { from?: string; to?: string }): string {
  const phrase = windowPhrase(window, echo);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
