import { z } from "zod";

/**
 * Call insights - the floor-wide read of every recorded call in a date range,
 * and the PDF that carries it off the platform.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The same report is drawn twice: once as the console page
 * (`/owner/insights`) and once as a PDF rendered in the API. Two renderers are
 * two chances to word a number differently, round it differently or divide it
 * by a different denominator - and a PDF that disagrees with the screen it was
 * downloaded from is worse than no PDF, because it is the copy that gets
 * forwarded. So everything that decides what a figure SAYS lives here: the
 * query window, the response contract, the derived rates, the formatting and
 * the written highlights. The two renderers only decide where it goes.
 *
 * ── WHAT IS AND IS NOT IN THE REPORT ────────────────────────────────────────
 *
 * Aggregates over `calls` and the AI read of each call (`transcripts
 * .intelligence`, `call_analytics`, `call_sop_results`), plus a short list of
 * calls worth a manager's attention. NEVER transcript text, and never a risk
 * flag's `snippet` - that field is a quote of what somebody said on a
 * customer's call, which is `recordings_listen` territory (see
 * owner-calls.controller.ts). The attention list carries the AI SUMMARY, which
 * is the same paraphrase the call log already shows owners and managers.
 */

// ── The window ──────────────────────────────────────────────────────────────

/** The presets the page offers. Anything else is a custom from/to range. */
export const CALL_INSIGHT_RANGES = [7, 30, 90] as const;
export const DEFAULT_CALL_INSIGHT_DAYS = 30;
/** A year and a day, so "this time last year" is always expressible. */
export const CALL_INSIGHTS_MAX_DAYS = 366;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date, not merely date-shaped. `2026-02-31` passes a regex
 * and then makes Postgres throw, which would surface as a 500 on a typo.
 */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Inclusive day count between two calendar dates. */
export function daysBetweenInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * The window a report covers. `relative` is "the last N days up to today in
 * the ORG's timezone" - resolved by the database (`org_reporting_today()`),
 * because neither the browser nor the web tier knows that timezone and a UTC
 * "today" is five and a half hours wrong on an Indian floor. `fixed` is an
 * explicit pair of calendar dates in that same timezone.
 */
export type CallInsightsWindow =
  | { kind: "relative"; days: number }
  | { kind: "fixed"; from: string; to: string };

const DateParam = z
  .string()
  .regex(ISO_DATE, "dates are YYYY-MM-DD")
  .refine(isCalendarDate, "not a calendar date");

export const CallInsightsQuery = z
  .object({
    days: z.coerce.number().int().min(1).max(CALL_INSIGHTS_MAX_DAYS).optional(),
    from: DateParam.optional(),
    to: DateParam.optional(),
    /** PDF only: `0` leaves the per-call attention list out of the file. */
    calls: z.enum(["0", "1"]).optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.from === undefined) !== (q.to === undefined)) {
      ctx.addIssue({ code: "custom", message: "from and to go together" });
      return;
    }
    if (q.from && q.to) {
      if (q.from > q.to) ctx.addIssue({ code: "custom", message: "from must not be after to" });
      else if (daysBetweenInclusive(q.from, q.to) > CALL_INSIGHTS_MAX_DAYS) {
        ctx.addIssue({ code: "custom", message: `a range is at most ${CALL_INSIGHTS_MAX_DAYS} days` });
      }
    }
  });
export type CallInsightsQuery = z.infer<typeof CallInsightsQuery>;

/** A parsed query as the window it describes. An explicit pair wins over `days`. */
export function callInsightsWindow(q: CallInsightsQuery): CallInsightsWindow {
  if (q.from && q.to) return { kind: "fixed", from: q.from, to: q.to };
  return { kind: "relative", days: q.days ?? DEFAULT_CALL_INSIGHT_DAYS };
}

/** The same window as query-string parameters, for links and the PDF proxy. */
export function callInsightsParams(window: CallInsightsWindow): URLSearchParams {
  return window.kind === "fixed"
    ? new URLSearchParams({ from: window.from, to: window.to })
    : new URLSearchParams({ days: String(window.days) });
}

// ── The vocabularies ────────────────────────────────────────────────────────

/**
 * The analyzer's outcome enum (packages/llm, analyzeConversation), in the order
 * a manager reads them: the live ones first, the dead ends after. A value the
 * model invented outside the enum folds into `other` rather than growing the
 * list - an unbounded category list is a chart nobody can read.
 */
