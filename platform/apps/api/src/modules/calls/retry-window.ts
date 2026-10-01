import { z } from "zod";
import { daysBetweenInclusive, isCalendarDate } from "@aura/shared";

/**
 * The period a bulk reprocess covers, and the ONE place its SQL is written.
 *
 * ── WHY THE PREDICATE IS SHARED AND NOT WRITTEN TWICE ───────────────────────
 *
 * Two routes ask about the same window: `GET /calls/retry-summary` counts what
 * is in it, and `POST /calls/reprocess-backlog` rewinds it. The console shows
 * the first number and then presses the second button, so if the two predicates
 * ever disagree the operator is shown a count and charged for a different one -
 * the worst kind of drift, because both halves look right in isolation and the
 * only symptom is an invoice. `retryWindowSql()` is therefore the single source
 * of the WHERE clause, and both routes bind it.
 *
 * ── WHY "LAST N DAYS" IS ROLLING AND A CUSTOM RANGE IS NOT ──────────────────
 *
 * `days` is a rolling count back from now, which is what the existing backlog
 * action has always meant and what "the provider broke this afternoon" asks
 * for. A custom range is CALENDAR days in the org's own reporting zone
 * (0132/doc 30), because a person typing 18-27 September means those days as
 * their floor lived them - not a UTC midnight five and a half hours early, which
 * would quietly take the evening of the 17th and miss the evening of the 27th.
 */
export type RetryWindow =
  | { kind: "all" }
  | { kind: "days"; days: number }
  | { kind: "range"; from: string; to: string };

/** Ten years. Past this, "everything" is the honest answer and says so. */
export const MAX_WINDOW_DAYS = 3650;

/**
 * Every state a call may be rewound FROM.
 *
 * FAILED_UPLOAD is deliberately excluded: it means the audio never reached S3
 * at all, so rewinding it to UPLOADED can only ever fail again at transcode.
 * There is nothing here for a "try these again" action to usefully retry - see
 * 0101. NO_AUDIO is excluded for the same reason and a stronger one (0133): a
 * missed call has no recording to process and never did.
 */
export const REPROCESSABLE_STATUSES = [
  "TRANSCRIPTION_OFF",
  "COMPLETE",
  "FAILED_TRANSCODE",
  "FAILED_ASR",
  "FAILED_ANALYZE",
  "FAILED_CRM",
] as const;

/**
 * The subset that means "the pipeline tried and could not finish" - what the
 * console's Reprocess panel is about, and the summary's default.
 *
 * COMPLETE and TRANSCRIPTION_OFF are reprocessable but are NOT failures: one is
 * a re-run of work that already succeeded, the other is a backlog the
 * transcription switch owns. Including them in a failure count would put the
 * tenant's entire history behind a button labelled "retry what broke".
 */
export const FAILURE_STATUSES = [
  "FAILED_TRANSCODE",
  "FAILED_ASR",
  "FAILED_ANALYZE",
  "FAILED_CRM",
] as const;

export const ReprocessableStatus = z.enum(REPROCESSABLE_STATUSES);

const CalendarDate = z.string().refine(isCalendarDate, "dates are YYYY-MM-DD calendar dates");

/**
 * The window as it arrives on the wire, from either route.
 *
 * `sinceDays` is kept under its original name because the transcription toggle
 * has been sending it since the backlog action existed, and `null` there has
 * always meant the whole history. `from`/`to` are the addition: the same pair,
 * spelt the same way, as every other range in the product (lib/date-range.ts).
 */
export const RetryWindowInput = {
  sinceDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).nullable().optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
};

/** Shared by both routes' schemas, so one bad range cannot be legal on one of them. */
export function refineRetryWindow(
  q: { sinceDays?: number | null; from?: string; to?: string },
  ctx: z.RefinementCtx,
): void {
  if ((q.from === undefined) !== (q.to === undefined)) {
    ctx.addIssue({ code: "custom", message: "from and to go together" });
    return;
  }
  if (q.from && q.to) {
    // Not an error worth inventing a second meaning for: a reversed pair is
    // refused rather than silently swapped, because a bulk spend is the wrong
    // place to guess what somebody meant.
    if (q.from > q.to) ctx.addIssue({ code: "custom", message: "from must not be after to" });
    else if (daysBetweenInclusive(q.from, q.to) > MAX_WINDOW_DAYS) {
      ctx.addIssue({ code: "custom", message: `range must not exceed ${MAX_WINDOW_DAYS} days` });
    }
    if (q.sinceDays != null) {
      ctx.addIssue({ code: "custom", message: "pass either sinceDays or from/to, not both" });
    }
  }
}

