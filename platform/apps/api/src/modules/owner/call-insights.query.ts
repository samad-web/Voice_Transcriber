import {
  CALLBACK_WAITING_MAX,
  CALL_OUTCOMES,
  CALL_SENTIMENTS,
  type CallInsightsAttentionCall,
  type CallInsightsCallbacks,
  type CallInsightsDay,
  type CallInsightsHour,
  type CallInsightsPerson,
  type CallInsightsReport,
  type CallInsightsTotals,
  type CallInsightsWindow,
  type CallOutcomeKey,
  type CallSentimentKey,
  humanizeKey,
  isCalendarDate,
} from "@aura/shared";
import { HAS_NUMBER, IS_MISSED, MISSED_CALLBACK_JOIN } from "./missed-callback-sql";

/**
 * The SQL behind call insights, and the one function that turns its rows into
 * the shared contract. Pure - no database handle - so both halves are testable
 * without one, and the controller is left with nothing to decide.
 *
 * ── ONE ROUND TRIP ──────────────────────────────────────────────────────────
 *
 * Eleven aggregates, sent as ONE multi-statement simple query, for the reason
 * owner.controller.ts gives at length: the API runs in Mumbai against a
 * database in Seoul, ~125ms a flight, and eleven sequential flights would put
 * well over a second of pure latency in front of a page and a PDF that are
 * both waited on. That protocol takes no bind parameters, so the window is
 * INTERPOLATED - and it is only ever one of two things, both re-validated here
 * even though zod already has: a calendar date matching `YYYY-MM-DD` (checked
 * against the calendar, not only the regex), or an integer day count. There is
 * no string in this file that came from a person.
 *
 * ── THE WINDOW IS THE ORG'S CALENDAR, RESOLVED IN THE DATABASE ──────────────
 *
 * `w` turns the window into instants using `organizations.reporting_timezone`
 * (0090). A relative window ("last 30 days") anchors on `org_reporting_today()`
 * (0095) rather than on a date the web tier computed, because the web tier does
 * not know the timezone and a UTC "today" is five and a half hours wrong on an
 * Indian floor - the evening's calls would land in tomorrow. Days and hours in
 * the series below are bucketed in the same zone, so "1-2 PM" means the floor's
 * lunch hour, not the server's.
 *
 * The previous period is the same number of days immediately before `from`, so
 * every delta compares like with like.
 *
 * ── WHOSE CALLS ─────────────────────────────────────────────────────────────
 *
 * Every call in the org, under RLS. The routes are owner/manager only (a floor
 * view, like the call log), so there is no persona narrowing to thread through.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertWindow(w: CallInsightsWindow): void {
  if (w.kind === "relative") {
    if (!Number.isInteger(w.days) || w.days < 1 || w.days > 366) throw new Error("invalid window days");
    return;
  }
  for (const d of [w.from, w.to]) {
    if (!ISO_DATE.test(d) || !isCalendarDate(d)) throw new Error("invalid window date");
  }
  if (w.from > w.to) throw new Error("window from is after to");
}

/** The `w` CTE every statement opens with. */
export function windowCte(window: CallInsightsWindow): string {
  assertWindow(window);
  const bounds =
    window.kind === "fixed"
      ? `SELECT DATE '${window.from}' AS from_d, DATE '${window.to}' AS to_d`
      : `SELECT org_reporting_today() - ${window.days - 1} AS from_d, org_reporting_today() AS to_d`;
  return `w AS (
    SELECT b.from_d, b.to_d, (b.to_d - b.from_d + 1) AS span, z.zone,
           b.from_d::timestamp AT TIME ZONE z.zone                             AS from_at,
           (b.to_d + 1)::timestamp AT TIME ZONE z.zone                         AS to_at,
           (b.from_d - (b.to_d - b.from_d + 1))::timestamp AT TIME ZONE z.zone AS prev_from_at
      FROM (SELECT COALESCE(reporting_timezone, 'Asia/Kolkata') AS zone FROM organizations LIMIT 1) z
     CROSS JOIN (${bounds}) b
  )`;
}

/** Calls inside the current window - the predicate nearly every statement shares. */
const IN_WINDOW = "c.started_at >= w.from_at AND c.started_at < w.to_at";

/**
 * The AI read, one row per call. LATERAL + LIMIT 1 rather than a plain join,
 * the same shape owner-calls.controller.ts's READ_JOIN uses: `transcripts` is
 * one row per call by convention (reprocess deletes before inserting), not by
 * constraint, and a duplicate must not double-count a call.
 */