export const CALL_OUTCOMES = [
  { key: "interested", label: "Interested" },
  { key: "follow_up", label: "Follow-up needed" },
  { key: "callback", label: "Callback requested" },
  { key: "not_interested", label: "Not interested" },
  { key: "no_answer", label: "No answer" },
  { key: "wrong_number", label: "Wrong number" },
  { key: "other", label: "Other" },
] as const;
export type CallOutcomeKey = (typeof CALL_OUTCOMES)[number]["key"];

export const CALL_SENTIMENTS = [
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
] as const;
export type CallSentimentKey = (typeof CALL_SENTIMENTS)[number]["key"];

/**
 * The quality bands, at the SAME thresholds the call chips use
 * (call-intel.tsx: >=70 solid, >=40 muted, below that flagged) - a call
 * called "strong" there must not be called "fair" here.
 */
export const QUALITY_BANDS = [
  { key: "strong", label: "Strong (70–100)", min: 70 },
  { key: "fair", label: "Fair (40–69)", min: 40 },
  { key: "weak", label: "Weak (0–39)", min: 0 },
] as const;

export function outcomeLabel(key: string): string {
  return CALL_OUTCOMES.find((o) => o.key === key)?.label ?? humanizeKey(key);
}

export function sentimentLabel(key: string): string {
  return CALL_SENTIMENTS.find((s) => s.key === key)?.label ?? humanizeKey(key);
}

/** `competitor_mention` -> "Competitor mention". */
export function humanizeKey(value: string): string {
  const t = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : value;
}

// ── The contract ────────────────────────────────────────────────────────────

/** The call-volume half of a period: the four console states plus airtime. */
export interface CallVolume {
  total: number;
  outgoing: number;
  /** Inbound with airtime. */
  answered: number;
  /** Inbound with no airtime - derived, the schema has no such status. */
  missed: number;
  /**
   * Calls we could not PROCESS. Deliberately overlaps the three above, exactly
   * as the dashboard's KPI row does - a failed transcode does not un-make the
   * phone call, and a missed-call count that shrank on a bad worker afternoon
   * would be the one number on the page that lied.
   */
  failed: number;
  /** Any direction, with airtime. */
  connected: number;
  talkSeconds: number;
}

/** One period's headline figures - the current range, or the one before it. */
export interface CallInsightsTotals extends CallVolume {
  /** Calls with an AI read (a sentiment). The denominator for every read-based share. */
  analyzed: number;
  positive: number;
  negative: number;
  /** Calls with a quality score. */
  scored: number;
  avgQuality: number | null;
  /** Calls the analyzer flagged for escalation risk. */
  riskCalls: number;
  /** Calls linked to a lead (calls.lead_id, 0094). */
  leadLinked: number;
}

export interface CallInsightsDay {
  date: string;
  outgoing: number;
  answered: number;
  missed: number;
  talkSeconds: number;
}

export interface CallInsightsHour {
  /** 0-23, in the org's reporting timezone. */
  hour: number;
  outgoing: number;
  answered: number;
  missed: number;
}

export interface CallInsightsPerson {
  /** Null for calls made from a handset nobody was named on. */
  telecallerId: string | null;
  name: string;
  calls: number;
  outgoing: number;
  answered: number;
  missed: number;
  connected: number;
  talkSeconds: number;
  analyzed: number;
  positive: number;
  scored: number;
  avgQuality: number | null;
  riskCalls: number;
  leadLinked: number;
}

export interface CallInsightsAttentionCall {
  id: string;
  startedAt: string;
  direction: string;
  durationS: number | null;
  telecaller: string | null;
  /** Contact name, else the privacy-lite number fragment, else "Unknown caller". */
  contact: string;
  sentiment: string | null;
  outcome: string | null;
  quality: number | null;
  risk: boolean;
  highRisk: boolean;
  riskCategories: string[];
  /** The AI summary, never the transcript. */
  summary: string | null;
  leadId: string | null;
  leadTitle: string | null;
  /** Why this call is on the list, in words. */
  reasons: string[];
}