export function toRetryWindow(input: {
  sinceDays?: number | null;
  from?: string;
  to?: string;
}): RetryWindow {
  if (input.from && input.to) return { kind: "range", from: input.from, to: input.to };
  // `sinceDays` absent and `sinceDays: null` mean the same thing here, and both
  // mean everything. That is the pre-existing contract, not a new default.
  if (input.sinceDays == null) return { kind: "all" };
  return { kind: "days", days: input.sinceDays };
}

/**
 * The window as a predicate on `calls.started_at`, with its bind parameters.
 *
 * `nextParam` is the first placeholder number this fragment may use, so the
 * caller keeps control of its own numbering - the alternative is a fragment that
 * assumes it is first and breaks the moment a second filter is added above it.
 */
export function retryWindowSql(
  win: RetryWindow,
  nextParam: number,
): { sql: string; params: unknown[] } {
  if (win.kind === "all") return { sql: "TRUE", params: [] };
  if (win.kind === "days") {
    return {
      sql: `started_at >= now() - make_interval(days => $${nextParam})`,
      params: [win.days],
    };
  }
  // Local midnight ON each date, converted with the offset in force on that
  // date - the construction org_window_start() and the dashboard's windowCte()
  // both use. The upper edge is the day AFTER `to`, exclusive, so the whole of
  // the last day is included however late the call started.
  return {
    sql:
      `started_at >= ($${nextParam}::date)::timestamp AT TIME ZONE org_reporting_tz() ` +
      `AND started_at < ($${nextParam + 1}::date + 1)::timestamp AT TIME ZONE org_reporting_tz()`,
    params: [win.from, win.to],
  };
}

/** What the window is called in an audit row and in the console's confirmation. */
export function describeRetryWindow(win: RetryWindow): string {
  if (win.kind === "all") return "every stored call";
  if (win.kind === "days") return `the last ${win.days} day${win.days === 1 ? "" : "s"}`;
  return `${win.from} to ${win.to}`;
}

/**
 * The most calls one press may requeue.
 *
 * A cap rather than "all of them" because the publish loop is per call and a
 * single request that enqueues ten thousand is a request that times out
 * halfway, leaving the operator with no idea how far it got. The console reads
 * this number back from the summary and says how many presses a backlog needs,
 * which is a smaller surprise than a silent truncation.
 */
export const MAX_REPROCESS_PER_RUN = 1000;

/**
 * The whole summary query, assembled.
 *
 * ── WHY THIS IS NOT INLINE IN THE CONTROLLER ────────────────────────────────
 *
 * Because it numbers its own placeholders. Five windows contribute two bind
 * parameters at most each, in an order decided at runtime, and every one of them
 * is read positionally by Postgres: an off-by-one puts the status array where a
 * day count belongs, which is not a type error, not a syntax error, and on a
 * `text[]` against `make_interval` not even reliably a runtime error - it is
 * simply a different window than the one the operator picked. Nothing in the
 * handler could show that, and this repository cannot run Postgres on the
 * machine it is developed on (Docker is off, see the build notes), so the
 * numbering is proven by `retry-window.spec.ts` instead.
 *
 * $1 is the org, $2 the status array; everything after is a window's own.
 * `selected` is counted a second time rather than being matched against a preset
 * it may happen to equal, because the response reports it separately and a
 * shared column would make the two disagree the moment one changed.
 */
export function buildRetrySummarySql(
  presets: Array<number | null>,
  selected: RetryWindow,
): { sql: string; params: unknown[]; selectedSql: string } {
  const params: unknown[] = [];
  const columns: string[] = [];
  const add = (win: RetryWindow, prefix: string): string => {
    // +3 because $1 and $2 belong to the caller's org and status filters.
    const fragment = retryWindowSql(win, params.length + 3);
    params.push(...fragment.params);
    columns.push(
      `count(*) FILTER (WHERE ${fragment.sql})::int AS ${prefix}_calls`,
      `COALESCE(sum(duration_s) FILTER (WHERE ${fragment.sql}), 0)::int AS ${prefix}_seconds`,
    );
    return fragment.sql;
  };

  presets.forEach((days, i) => {
    add(days === null ? { kind: "all" } : { kind: "days", days }, `p${i}`);
  });
  const selectedSql = add(selected, "sel");

  return {
    selectedSql,
    params,
    sql: `SELECT status, ${columns.join(", ")},
                 min(started_at) FILTER (WHERE ${selectedSql}) AS oldest,
                 max(started_at) FILTER (WHERE ${selectedSql}) AS newest
            FROM calls
           WHERE org_id = $1
             AND status = ANY($2::text[])
           GROUP BY status
           ORDER BY status`,
  };
}