const READ = `LEFT JOIN LATERAL (
    SELECT t.intelligence ->> 'sentiment'      AS sentiment,
           t.intelligence ->> 'outcome'        AS outcome,
           t.intelligence ->> 'overall_intent' AS intent,
           t.intelligence ->> 'summary'        AS summary
      FROM transcripts t
     WHERE t.call_id = c.id
     LIMIT 1
  ) ci ON true`;

/** `call_analytics` is UNIQUE (call_id), so a plain join cannot fan out. */
const ANALYTICS = "LEFT JOIN call_analytics a ON a.call_id = c.id";

/** `risk_flags` as an array even when a row holds something else. */
const RISK_FLAGS = `jsonb_array_elements(CASE WHEN jsonb_typeof(a.risk_flags) = 'array' THEN a.risk_flags ELSE '[]'::jsonb END)`;

/** A number out of `quality_criteria`, or null - never a cast that can throw. */
function criterion(key: string): string {
  return `CASE WHEN jsonb_typeof(a.quality_criteria -> '${key}') = 'number'
               THEN (a.quality_criteria ->> '${key}')::numeric END`;
}

/**
 * The same five volume columns, everywhere a call count is broken out. One
 * definition, so the daily chart, the hour chart, the per-person table and the
 * headline row cannot disagree about what "missed" is (state.tsx's callState:
 * inbound with no airtime).
 */
const VOLUME_COLUMNS = `
       count(c.id) FILTER (WHERE c.direction = 'outgoing')::int                   AS outgoing,
       count(c.id) FILTER (WHERE c.direction = 'incoming' AND c.duration_s > 0)::int  AS answered,
       count(c.id) FILTER (WHERE c.direction = 'incoming' AND c.duration_s <= 0)::int AS missed,
       COALESCE(sum(c.duration_s) FILTER (WHERE c.duration_s > 0), 0)::int        AS talk_seconds`;

/** The statements, in the order `assembleCallInsights` reads them. */
export const STATEMENT_ORDER = [
  "meta",
  "totals",
  "daily",
  "hourly",
  "outcomes",
  "intents",
  "dispositions",
  "quality",
  "sop",
  "risk",
  "people",
  "attention",
  "callbacks",
  "waiting",
] as const;