export interface CallInsightsReport {
  org: { name: string; timezone: string };
  range: { from: string; to: string; days: number };
  /** The equal-length period immediately before `range`, for every delta. */
  previousRange: { from: string; to: string };
  generatedAt: string;
  current: CallInsightsTotals;
  previous: CallInsightsTotals;
  /** One entry per calendar day in `range`, zero-filled. */
  daily: CallInsightsDay[];
  /** Always 24 entries, zero-filled. */
  hourly: CallInsightsHour[];
  /** Always the three sentiments, in order. */
  sentiment: Array<{ key: CallSentimentKey; label: string; count: number }>;
  /** Always every outcome, in order - an empty bar is a finding too. */
  outcomes: Array<{ key: CallOutcomeKey; label: string; count: number }>;
  intents: { rows: Array<{ label: string; count: number }>; distinct: number };
  dispositions: { rows: Array<{ key: string; label: string; count: number }>; unset: number };
  quality: {
    scored: number;
    average: number | null;
    bands: { strong: number; fair: number; weak: number };
    criteria: {
      sample: number;
      scriptAdherence: number | null;
      professionalism: number | null;
      conversionSignal: number | null;
      /** 0-100. */
      consentDisclosedPct: number | null;
    };
  };
  talk: { sample: number; agentShare: number | null; interruptions: number | null };
  sop: { scored: number; adherence: number | null };
  risk: { calls: number; categories: Array<{ category: string; label: string; calls: number; high: number }> };
  people: CallInsightsPerson[];
  attention: CallInsightsAttentionCall[];
}

// ── Derived figures ─────────────────────────────────────────────────────────

/** n / d, or null when there is nothing to divide by. Never NaN, never Infinity. */
export function ratio(n: number, d: number): number | null {
  return d > 0 && Number.isFinite(n) ? n / d : null;
}

export interface CallInsightsKpis {
  /** Connected / all calls. */
  connectRate: number | null;
  /** Answered / inbound. */
  answerRate: number | null;
  /** Airtime per connected call, seconds. */
  avgCallSeconds: number | null;
  positiveShare: number | null;
  negativeShare: number | null;
  /** Share of calls with an AI read - the coverage every read-based figure rests on. */
  analyzedShare: number | null;
  leadShare: number | null;
}

export function callInsightsKpis(t: CallInsightsTotals): CallInsightsKpis {
  return {
    connectRate: ratio(t.connected, t.total),
    answerRate: ratio(t.answered, t.answered + t.missed),
    avgCallSeconds: ratio(t.talkSeconds, t.connected),
    positiveShare: ratio(t.positive, t.analyzed),
    negativeShare: ratio(t.negative, t.analyzed),
    analyzedShare: ratio(t.analyzed, t.total),
    leadShare: ratio(t.leadLinked, t.total),
  };
}

/**
 * How a COUNT moved against the previous period. Relative change, because "12
 * more calls" means nothing without the base; null percentage when the base is
 * zero, because "up ∞%" is not a number anybody should read aloud.
 */
export interface CountChange {
  diff: number;
  pct: number | null;
}

export function countChange(current: number, previous: number): CountChange {
  return { diff: current - previous, pct: previous > 0 ? (current - previous) / previous : null };
}

/**
 * How a RATE moved, in percentage points. A relative change of a percentage
 * ("connect rate up 12%") is ambiguous between 50%->56% and 50%->62%; points
 * are not.
 */
export function pointChange(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : (current - previous) * 100;
}

// ── Volume series ───────────────────────────────────────────────────────────

/** Past a quarter, a column per day is a texture rather than a chart. */
export const WEEKLY_AFTER_DAYS = 92;

export interface VolumeBucket {
  /** First calendar day in the bucket. */
  start: string;
  /** Last calendar day in the bucket (= start for a day). */
  end: string;
  outgoing: number;
  answered: number;
  missed: number;
  talkSeconds: number;
}

export interface VolumeSeries {
  unit: "day" | "week";
  buckets: VolumeBucket[];
  /**
   * Days in the last bucket when it is a short week, else 0. A short last week
   * draws as a sudden fall in volume; both renderers say so instead.
   */
  partialDays: number;
}

/**
 * The daily series as the page and the PDF chart it: per day up to
 * `WEEKLY_AFTER_DAYS`, per 7-day block from the range's first day after that.
 * One rule, so the two renderings of a report cannot bucket it differently.
 */
