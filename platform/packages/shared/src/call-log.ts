import { z } from "zod";
import { isCalendarDate } from "./call-insights";

/**
 * The owner call log's date filter and sort (`GET /v1/owner/calls`).
 *
 * ── WHY THE PRESETS ARE RESOLVED BY THE DATABASE ────────────────────────────
 *
 * "Today" means today on the org's floor, in its reporting timezone. Neither
 * the browser nor the web tier knows that zone, and a UTC "today" is five and a
 * half hours wrong on an Indian floor - a call at 2am IST would land on
 * yesterday. So a preset travels as its NAME and the API turns it into dates
 * with `org_reporting_today()`, the same way Call insights and the Staff
 * scorecard read their windows. An explicit `from`/`to` is a pair of calendar
 * dates in that same zone.
 */

/** In the order the picker lists them: the narrow ones first. */
export const CALL_LOG_PERIODS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  { key: "last30", label: "Last 30 days" },
  { key: "last90", label: "Last 90 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
] as const;

export type CallLogPeriod = (typeof CALL_LOG_PERIODS)[number]["key"];

const PERIOD_KEYS = CALL_LOG_PERIODS.map((p) => p.key) as [CallLogPeriod, ...CallLogPeriod[]];

export const CALL_LOG_SORTS = ["newest", "oldest"] as const;
export type CallLogSort = (typeof CALL_LOG_SORTS)[number];

const CalendarDate = z
  .string()
  .refine(isCalendarDate, "dates are YYYY-MM-DD calendar dates");

/**
 * The date part of the call log's query. `from`/`to` win over `period` when
 * both are present - an explicit choice is more specific than a preset.
 */
export const CallLogDateQuery = z
  .object({
    period: z.enum(PERIOD_KEYS).optional(),
    from: CalendarDate.optional(),
    to: CalendarDate.optional(),
    sort: z.enum(CALL_LOG_SORTS).default("newest"),
  })
  .superRefine((q, ctx) => {
    if ((q.from === undefined) !== (q.to === undefined)) {
      ctx.addIssue({ code: "custom", message: "from and to go together" });
    } else if (q.from && q.to && q.from > q.to) {
      ctx.addIssue({ code: "custom", message: "from must not be after to" });
    }
  });
export type CallLogDateQuery = z.infer<typeof CallLogDateQuery>;

/** What the date filter is set to. `null` is "any date". */
export type CallLogDateSelection =
  | { kind: "period"; period: CallLogPeriod }
  | { kind: "range"; from: string; to: string };

export function isCallLogPeriod(value: string | null | undefined): value is CallLogPeriod {
  return PERIOD_KEYS.includes(value as CallLogPeriod);
}

export function callLogPeriodLabel(period: CallLogPeriod): string {
  return CALL_LOG_PERIODS.find((p) => p.key === period)?.label ?? period;
}

/**
 * A URL's date parameters as something the API will accept.
 *
 * Forgiving, because these come from an address bar and a shared link: a lone
 * date is that one day, a reversed pair is put the right way round, and a date
 * that is not a date is ignored rather than turning the whole log into a 400.
 * The API itself stays strict (`CallLogDateQuery`); this is the web tier's
 * courtesy before it asks.
 */
export function callLogDateSelection(raw: {
  period?: string | null;
  from?: string | null;
  to?: string | null;
}): CallLogDateSelection | null {
  const from = raw.from && isCalendarDate(raw.from) ? raw.from : null;
  const to = raw.to && isCalendarDate(raw.to) ? raw.to : null;
  if (from || to) {
    const a = from ?? to!;
    const b = to ?? from!;
    return a <= b ? { kind: "range", from: a, to: b } : { kind: "range", from: b, to: a };
  }
  return isCallLogPeriod(raw.period) ? { kind: "period", period: raw.period } : null;
}

/** The selection as the query-string parameters it travels as. */
export function callLogDateParams(selection: CallLogDateSelection | null): Record<string, string> {
  if (!selection) return {};
  return selection.kind === "period"
    ? { period: selection.period }
    : { from: selection.from, to: selection.to };
}