export function callInsightsBatch(window: CallInsightsWindow): string {
  const W = `WITH ${windowCte(window)}`;

  const statements: Record<(typeof STATEMENT_ORDER)[number], string> = {
    meta: `${W}
      SELECT o.name, w.zone,
             to_char(w.from_d, 'YYYY-MM-DD')          AS from_d,
             to_char(w.to_d, 'YYYY-MM-DD')            AS to_d,
             w.span::int                              AS span,
             to_char(w.from_d - w.span, 'YYYY-MM-DD') AS prev_from,
             to_char(w.from_d - 1, 'YYYY-MM-DD')      AS prev_to
        FROM w CROSS JOIN (SELECT name FROM organizations LIMIT 1) o`,

    // Both periods in one statement: the previous one is only ever read for
    // its headline figures, so it costs a second group, not a second batch.
    totals: `${W},
      p AS (
        SELECT 'current'::text AS period, w.from_at AS lo, w.to_at AS hi FROM w
        UNION ALL
        SELECT 'previous', w.prev_from_at, w.from_at FROM w
      )
      SELECT p.period,
             count(c.id)::int                                            AS total,
             ${VOLUME_COLUMNS},
             count(c.id) FILTER (WHERE c.status LIKE 'FAILED%')::int     AS failed,
             count(c.id) FILTER (WHERE c.duration_s > 0)::int            AS connected,
             count(ci.sentiment)::int                                    AS analyzed,
             count(c.id) FILTER (WHERE ci.sentiment = 'positive')::int   AS positive,
             count(c.id) FILTER (WHERE ci.sentiment = 'negative')::int   AS negative,
             count(a.quality_score)::int                                 AS scored,
             round(avg(a.quality_score), 1)::float                       AS avg_quality,
             count(c.id) FILTER (WHERE a.has_escalation_risk)::int       AS risk_calls,
             count(c.lead_id)::int                                       AS lead_linked
        FROM p
        LEFT JOIN calls c ON c.started_at >= p.lo AND c.started_at < p.hi
        ${READ}
        ${ANALYTICS}
       GROUP BY p.period`,

    daily: `${W}
      SELECT to_char((c.started_at AT TIME ZONE w.zone)::date, 'YYYY-MM-DD') AS date,
             ${VOLUME_COLUMNS}
        FROM calls c CROSS JOIN w
       WHERE ${IN_WINDOW}
       GROUP BY 1 ORDER BY 1`,

    hourly: `${W}
      SELECT EXTRACT(hour FROM c.started_at AT TIME ZONE w.zone)::int AS hour,
             ${VOLUME_COLUMNS}
        FROM calls c CROSS JOIN w
       WHERE ${IN_WINDOW}
       GROUP BY 1 ORDER BY 1`,

    // Raw values; folding into the fixed vocabulary happens in TypeScript,
    // where it is testable - see foldOutcomes.
    outcomes: `${W}
      SELECT ci.outcome, count(*)::int AS count
        FROM calls c CROSS JOIN w
        ${READ}
       WHERE ${IN_WINDOW} AND ci.outcome IS NOT NULL
       GROUP BY 1`,

    // Free text, so grouped on a normalised form and shown in its most common
    // spelling. `count(*) OVER ()` is evaluated after GROUP BY and before
    // LIMIT, so it is the number of distinct intents, not of rows returned.
    intents: `${W}
      SELECT mode() WITHIN GROUP (ORDER BY btrim(ci.intent)) AS label,
             count(*)::int                                  AS count,
             (count(*) OVER ())::int                        AS distinct_total
        FROM calls c CROSS JOIN w
        ${READ}
       WHERE ${IN_WINDOW} AND COALESCE(btrim(ci.intent), '') <> ''
       GROUP BY lower(regexp_replace(btrim(ci.intent), '[[:space:][:punct:]]+$', ''))
       ORDER BY 2 DESC, 1
       LIMIT 8`,

    // The label through a LATERAL so a key can never fan a count out, and the
    // unset calls as their own row (key NULL) - "nobody recorded a verdict" is
    // the most common disposition on most floors and hiding it would flatter
    // the rest.
    dispositions: `${W}
      SELECT c.disposition_key AS key, max(dl.label) AS label, count(*)::int AS count
        FROM calls c CROSS JOIN w
        LEFT JOIN LATERAL (
          SELECT d.label FROM call_dispositions d WHERE d.key = c.disposition_key LIMIT 1
        ) dl ON true
       WHERE ${IN_WINDOW}
       GROUP BY 1
       ORDER BY 3 DESC`,

    quality: `${W}
      SELECT count(a.quality_score)::int                                            AS scored,
             round(avg(a.quality_score), 1)::float                                  AS average,
             count(*) FILTER (WHERE a.quality_score >= 70)::int                     AS strong,
             count(*) FILTER (WHERE a.quality_score >= 40 AND a.quality_score < 70)::int AS fair,
             count(*) FILTER (WHERE a.quality_score < 40)::int                      AS weak,
             count(*) FILTER (WHERE jsonb_typeof(a.quality_criteria) = 'object')::int AS criteria_sample,
             round(avg(${criterion("scriptAdherence")}), 1)::float                  AS script_adherence,
             round(avg(${criterion("professionalism")}), 1)::float                  AS professionalism,
             round(avg(${criterion("conversionSignal")}), 1)::float                 AS conversion_signal,
             round(100.0 * avg(CASE WHEN jsonb_typeof(a.quality_criteria -> 'consentDisclosed') = 'boolean'
                                    THEN CASE WHEN (a.quality_criteria ->> 'consentDisclosed')::boolean THEN 1 ELSE 0 END
                               END))::int                                            AS consent_pct,
             count(a.talk_ratio)::int                                               AS talk_sample,
             round(avg(a.talk_ratio), 3)::float                                     AS agent_share,
             round(avg(a.interruption_count) FILTER (WHERE a.talk_ratio IS NOT NULL), 1)::float AS interruptions
        FROM calls c CROSS JOIN w
        JOIN call_analytics a ON a.call_id = c.id
       WHERE ${IN_WINDOW}`,

    // Ranged on the CALL's start, never on when the result row was written
    // (0091's rule) - a reprocess must not move last month's scores into this
    // month.
    sop: `${W}
      SELECT count(r.adherence_pct)::int      AS scored,
             round(avg(r.adherence_pct))::int AS adherence
        FROM call_sop_results r CROSS JOIN w
       WHERE r.call_started_at >= w.from_at AND r.call_started_at < w.to_at
         AND r.adherence_pct IS NOT NULL`,

    // Categories and severities only. The flag's `snippet` is a quote from the
    // call and never leaves this statement.
    risk: `${W}
      SELECT lower(btrim(f ->> 'category'))                        AS category,
             count(DISTINCT c.id)::int                             AS calls,
             count(DISTINCT c.id) FILTER (WHERE f ->> 'severity' = 'high')::int AS high
        FROM calls c CROSS JOIN w
        JOIN call_analytics a ON a.call_id = c.id
       CROSS JOIN LATERAL ${RISK_FLAGS} f
       WHERE ${IN_WINDOW} AND COALESCE(btrim(f ->> 'category'), '') <> ''
       GROUP BY 1
       ORDER BY 2 DESC, 1
       LIMIT 6`,

    // Keyed on the WRITE-ONCE `calls.telecaller_id` (0068), not on whoever
    // holds the handset now - a phone handed to a new hire must not hand them
    // the previous holder's month. Calls from a handset nobody was named on
    // are one row with a null id rather than being dropped, so the table adds
    // up to the headline.
    people: `${W}
      SELECT c.telecaller_id,
             max(t.display_name)                                         AS name,
             count(c.id)::int                                            AS calls,
             ${VOLUME_COLUMNS},
             count(c.id) FILTER (WHERE c.duration_s > 0)::int            AS connected,
             count(ci.sentiment)::int                                    AS analyzed,
             count(c.id) FILTER (WHERE ci.sentiment = 'positive')::int   AS positive,
             count(a.quality_score)::int                                 AS scored,
             round(avg(a.quality_score), 1)::float                       AS avg_quality,
             count(c.id) FILTER (WHERE a.has_escalation_risk)::int       AS risk_calls,
             count(c.lead_id)::int                                       AS lead_linked
        FROM calls c CROSS JOIN w
        LEFT JOIN telecallers t ON t.id = c.telecaller_id
        ${READ}
        ${ANALYTICS}
       WHERE ${IN_WINDOW}
       GROUP BY c.telecaller_id
       ORDER BY 3 DESC, 2 NULLS LAST
       LIMIT 50`,

    // The short list a manager should open: escalation risk first (high
    // severity before the rest), then the weakest calls, newest first within
    // each. Ten, because this is a prompt to open the call log, not a copy of it.
    attention: `${W}
      SELECT c.id, c.started_at, c.direction, c.duration_s,
             c.remote_name, c.remote_number_prefix, c.remote_number_last3,
             COALESCE(t.display_name, d.telecaller_name, d.label)         AS telecaller,
             ci.sentiment, ci.outcome, ci.summary,
             a.quality_score,
             COALESCE(a.has_escalation_risk, false)                       AS risk,
             EXISTS (SELECT 1 FROM ${RISK_FLAGS} f WHERE f ->> 'severity' = 'high') AS high_risk,
             ARRAY(SELECT DISTINCT lower(btrim(f ->> 'category')) FROM ${RISK_FLAGS} f
                    WHERE COALESCE(btrim(f ->> 'category'), '') <> '')    AS risk_categories,
             lead.id AS lead_id, lead.title AS lead_title
        FROM calls c CROSS JOIN w
        LEFT JOIN telecallers t ON t.id = c.telecaller_id
        LEFT JOIN devices d ON d.id = c.device_id
        ${READ}
        ${ANALYTICS}
        LEFT JOIN leads lead ON lead.id = c.lead_id
       WHERE ${IN_WINDOW}
         AND (a.has_escalation_risk OR ci.sentiment = 'negative' OR a.quality_score < 40)
       ORDER BY risk DESC, high_risk DESC, a.quality_score ASC NULLS LAST, c.started_at DESC
       LIMIT 10`,

    // What became of the range's missed calls (0133) - see
    // missed-callback-sql.ts for what counts as a return. Returns are looked
    // for up to NOW, not up to the range's end: a call missed on the last
    // evening and returned the next morning was returned.
    callbacks: `${W},
      m AS (
        SELECT c.started_at, ${HAS_NUMBER} AS has_number,
               COALESCE(c.remote_number_key, c.remote_number_hash) AS person,
               cb.returned_at, cb.return_direction
          FROM calls c CROSS JOIN w
          ${MISSED_CALLBACK_JOIN}
         WHERE ${IN_WINDOW} AND ${IS_MISSED}
      )
      SELECT count(*)::int                                                     AS missed,
             count(*) FILTER (WHERE NOT has_number)::int                       AS no_number,
             count(returned_at)::int                                           AS returned,
             count(*) FILTER (WHERE return_direction = 'outgoing')::int        AS called_back,
             count(*) FILTER (WHERE returned_at <= started_at + interval '1 hour')::int AS within_hour,
             round((percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(epoch FROM returned_at - started_at) / 60.0
             ) FILTER (WHERE returned_at IS NOT NULL))::numeric, 1)::float     AS median_minutes,
             count(DISTINCT person) FILTER (WHERE returned_at IS NULL AND has_number)::int AS waiting_callers
        FROM m`,

    // The people still waiting, one row each, newest miss first. Grouped on
    // the match key so three missed calls from one customer are one line
    // saying "3 tries", not three lines. The number key itself never leaves
    // this statement - only the privacy-lite fragments the call log shows.
    waiting: `${W},
      m AS (
        SELECT c.id, c.started_at, c.remote_name, c.remote_number_prefix,
               c.remote_number_last3, c.lead_id,
               COALESCE(t.display_name, d.telecaller_name, d.label) AS telecaller,
               COALESCE(c.remote_number_key, c.remote_number_hash) AS person
          FROM calls c CROSS JOIN w
          LEFT JOIN telecallers t ON t.id = c.telecaller_id
          LEFT JOIN devices d ON d.id = c.device_id
          ${MISSED_CALLBACK_JOIN}
         WHERE ${IN_WINDOW} AND ${IS_MISSED} AND ${HAS_NUMBER} AND cb.returned_at IS NULL
      ),
      g AS (
        SELECT count(*)::int                                                        AS attempts,
               max(started_at)                                                      AS last_missed_at,
               (array_agg(id ORDER BY started_at DESC))[1]                          AS call_id,
               (array_agg(remote_name ORDER BY started_at DESC)
                  FILTER (WHERE remote_name IS NOT NULL))[1]                        AS remote_name,
               (array_agg(remote_number_prefix ORDER BY started_at DESC))[1]        AS remote_number_prefix,
               (array_agg(remote_number_last3 ORDER BY started_at DESC))[1]         AS remote_number_last3,
               (array_agg(telecaller ORDER BY started_at DESC))[1]                  AS telecaller,
               (array_agg(lead_id ORDER BY started_at DESC)
                  FILTER (WHERE lead_id IS NOT NULL))[1]                            AS lead_id
          FROM m
         GROUP BY person
         ORDER BY max(started_at) DESC
         LIMIT ${CALLBACK_WAITING_MAX}
      )
      SELECT g.call_id, g.attempts, g.last_missed_at, g.remote_name,
             g.remote_number_prefix, g.remote_number_last3, g.telecaller,
             lead.id AS lead_id, lead.title AS lead_title
        FROM g
        LEFT JOIN leads lead ON lead.id = g.lead_id
       ORDER BY g.last_missed_at DESC`,
  };

  return STATEMENT_ORDER.map((key) => statements[key]).join(";\n");
}