export function volumeSeries(daily: CallInsightsDay[]): VolumeSeries {
  if (daily.length <= WEEKLY_AFTER_DAYS) {
    return {
      unit: "day",
      buckets: daily.map((d) => ({ start: d.date, end: d.date, ...pickVolume(d) })),
      partialDays: 0,
    };
  }
  const buckets: VolumeBucket[] = [];
  for (let i = 0; i < daily.length; i += 7) {
    const week = daily.slice(i, i + 7);
    buckets.push({
      start: week[0].date,
      end: week[week.length - 1].date,
      outgoing: week.reduce((s, d) => s + d.outgoing, 0),
      answered: week.reduce((s, d) => s + d.answered, 0),
      missed: week.reduce((s, d) => s + d.missed, 0),
      talkSeconds: week.reduce((s, d) => s + d.talkSeconds, 0),
    });
  }
  return { unit: "week", buckets, partialDays: daily.length % 7 };
}

function pickVolume(d: CallInsightsDay) {
  return { outgoing: d.outgoing, answered: d.answered, missed: d.missed, talkSeconds: d.talkSeconds };
}

// ── Formatting - one wording for the page and the PDF ───────────────────────

/** 1284 -> "1,284". Fixed grouping rather than Intl, so server and PDF agree byte for byte. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.round(Math.abs(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A fraction as a percentage. A real but tiny share says "<1%", not "0%". */
export function formatShare(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (value > 0 && value < 0.005) return "<1%";
  return `${Math.round(value * 100)}%`;
}

