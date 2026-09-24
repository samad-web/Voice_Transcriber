import {
  CALL_INSIGHT_RANGES,
  CallInsightsQuery,
  type CallInsightsWindow,
  DEFAULT_CALL_INSIGHT_DAYS,
  callInsightsParams,
} from "@aura/shared";

/**
 * The call insights page's URL state - pure, so it is testable and so the
 * page, its range form and its PDF button all read the window the same way.
 *
 * The window itself is validated by the SAME zod schema the API uses
 * (`CallInsightsQuery` in @aura/shared). A URL the API would refuse is caught
 * here first and falls back to the default range with a notice, rather than
 * rendering a page-sized "400" for a hand-edited query string.
 */

type SearchParams = Record<string, string | string[] | undefined>;

export interface ParsedInsightsSearch {
  window: CallInsightsWindow;
  /** The URL asked for something the API would refuse; `window` is the default instead. */
  invalid: boolean;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseInsightsSearch(sp: SearchParams): ParsedInsightsSearch {
  const raw = {
    ...(first(sp.days) ? { days: first(sp.days) } : {}),
    ...(first(sp.from) ? { from: first(sp.from) } : {}),
    ...(first(sp.to) ? { to: first(sp.to) } : {}),
  };
  const parsed = CallInsightsQuery.safeParse(raw);
  if (!parsed.success) {
    return { window: { kind: "relative", days: DEFAULT_CALL_INSIGHT_DAYS }, invalid: true };
  }
  const q = parsed.data;
  if (q.from && q.to) return { window: { kind: "fixed", from: q.from, to: q.to }, invalid: false };
  return { window: { kind: "relative", days: q.days ?? DEFAULT_CALL_INSIGHT_DAYS }, invalid: false };
}

/** Whether a preset pill is the active window. A custom range lights none. */
export function isPreset(window: CallInsightsWindow, days: number): boolean {
  return window.kind === "relative" && window.days === days;
}

/** "Today" first, then the page's own "Last N days". */
export const INSIGHT_PRESETS = [1, ...CALL_INSIGHT_RANGES] as const;

/** `/owner/insights`, carrying the window unless it is the default. */
export function insightsHref(window: CallInsightsWindow): string {
  if (window.kind === "relative" && window.days === DEFAULT_CALL_INSIGHT_DAYS) return "/owner/insights";
  return `/owner/insights?${callInsightsParams(window)}`;
}

/**
 * The PDF download URL. A plain path for `fetch` in the browser, so it must
 * carry Next's basePath itself: production serves the console under /admin,
 * and only <Link>/router navigation adds that automatically (see
 * lib/console-url.ts and lib/global-search.ts, which hit the same trap).
 */
export function insightsPdfHref(
  window: CallInsightsWindow,
  includeCalls: boolean,
  basePath: string = process.env.NEXT_PUBLIC_BASE_PATH ?? "",
): string {
  const params = callInsightsParams(window);
  if (!includeCalls) params.set("calls", "0");
  return `${basePath.replace(/\/+$/, "")}/owner/insights/export?${params}`;
}

/**
 * The filename from a Content-Disposition header, or a fallback. Only the
 * plain `filename="..."` form, which is all the API sends; anything with a
 * path separator is refused rather than trusted.
 */
export function filenameFromDisposition(header: string | null, fallback = "call-insights.pdf"): string {
  const match = header?.match(/filename="([^"]+)"/);
  const name = match?.[1];
  return name && !/[\\/]/.test(name) ? name : fallback;
}