// ── Assembly ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
export type BatchResult = Array<{ rows: Row[] }>;

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const nOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

const EMPTY_TOTALS: CallInsightsTotals = {
  total: 0,
  outgoing: 0,
  answered: 0,
  missed: 0,
  failed: 0,
  connected: 0,
  talkSeconds: 0,
  analyzed: 0,
  positive: 0,
  negative: 0,
  scored: 0,
  avgQuality: null,
  riskCalls: 0,
  leadLinked: 0,
};

function toTotals(row: Row | undefined): CallInsightsTotals {
  if (!row) return { ...EMPTY_TOTALS };
  return {
    total: n(row.total),
    outgoing: n(row.outgoing),
    answered: n(row.answered),
    missed: n(row.missed),
    failed: n(row.failed),
    connected: n(row.connected),
    talkSeconds: n(row.talk_seconds),
    analyzed: n(row.analyzed),
    positive: n(row.positive),
    negative: n(row.negative),
    scored: n(row.scored),
    avgQuality: nOrNull(row.avg_quality),
    riskCalls: n(row.risk_calls),
    leadLinked: n(row.lead_linked),
  };
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every day in the range, zeros where the database had no row - a quiet day is a finding, not a gap. */
export function fillDaily(rows: Row[], from: string, to: string): CallInsightsDay[] {
  const byDate = new Map(rows.map((r) => [String(r.date), r]));
  const out: CallInsightsDay[] = [];
  for (let d = from, i = 0; d <= to && i < 400; d = shiftDate(d, 1), i++) {
    const r = byDate.get(d);
    out.push({
      date: d,
      outgoing: n(r?.outgoing),
      answered: n(r?.answered),
      missed: n(r?.missed),
      talkSeconds: n(r?.talk_seconds),
    });
  }
  return out;
}

export function fillHourly(rows: Row[]): CallInsightsHour[] {
  const byHour = new Map(rows.map((r) => [n(r.hour), r]));
  return Array.from({ length: 24 }, (_, hour) => {
    const r = byHour.get(hour);
    return { hour, outgoing: n(r?.outgoing), answered: n(r?.answered), missed: n(r?.missed) };
  });
}

/** Raw analyzer outcomes into the fixed vocabulary; anything unrecognised is `other`. */
export function foldOutcomes(rows: Row[]): CallInsightsReport["outcomes"] {
  const counts = new Map<CallOutcomeKey, number>(CALL_OUTCOMES.map((o) => [o.key, 0]));
  for (const row of rows) {
    const raw = String(row.outcome ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const key = (counts.has(raw as CallOutcomeKey) ? raw : "other") as CallOutcomeKey;
    counts.set(key, (counts.get(key) ?? 0) + n(row.count));
  }
  return CALL_OUTCOMES.map((o) => ({ key: o.key, label: o.label, count: counts.get(o.key) ?? 0 }));
}

/** Contact label, in the call log's own order (owner calls-explorer.tsx). */
export function contactLabel(row: Row): string {
  const name = s(row.remote_name);
  if (name) return name.trim();
  const prefix = s(row.remote_number_prefix);
  if (prefix) return `${prefix}…${s(row.remote_number_last3) ?? ""}`;
  const last3 = s(row.remote_number_last3);
  if (last3) return `…${last3}`;
  return "Unknown caller";
}

export function attentionReasons(row: Row): string[] {
  const reasons: string[] = [];
  if (row.risk === true) reasons.push(row.high_risk === true ? "High escalation risk" : "Escalation risk");
  if (row.sentiment === "negative") reasons.push("Negative sentiment");
  const quality = nOrNull(row.quality_score);
  if (quality !== null && quality < 40) reasons.push(`Low quality (${Math.round(quality)}/100)`);
  return reasons;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const parsed = new Date(String(v));
  return Number.isNaN(parsed.getTime()) ? String(v) : parsed.toISOString();
}

export function assembleCallInsights(batch: BatchResult, generatedAt: Date = new Date()): CallInsightsReport {
  if (batch.length !== STATEMENT_ORDER.length) {
    // A statement added to one list and not the other would silently shift
    // every section onto its neighbour's rows. Fail loudly instead.
    throw new Error(`call insights expected ${STATEMENT_ORDER.length} results, got ${batch.length}`);
  }
  const at = (key: (typeof STATEMENT_ORDER)[number]) => batch[STATEMENT_ORDER.indexOf(key)].rows;

  const meta = at("meta")[0] ?? {};
  const from = String(meta.from_d);
  const to = String(meta.to_d);

  const totals = at("totals");
  const current = toTotals(totals.find((r) => r.period === "current"));
  const previous = toTotals(totals.find((r) => r.period === "previous"));

  // Sentiment from the totals row, not a statement of its own: the three
  // counts must add to `analyzed`, and deriving neutral as the remainder is
  // what guarantees it (the analyzer coerces anything unrecognised to neutral).
  const sentimentCounts: Record<CallSentimentKey, number> = {
    positive: current.positive,
    neutral: Math.max(0, current.analyzed - current.positive - current.negative),
    negative: current.negative,
  };

  const intentRows = at("intents");
  const dispositionRows = at("dispositions");
  const quality = at("quality")[0] ?? {};
  const sop = at("sop")[0] ?? {};

  return {
    org: { name: s(meta.name) ?? "Your organisation", timezone: s(meta.zone) ?? "Asia/Kolkata" },
    range: { from, to, days: n(meta.span) },
    previousRange: { from: String(meta.prev_from), to: String(meta.prev_to) },
    generatedAt: generatedAt.toISOString(),
    current,
    previous,
    daily: fillDaily(at("daily"), from, to),
    hourly: fillHourly(at("hourly")),
    sentiment: CALL_SENTIMENTS.map((x) => ({ key: x.key, label: x.label, count: sentimentCounts[x.key] })),
    outcomes: foldOutcomes(at("outcomes")),
    intents: {
      rows: intentRows.map((r) => ({ label: String(r.label).trim(), count: n(r.count) })),
      distinct: n(intentRows[0]?.distinct_total),
    },
    dispositions: {
      rows: dispositionRows
        .filter((r) => s(r.key))
        .map((r) => ({
          key: String(r.key),
          // A key whose definition was deleted still counts; it reads by key.
          label: s(r.label) ?? humanizeKey(String(r.key)),
          count: n(r.count),
        })),
      unset: n(dispositionRows.find((r) => !s(r.key))?.count),
    },
    quality: {
      scored: n(quality.scored),
      average: nOrNull(quality.average),
      bands: { strong: n(quality.strong), fair: n(quality.fair), weak: n(quality.weak) },
      criteria: {
        sample: n(quality.criteria_sample),
        scriptAdherence: nOrNull(quality.script_adherence),
        professionalism: nOrNull(quality.professionalism),
        conversionSignal: nOrNull(quality.conversion_signal),
        consentDisclosedPct: nOrNull(quality.consent_pct),
      },
    },
    talk: {
      sample: n(quality.talk_sample),
      agentShare: nOrNull(quality.agent_share),
      interruptions: nOrNull(quality.interruptions),
    },
    sop: { scored: n(sop.scored), adherence: nOrNull(sop.adherence) },
    risk: {
      calls: current.riskCalls,
      categories: at("risk").map((r) => ({
        category: String(r.category),
        label: humanizeKey(String(r.category)),
        calls: n(r.calls),
        high: n(r.high),
      })),
    },
    people: at("people").map(
      (r): CallInsightsPerson => ({
        telecallerId: s(r.telecaller_id),
        name: s(r.name) ?? (s(r.telecaller_id) ? "Unnamed telecaller" : "Not attributed"),
        calls: n(r.calls),
        outgoing: n(r.outgoing),
        answered: n(r.answered),
        missed: n(r.missed),
        connected: n(r.connected),
        talkSeconds: n(r.talk_seconds),
        analyzed: n(r.analyzed),
        positive: n(r.positive),
        scored: n(r.scored),
        avgQuality: nOrNull(r.avg_quality),
        riskCalls: n(r.risk_calls),
        leadLinked: n(r.lead_linked),
      }),
    ),
    attention: at("attention").map(
      (r): CallInsightsAttentionCall => ({
        id: String(r.id),
        startedAt: toIso(r.started_at),
        direction: String(r.direction ?? ""),
        durationS: nOrNull(r.duration_s),
        telecaller: s(r.telecaller),
        contact: contactLabel(r),
        sentiment: s(r.sentiment),
        outcome: s(r.outcome),
        quality: nOrNull(r.quality_score),
        risk: r.risk === true,
        highRisk: r.high_risk === true,
        riskCategories: Array.isArray(r.risk_categories)
          ? (r.risk_categories as unknown[]).filter((c): c is string => typeof c === "string" && c !== "")
          : [],
        summary: s(r.summary),
        leadId: s(r.lead_id),
        leadTitle: s(r.lead_title),
        reasons: attentionReasons(r),
      }),
    ),
    callbacks: toCallbacks(at("callbacks")[0], at("waiting")),
  };
}

function toCallbacks(row: Row | undefined, waiting: Row[]): CallInsightsCallbacks {
  return {
    missed: n(row?.missed),
    noNumber: n(row?.no_number),
    returned: n(row?.returned),
    calledBack: n(row?.called_back),
    withinHour: n(row?.within_hour),
    medianMinutes: nOrNull(row?.median_minutes),
    waitingCallers: n(row?.waiting_callers),
    waiting: waiting.map((r) => ({
      callId: String(r.call_id),
      contact: contactLabel(r),
      lastMissedAt: toIso(r.last_missed_at),
      attempts: n(r.attempts),
      telecaller: s(r.telecaller),
      leadId: s(r.lead_id),
      leadTitle: s(r.lead_title),
    })),
  };
}