/** Total airtime: "45m", "12h 04m", "1,204h". */
export function formatTalkTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 100) return `${formatCount(hours)}h`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** One call's length: "45s", "3m 05s". */
export function formatCallLength(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "+18%", "−7%", "no change"; "new" when there was nothing before. */
export function formatCountChange(change: CountChange): string {
  if (change.diff === 0) return "no change";
  if (change.pct === null) return "new";
  const pct = Math.round(change.pct * 100);
  if (pct === 0) return change.diff > 0 ? "+<1%" : "−<1%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
}

/** "+4 pts", "−1 pt", "no change". */
export function formatPointChange(points: number | null): string {
  if (points === null || !Number.isFinite(points)) return "–";
  const rounded = Math.round(points);
  if (rounded === 0) return "no change";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} pt${Math.abs(rounded) === 1 ? "" : "s"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15 Sep 2026" from `YYYY-MM-DD` - a fixed table, not Intl (ICU builds disagree on "Sep"/"Sept"). */
export function formatReportDate(date: string, withYear = true): string {
  const [year, month, day] = date.split("-").map(Number);
  const base = `${day} ${MONTHS[(month ?? 1) - 1] ?? ""}`;
  return withYear ? `${base} ${year}` : base;
}

/** "1 – 30 Sep 2026", "28 Aug – 26 Sep 2026", "15 Dec 2025 – 12 Jan 2026". */
export function formatReportRange(from: string, to: string): string {
  if (from === to) return formatReportDate(from);
  const [fy, fm] = from.split("-");
  const [ty, tm] = to.split("-");
  if (fy === ty && fm === tm) return `${Number(from.slice(8))} – ${formatReportDate(to)}`;
  if (fy === ty) return `${formatReportDate(from, false)} – ${formatReportDate(to)}`;
  return `${formatReportDate(from)} – ${formatReportDate(to)}`;
}

/** An hour slot as a person says it: 13 -> "1–2 PM", 11 -> "11 AM–12 PM". */
export function formatHourSlot(hour: number): string {
  const label = (h: number) => {
    const hh = ((h % 24) + 24) % 24;
    return { n: hh % 12 === 0 ? 12 : hh % 12, half: hh < 12 ? "AM" : "PM" };
  };
  const a = label(hour);
  const b = label(hour + 1);
  return a.half === b.half ? `${a.n}–${b.n} ${b.half}` : `${a.n} ${a.half}–${b.n} ${b.half}`;
}

/** A safe download name: "call-insights-rd-interlock-brick-2026-08-23-to-2026-09-21.pdf". */
export function callInsightsFilename(orgName: string, from: string, to: string): string {
  const slug = orgName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `call-insights${slug ? `-${slug}` : ""}-${from}-to-${to}.pdf`;
}

// ── Written highlights ──────────────────────────────────────────────────────

/**
 * Minimum samples before a share is worth a SENTENCE. A chart can show 2 of 3
 * calls as 67% and let the reader see the bar is tiny; a sentence saying
 * "67% of calls were positive" cannot, and it is the sentence that gets quoted.
 */
export const HIGHLIGHT_MIN_SAMPLE = 10;

/**
 * The report in a handful of sentences - the page's "Highlights" and the PDF's
 * summary. Each is a plain statement of something the figures below already
 * show; none is a recommendation, because the data knows what happened and
 * does not know why.
 *
 * Ordered by what an owner scans for first (volume, then missed business -
 * the red number - then the read of the conversations), and capped, because a
 * summary with twelve points is the report again.
 */
export function callInsightsHighlights(r: CallInsightsReport, max = 6): string[] {
  const out: string[] = [];
  const cur = r.current;
  const prev = r.previous;
  const k = callInsightsKpis(cur);
  const days = r.range.days;
  const period = `the previous ${days} day${days === 1 ? "" : "s"}`;

  if (cur.total === 0) {
    return [
      prev.total > 0
        ? `No calls were recorded in this period, against ${formatCount(prev.total)} in ${period}.`
        : "No calls were recorded in this period.",
    ];
  }

  // Volume.
  const volume = countChange(cur.total, prev.total);
  if (prev.total > 0 && volume.pct !== null && Math.abs(volume.pct) >= 0.05) {
    out.push(
      `${plural(cur.total, "call")}, ${volume.diff > 0 ? "up" : "down"} ${Math.abs(Math.round(volume.pct * 100))}% on ${period} (${formatCount(prev.total)}).`,
    );
  } else if (prev.total > 0) {
    out.push(`${plural(cur.total, "call")}, about the same as ${period} (${formatCount(prev.total)}).`);
  } else {
    out.push(`${plural(cur.total, "call")} in this period; none were recorded in ${period}.`);
  }

  // Missed business, with where it clusters.
  if (cur.missed > 0) {
    const inbound = cur.answered + cur.missed;
    let sentence = `${plural(cur.missed, "inbound call")} went unanswered (${formatShare(ratio(cur.missed, inbound))} of inbound).`;
    const peak = [...r.hourly].sort((a, b) => b.missed - a.missed || a.hour - b.hour)[0];
    if (peak && peak.missed >= 3 && peak.missed / cur.missed >= 0.2) {
      sentence += ` The most, ${formatCount(peak.missed)}, came in ${formatHourSlot(peak.hour)}.`;
    }
    out.push(sentence);
  }

  // Connect rate, only when it genuinely moved.
  const connectMove = pointChange(k.connectRate, callInsightsKpis(prev).connectRate);
  if (connectMove !== null && Math.abs(connectMove) >= 5 && prev.total >= HIGHLIGHT_MIN_SAMPLE) {
    out.push(
      `Connect rate ${connectMove > 0 ? "rose" : "fell"} ${Math.abs(Math.round(connectMove))} points to ${formatShare(k.connectRate)}.`,
    );
  }

  // The read of the conversations - only on a sample worth a sentence.
  if (cur.analyzed >= HIGHLIGHT_MIN_SAMPLE) {
    out.push(
      `${formatShare(k.positiveShare)} of analysed calls read positive and ${formatShare(k.negativeShare)} negative.`,
    );
    const top = [...r.outcomes]
      .filter((o) => o.key !== "other" && o.count > 0)
      .sort((a, b) => b.count - a.count)[0];
    if (top) {
      out.push(
        `The most common result was “${top.label}” (${plural(top.count, "call")}, ${formatShare(ratio(top.count, cur.analyzed))} of analysed).`,
      );
    }
  }

  if (r.quality.scored >= HIGHLIGHT_MIN_SAMPLE && r.quality.average !== null) {
    let sentence = `Average quality score ${Math.round(r.quality.average)}/100`;
    sentence += r.quality.bands.weak > 0 ? `; ${plural(r.quality.bands.weak, "call")} scored below 40.` : ".";
    out.push(sentence);
  }

  if (r.risk.calls > 0) {
    const top = r.risk.categories[0];
    out.push(
      `${plural(r.risk.calls, "call")} ${r.risk.calls === 1 ? "was" : "were"} flagged for escalation risk${top ? `, most often “${top.label.toLowerCase()}”` : ""}.`,
    );
  }

  // The honesty line: every read-based figure above rests on this coverage, so
  // it is the one sentence the cap may never drop - it takes the last slot.
  if (k.analyzedShare !== null && k.analyzedShare < 0.8) {
    return [
      ...out.slice(0, Math.max(0, max - 1)),
      `Only ${formatShare(k.analyzedShare)} of calls have an AI read (the rest were missed, failed, are still processing, or were not transcribed), so the conversation figures describe that share.`,
    ];
  }

  return out.slice(0, max);
}

function plural(n: number, noun: string): string {
  return `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;
}
