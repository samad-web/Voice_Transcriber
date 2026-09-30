/**
 * The agent scorecard - one telecaller's own numbers, output beside quality.
 *
 * ── WHY THE DERIVATIONS LIVE HERE AND NOT IN THE PAGE ───────────────────────
 *
 * Same reason `call-insights.ts` states next door: the scorecard is read in
 * two places that must not disagree. The rep reads it on
 * `/owner/my-performance`, and a manager reads the same person's row on
 * `/owner/productivity` and in the staff scorecard. A connect rate rounded one
 * way on the rep's page and another on the manager's is not a cosmetic bug -
 * it is the two of them sitting in a review quoting different numbers off the
 * same week. So everything that decides what a figure SAYS is here; the
 * renderers only decide where it goes.
 *
 * ── THE FOUR QUALITY SIGNALS ARE NOT ONE NUMBER, DELIBERATELY ───────────────
 *
 * There is a standing temptation to average QA, CSAT and FCR into a single
 * "agent score" and rank the floor by it. This file will not produce one, and
 * the reason is not taste:
 *
 *   - They have different denominators. QA is over calls the AI could score,
 *     CSAT over calls that produced a sentiment read, FCR over first contacts
 *     that were dispositioned. Averaging three rates computed over three
 *     different subsets produces a number that is not a rate over anything.
 *   - They move in opposite directions on purpose. A rep who resolves more
 *     calls on the first contact makes fewer calls. A composite hides exactly
 *     the trade-off the page exists to show.
 *
 * ── EVERY RATE CAN REFUSE TO ANSWER ─────────────────────────────────────────
 *
 * `null` throughout means "not enough to say", never zero. A rep with three
 * scored calls has no QA average, and printing one anyway is how a dashboard
 * earns a reputation for lying. This is the same rule 0090, 0091 and the staff
 * scorecard already hold themselves to, and the page renders every null as a
 * dash with the reason beside it.
 */

import { MIN_CONVERSION_BASE } from "./performance-overview";

// ── Sample floors ────────────────────────────────────────────────────────────

/**
 * Below this many contributing calls a rate is reported as `null`.
 *
 * Five, matching `rateText`'s `minBase` in the web app's dashboard-charts, so
 * the scorecard and the dashboard suppress a thin number at the same point.
 * On a daily view this bites often and is supposed to: at 9 AM a rep has made
 * two calls, and "connect rate 50%" is noise presented as performance.
 */
export const MIN_RATE_SAMPLE = 5;

/**
 * Quality needs a larger sample than volume before it means anything. A single
 * bad call moves a three-call QA average by 30 points, and the rep it is shown
 * to has no way to act on that.
 */
export const MIN_QUALITY_SAMPLE = 8;

/**
 * A personal conversion rate needs this many leads behind it - and it is the
 * SAME floor the whole-desk rate uses, imported rather than restated.
 *
 * `performance-overview.ts` owns the constant. A rep's own conversion rate and
 * their manager's desk-wide one are read in the same conversation, so the moment
 * a figure appears on one page it has to appear on the other; two constants that
 * happened to both say 10 would drift the first time somebody tuned one of them.
 *
 * Higher than MIN_RATE_SAMPLE (5) because the consequence is different: a thin
 * connect rate misleads one person about one morning, and a thin conversion rate
 * gets quoted back in a review.
 *
 * Imported, not re-exported: `index.ts` does `export *` over both files, and a
 * name coming out of two of them is ambiguous to every consumer.
 */

/**
 * Days a lead may sit in one stage before the page calls it stalled.
 *
 * The default, used when the workspace has not set its own. Fourteen matches
 * the third of `AGING_BUCKETS` (8-15 days) rather than being picked freshly
 * here, so "stalled" on this page and "getting old" on the aging report do not
 * describe two different leads.
 */
export const DEFAULT_STAGE_SLA_DAYS = 14;

// ── What the API returns ─────────────────────────────────────────────────────

/** One day of this person's activity, oldest first. Drives the trend strip. */
export interface ScorecardDay {
  /** Calendar date in the org's reporting timezone, `YYYY-MM-DD`. */
  day: string;
  calls: number;
  connected: number;
  talkSeconds: number;
}

/** How the customer's own sentiment read across the range. The CSAT base. */
export interface SentimentCounts {
  positive: number;
  neutral: number;
  negative: number;
}

/**
 * The per-criterion QA breakdown, averaged over the range.
 *
 * `consentRate` is a share (0-1) because its underlying field is a boolean;
 * the other three are the model's 0-10 scales, kept on their own scale rather
 * than rescaled to 100 so they read as the same numbers the call drawer shows.
 */
export interface QaCriteria {
  consentRate: number | null;
  scriptAdherence: number | null;
  professionalism: number | null;
  conversionSignal: number | null;
}

// ── The four halves the page grew (the analytics overhaul) ───────────────────
//
// The card used to be calls and the AI's read of them, which is a complete
// picture of a telecaller's DAY and half a picture of their JOB. A rep is
// answerable for what came out of the dialling - leads that converted,
// follow-ups they promised, work that went cold in their name - and none of
// those are call metrics. The four blocks below are that other half.
//
// ── THE ONE JOIN THAT MAKES IT POSSIBLE, AND ITS HONEST LIMIT ────────────────
//
// A lead belongs to a `telecallers` row; a task belongs to a `users` row; and
// migration 0093's header states plainly that nothing maps between them, which
// is why response time is reported per telecaller and follow-up compliance per
// user and the two are never joined into one row.
//
// The bridge exists - `telecallers.user_id` (0017) - and it is NULLABLE. So
// this card takes the join where the tenant has made it and says so where they
// have not, rather than inventing a mapping. `TaskLoad.linked` is that
// admission, and the page renders an unlinked reader's task tiles as "not
// linked" rather than as zeroes. A rep with no platform login has no tasks, and
// reporting that as perfect compliance would be the worst available answer.

/** What came out of the dialling: the leads this person is answerable for. */
export interface PipelineOwnership {
  /**
   * Leads attributed to or assigned to this person that were CREATED in the
   * window - the same cohort denominator `conversionRate` uses on the
   * management page, and the same pessimistic one: a lead created on the last
   * day of the range has had no chance to convert.
   */
  leadsWorked: number;
  won: number;
  lost: number;
  /** Still open out of `leadsWorked` - not this person's whole open book. */
  open: number;
  /** Value of the won ones. May be 0 in a workspace that records no value. */
  wonValue: number;
}

/**
 * Follow-ups: what was promised, what was kept.
 *
 * `completed` is windowed (completed IN the range); `overdue`, `dueToday` and
 * `openTotal` are as they stand NOW. That mix is deliberate and the page labels
 * it: "how many did I finish last week" and "how much am I behind on" are both
 * questions a rep opens this page with, and windowing the second would report
 * a clean slate to somebody with nine overdue tasks from March.
 */
export interface TaskLoad {
  /**
   * False when this telecaller has no `users` row behind them. Every count
   * below is then 0 and means nothing - see the block comment above.
   */
  linked: boolean;
  completed: number;
  /** Open, and its due date has passed in the org's own calendar. */
  overdue: number;
  dueToday: number;
  /** Every open task on them, overdue or not - the workload, not the failure. */
  openTotal: number;
}

/**
 * Time-in-stage: the leads going quiet in this person's name.
 *
 * ── WHY THIS IS A COUNT AND NOT AN AVERAGE ──────────────────────────────────
 *
 * "Average days in stage: 9" is unactionable - there is nothing to open. A
 * count of leads past the threshold is a work queue, and the page links to it.
 * `worstDays`/`worstStage` name the single oldest one, because that is the
 * lead somebody should touch first.
 */
export interface StageSla {
  /** Open leads held by this person sitting past `thresholdDays` in one stage. */
  breached: number;
  /** Their whole open book - the denominator for `slaCompliance`. */
  open: number;
  worstDays: number | null;
  worstStage: string | null;
  /** The workspace's own threshold, or DEFAULT_STAGE_SLA_DAYS. */
  thresholdDays: number;
  /**
   * Open leads on them that nobody has responded to at all, past the org's
   * response SLA (0093/0109). A different and worse failure than a stalled
   * lead: that one was worked and went quiet, this one was never picked up.
   */
  unanswered: number;
}

/**
 * Today, for the progress tracker at the top of the page.
 *
 * ── WHERE `pace` COMES FROM, AND WHY IT IS NOT A TARGET ─────────────────────
 *
 * Nobody sets a daily call target in this platform - `sales_targets` (0050)
 * carries `won_value` and `won_count` and nothing else - so a tracker reading
 * "38 of 60" would be quoting a number the tenant never agreed to, on a screen
 * a rep is measured by. That is worse than no tracker.
 *
 * `pace` is therefore a DESCRIPTION, not a quota: the floor's median calls on a
 * day somebody worked, or this person's own median across the range when the
 * floor is too small to publish one (the same MIN_PEER_FLOOR rule that governs
 * `peer`). `paceSource` travels with it so the page can say which, in words,
 * every time it draws the bar. Null means there is nothing honest to compare
 * against and the tracker shows the count alone.
 */
export interface TodayProgress {
  /** The org's today in its reporting zone, `YYYY-MM-DD`. */
  day: string;
  calls: number;
  connected: number;
  pace: number | null;
  paceSource: "floor" | "own" | null;
  /** False when `day` falls outside the range being viewed - see `showTracker`. */
  inRange: boolean;
}

/** Everything the scorecard endpoint answers with, for exactly one person. */
export interface AgentScorecard {
  telecallerId: string;
  displayName: string;
  from: string;
  to: string;

  // ── Output ────────────────────────────────────────────────────────────────
  calls: number;
  connected: number;
  talkSeconds: number;
  activeDays: number;
  days: ScorecardDay[];

  // ── Quality ───────────────────────────────────────────────────────────────
  /** Mean `call_analytics.quality_score`, 0-100, over `qaScoredCalls`. */
  qaScore: number | null;
  qaScoredCalls: number;
  qaCriteria: QaCriteria;
  /** Mean SOP adherence (0091), 0-100, over `sopScoredCalls`. */
  sopAdherence: number | null;
  sopScoredCalls: number;

  sentiment: SentimentCounts;
  sentimentReadCalls: number;

  /** First contacts that carried a disposition - the FCR denominator. */
  fcrEligibleCalls: number;
  /** Of those, how many were marked with a resolving disposition. */
  fcrResolvedCalls: number;
  /**
   * False when no disposition in this org asserts resolution (0144). The page
   * must then say "not configured" rather than render 0%.
   */
  fcrConfigured: boolean;

  // ── Pipeline, follow-ups and time ─────────────────────────────────────────
  pipeline: PipelineOwnership;
  tasks: TaskLoad;
  sla: StageSla;
  today: TodayProgress;

  /** The floor's midpoint for the same window, for context, never a target. */
  peer: PeerMedians;
}

/** The floor's medians. Every field is null for a floor of one. */
export interface PeerMedians {
  calls: number | null;
  connectRate: number | null;
  avgCallSeconds: number | null;
  qaScore: number | null;
  csat: number | null;
  fcrRate: number | null;
  /** The floor's own lead-to-won rate, so a rep's conversion has a reference. */
  conversionRate: number | null;
  /** Median calls on a day somebody worked - the tracker's `pace`. */
  callsPerActiveDay: number | null;
}

// ── Derived rates ────────────────────────────────────────────────────────────

/** A rate, or null when the base is too thin to carry one. */
export function rate(part: number, whole: number, minBase = MIN_RATE_SAMPLE): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole)) return null;
  if (whole < minBase || whole <= 0) return null;
  return part / whole;
}

/** Share of dialled calls that reached a human. */
export function connectRate(card: Pick<AgentScorecard, "calls" | "connected">): number | null {
  return rate(card.connected, card.calls);
}

/**
 * Mean seconds of a CONNECTED call.
 *
 * Over connected calls and never over all calls: a floor with a 30% connect
 * rate would otherwise report an average duration two-thirds composed of rings
 * that nobody answered, which trends downward exactly when a rep is dialling
 * more - the opposite of what the number is read as meaning.
 */
export function avgCallSeconds(
  card: Pick<AgentScorecard, "connected" | "talkSeconds">,
): number | null {
  if (card.connected < MIN_RATE_SAMPLE || card.connected <= 0) return null;
  return card.talkSeconds / card.connected;
}

/**
 * CSAT as a 0-100 index over the calls whose transcript carried a sentiment
 * read: positive counts 100, neutral 50, negative 0.
 *
 * ── WHAT THIS NUMBER IS, AND WHAT IT IS NOT ─────────────────────────────────
 *
 * Nobody asked the customer anything. This is the analyse stage's read of how
 * the call FELT, on the same transcript the QA score comes from, and it is a
 * proxy for satisfaction rather than a measurement of it. The page says so
 * next to the tile, and the raw positive/neutral/negative counts travel with
 * the index everywhere it goes so the shape behind it is never hidden.
 *
 * Neutral scores 50 rather than 0 because the alternative - "satisfied or
 * not" - makes the index a measure of how demonstrative customers were. Most
 * business calls end neutral, and a floor doing competent unremarkable work
 * would read 15%.
 */
export function csatIndex(counts: SentimentCounts): number | null {
  const base = counts.positive + counts.neutral + counts.negative;
  if (base < MIN_RATE_SAMPLE) return null;
  return ((counts.positive * 100 + counts.neutral * 50) / base) | 0;
}

/**
 * First-call resolution.
 *
 * Null when the tenant has not said which outcomes resolve (0144) - distinct
 * from 0, and the page words the two differently. Also null on a thin base,
 * like every other rate here.
 */
export function fcrRate(
  card: Pick<AgentScorecard, "fcrEligibleCalls" | "fcrResolvedCalls" | "fcrConfigured">,
): number | null {
  if (!card.fcrConfigured) return null;
  return rate(card.fcrResolvedCalls, card.fcrEligibleCalls);
}

/** QA is suppressed below its own, larger, sample floor. */
export function qaScore(card: Pick<AgentScorecard, "qaScore" | "qaScoredCalls">): number | null {
  if (card.qaScoredCalls < MIN_QUALITY_SAMPLE) return null;
  return card.qaScore;
}

// ── Pipeline, follow-ups and time ────────────────────────────────────────────

/**
 * This person's lead-to-won rate.
 *
 * Over leads CREATED in the window, matching `conversionRate` on the management
 * page exactly - the two are read in the same conversation and a rep whose own
 * page says 14% while their manager's says 11% has been handed an argument
 * instead of a number.
 *
 * Null below MIN_CONVERSION_BASE. A rep with four leads has no conversion rate,
 * and "25%" off one win is the kind of figure that gets quoted back.
 */
export function leadConversionRate(p: PipelineOwnership): number | null {
  return rate(p.won, p.leadsWorked, MIN_CONVERSION_BASE);
}

/**
 * Win rate over leads this person CLOSED either way - the other honest reading,
 * and the one to quote when the window is short.
 *
 * Kept separate from `leadConversionRate` rather than replacing it: they answer
 * different questions and move in opposite directions on a rep who is good at
 * qualifying out early. A rep who disqualifies fast has a high win rate and a
 * low conversion rate, and both facts are true.
 */
export function leadWinRate(p: PipelineOwnership): number | null {
  return rate(p.won, p.won + p.lost, MIN_RATE_SAMPLE);
}

/**
 * Follow-up compliance: kept promises over promises whose time has come.
 *
 * ── THE DENOMINATOR IS THE WHOLE POINT ──────────────────────────────────────
 *
 * `completed / (completed + overdue)`, never `completed / openTotal`. A task due
 * next Friday is not evidence of anything yet, and counting it against somebody
 * means a rep who plans a week ahead scores worse than one who plans nothing.
 *
 * This is the single definition of the ratio on the platform:
 * `apps/api/src/modules/reports/sla.ts`'s `compliancePct` is this function
 * multiplied out to a percentage. Two implementations of "compliant" is an
 * argument nobody can settle, and the follow-up compliance report and a rep's
 * own tile are read side by side in exactly the meeting where it would start.
 *
 * Null - never 0 - when nothing was due. "No tasks came due" and "every task
 * that came due was missed" are opposite facts.
 */
export function taskCompliance(t: Pick<TaskLoad, "completed" | "overdue">): number | null {
  const settled = t.completed + t.overdue;
  if (settled <= 0) return null;
  return t.completed / settled;
}

/**
 * Share of this person's open book that is NOT stalled.
 *
 * Phrased positively because the tile reads as a compliance figure beside the
 * other rates, and because the count of breaches is already on the page next to
 * it - the number and its complement say the same thing, and the page needs the
 * one that sorts the same direction as everything around it.
 *
 * Null on an empty book: a rep holding no open leads is not 100% compliant, they
 * are not holding any leads.
 */
export function slaCompliance(sla: Pick<StageSla, "breached" | "open">): number | null {
  if (sla.open <= 0) return null;
  return (sla.open - sla.breached) / sla.open;
}

/**
 * Whether the daily tracker should be drawn at all.
 *
 * Only when today is inside the range being viewed. On a "1 - 30 June" range
 * read in September, "3 calls today" is true, irrelevant, and sitting directly
 * above numbers from June - which is how a reader concludes the whole page is
 * about today.
 */
export function showTracker(today: TodayProgress): boolean {
  return today.inRange;
}

/**
 * The tracker's fill, 0-1, clamped - so a rep past the floor's typical day gets
 * a full bar rather than one overflowing its track.
 *
 * Null when there is no pace to measure against, and the page then prints the
 * count with no bar at all rather than a bar that is secretly a fraction of
 * nothing.
 */
export function trackerFill(today: TodayProgress): number | null {
  if (today.pace == null || today.pace <= 0) return null;
  return Math.min(1, today.calls / today.pace);
}

/** "the floor's typical day" / "your own typical day" - the words under the bar. */
export function paceLabel(source: TodayProgress["paceSource"]): string | null {
  switch (source) {
    case "floor":
      return "the floor's typical day";
    case "own":
      return "your own typical day";
    default:
      return null;
  }
}

// ── Comparison against the floor ─────────────────────────────────────────────

export type PeerStanding = "above" | "at" | "below" | "unknown";

/**
 * Where this person sits against the floor's midpoint.
 *
 * Within 10% of the median is "at" - the same band `/owner/productivity`
 * already uses, so the two pages do not disagree about whether somebody is
 * typical. Returned as a word and never as a colour: the productivity page
 * sets out at length why a red badge on a call count is a verdict the data
 * does not support, and this page is read by the person it is about.
 */
export function standing(
  value: number | null,
  median: number | null,
  moreIsBetter = true,
): PeerStanding {
  if (value == null || median == null || median === 0) return "unknown";
  const delta = (value - median) / Math.abs(median);
  if (Math.abs(delta) < 0.1) return "at";
  const higher = delta > 0;
  return higher === moreIsBetter ? "above" : "below";
}

// ── What to work on today ────────────────────────────────────────────────────

/** One thing this person could do differently, strongest signal first. */
export interface FocusArea {
  /** Stable id, so a test names one without matching prose. */
  key: string;
  /** The heading - what the signal is. */
  title: string;
  /** One sentence: what the number is, and what to do about it. */
  detail: string;
  /** How many calls the signal rests on, for the reader to weigh it. */
  base: number;
}

/**
 * The page's bottom panel: at most three things, derived rather than written.
 *
 * ── WHY IT IS CAPPED AND ORDERED ────────────────────────────────────────────
 *
 * A list of nine weaknesses is not actionable, it is demoralising, and a rep
 * reads it once and never again. Three is what somebody can hold for a shift.
 * Ordering is by how much evidence sits behind the signal, not by how bad it
 * is: a 4/10 professionalism average over sixty calls is a real pattern, and
 * the same 4 over nine calls is probably two bad afternoons.
 *
 * ── AND WHY EVERY BRANCH NEEDS A SAMPLE ─────────────────────────────────────
 *
 * Every rule below tests a count before it tests a value. Coaching somebody on
 * a number that came from four calls is how this panel becomes something people
 * learn to scroll past.
 */
export function focusAreas(card: AgentScorecard): FocusArea[] {
  const found: FocusArea[] = [];
  const { qaCriteria: c } = card;

  if (card.qaScoredCalls >= MIN_QUALITY_SAMPLE) {
    if (c.consentRate != null && c.consentRate < 0.9) {
      found.push({
        key: "consent",
        title: "Say the call is recorded",
        detail: `The recording notice was heard on ${Math.round(c.consentRate * 100)}% of your scored calls. It belongs in the opening line of every one.`,
        // Weighted above everything else below: this one is a compliance
        // obligation, not a performance preference, so it leads whenever it
        // fires regardless of how much evidence the others carry.
        base: Number.MAX_SAFE_INTEGER,
      });
    }
    if (c.scriptAdherence != null && c.scriptAdherence < 6) {
      found.push({
        key: "script",
        title: "Follow the call procedure",
        detail: `Script adherence is averaging ${c.scriptAdherence.toFixed(1)}/10. Open a recent call to see which steps were missed.`,
        base: card.qaScoredCalls,
      });
    }
    if (c.professionalism != null && c.professionalism < 6) {
      found.push({
        key: "professionalism",
        title: "Let the customer finish",
        detail: `Tone and courtesy are averaging ${c.professionalism.toFixed(1)}/10, which is usually talking over the customer rather than what was said.`,
        base: card.qaScoredCalls,
      });
    }
    if (c.conversionSignal != null && c.conversionSignal < 6) {
      found.push({
        key: "conversion",
        title: "Ask for the next step",
        detail: `Calls are ending without a clear next step (${c.conversionSignal.toFixed(1)}/10). Name a time before you hang up.`,
        base: card.qaScoredCalls,
      });
    }
  }

  const negShare = rate(card.sentiment.negative, card.sentimentReadCalls);
  if (negShare != null && negShare > 0.2) {
    found.push({
      key: "sentiment",
      title: "More calls ending badly than usual",
      detail: `${Math.round(negShare * 100)}% of your calls read as negative. Listen back to two of them before your next shift.`,
      base: card.sentimentReadCalls,
    });
  }

  const fcr = fcrRate(card);
  if (fcr != null && card.peer.fcrRate != null && standing(fcr, card.peer.fcrRate) === "below") {
    found.push({
      key: "fcr",
      title: "Fewer calls settled first time",
      detail: `You resolve ${Math.round(fcr * 100)}% on first contact against the floor's ${Math.round(card.peer.fcrRate * 100)}%. Callbacks cost you dials.`,
      base: card.fcrEligibleCalls,
    });
  }

  const connect = connectRate(card);
  if (
    connect != null &&
    card.peer.connectRate != null &&
    standing(connect, card.peer.connectRate) === "below"
  ) {
    found.push({
      key: "connect",
      title: "Try calling at different times",
      detail: `You reach ${Math.round(connect * 100)}% of the numbers you dial against the floor's ${Math.round(card.peer.connectRate * 100)}%. The hours you dial in are usually why.`,
      base: card.calls,
    });
  }

  return found.sort((a, b) => b.base - a.base).slice(0, 3);
}

/**
 * The one sentence at the top of the page.
 *
 * Says what today looks like against the floor without ranking anybody, and
 * falls back to a plain statement of output when there is not enough to
 * compare - which is the normal state of the page first thing in the morning.
 */
export function headline(card: AgentScorecard): string {
  if (card.calls === 0) return "No calls logged in this range yet.";
  const connect = connectRate(card);
  const parts = [`${card.calls} call${card.calls === 1 ? "" : "s"}`];
  if (connect != null) parts.push(`${Math.round(connect * 100)}% connected`);
  const qa = qaScore(card);
  if (qa != null) parts.push(`quality ${qa}/100`);
  return `${parts.join(" · ")}.`;
}

// ── What is waiting, as opposed to what to work on ───────────────────────────

/**
 * One piece of work sitting undone, with somewhere to go and do it.
 *
 * ── WHY THIS IS NOT THREE MORE `focusAreas` ─────────────────────────────────
 *
 * `focusAreas` is COACHING: patterns the AI heard, capped at three, ordered by
 * how much evidence sits behind each one because a 4/10 over nine calls is
 * probably two bad afternoons. Every rule there tests a sample size first.
 *
 * These are not that. "Four people enquired and nobody called them back" needs
 * no sample to be true, cannot be argued with, and has a queue to open. Putting
 * it through `focusAreas` would have meant either giving it a fake `base` to win
 * the ordering, or letting a tone average outrank a customer nobody rang. It
 * would also compete for the same three slots, and the cap exists so a rep can
 * hold the coaching list for a shift - not so that real work gets crowded out
 * of it.
 *
 * So the page has two panels: this one, which is a to-do list, and that one,
 * which is a review. They are never merged.
 */
export interface WorkQueueItem {
  key: "unanswered" | "overdue" | "stalled" | "due-today";
  /** The count, so the renderer can size and pluralise without re-deriving. */
  count: number;
  title: string;
  detail: string;
  /** Where to go. A console path, or null when the card cannot narrow to a list. */
  href: string | null;
}

/**
 * This person's queue, worst first.
 *
 * Ordered by how badly the customer is being let down, not by count: one lead
 * nobody has answered at all outranks nine that have gone quiet, because the
 * second group has at least been spoken to. An empty array is the good and
 * common case, and the page says so in a sentence rather than rendering nothing.
 *
 * Every item that can point at a filtered list does. A number a rep cannot act
 * on from the page it appears on is how a dashboard becomes something people
 * stop opening (the Hawcus reading: every dashboard number is a filter into a
 * work queue).
 */
export function workQueue(card: AgentScorecard): WorkQueueItem[] {
  const items: WorkQueueItem[] = [];
  const s = card.sla;
  const t = card.tasks;

  if (s.unanswered > 0) {
    items.push({
      key: "unanswered",
      count: s.unanswered,
      title: `${s.unanswered} lead${s.unanswered === 1 ? "" : "s"} with no response yet`,
      detail:
        s.unanswered === 1
          ? "Somebody enquired and has had no reply at all. This is the first call to make."
          : `${s.unanswered} people enquired and have had no reply at all. These are the first calls to make.`,
      // `responded=no` is the leads list's own filter on 0093's
      // `first_responded_at`, so the count here and the rows there are the same
      // predicate. A scoped reader's own persona filter narrows it to their
      // book on arrival - this link carries no telecaller id and does not need
      // one.
      href: "/owner/leads?responded=no",
    });
  }

  if (t.linked && t.overdue > 0) {
    items.push({
      key: "overdue",
      count: t.overdue,
      title: `${t.overdue} follow-up${t.overdue === 1 ? "" : "s"} past due`,
      detail:
        t.overdue === 1
          ? "A promise you made has gone past its date. Close it, or move the date - an open task nobody will do is worse than no task."
          : `${t.overdue} promises you made have gone past their dates. Close them, or move the dates - open tasks nobody will do are worse than none.`,
      href: "/owner/tasks?who=mine&due=overdue",
    });
  }

  if (s.breached > 0) {
    // `worstDays` is null only if the count came from somewhere the age did not,
    // which should not happen - the sentence drops that clause rather than
    // printing "for null days".
    const oldest =
      s.worstDays != null
        ? ` The oldest has been there ${s.worstDays} days${s.worstStage ? ` in ${s.worstStage}` : ""}.`
        : "";
    items.push({
      key: "stalled",
      count: s.breached,
      title: `${s.breached} lead${s.breached === 1 ? "" : "s"} gone quiet`,
      detail: `${s.breached === 1 ? "One lead has" : `${s.breached} leads have`} sat in the same stage for more than ${s.thresholdDays} days.${oldest} Move ${s.breached === 1 ? "it" : "them"} on, or mark ${s.breached === 1 ? "it" : "them"} lost.`,
      // The threshold travels in the URL, so the list applies the SAME number
      // this card counted against. Hardcoding a "stalled" keyword on the list
      // would have been a second definition of the threshold, and the first
      // time somebody tuned one of them the tile and the list it opens would
      // have disagreed about which leads are stuck.
      href: `/owner/leads?stalledDays=${s.thresholdDays}`,
    });
  }

  if (t.linked && t.dueToday > 0) {
    items.push({
      key: "due-today",
      count: t.dueToday,
      title: `${t.dueToday} follow-up${t.dueToday === 1 ? "" : "s"} due today`,
      // Last, and worded as a plan rather than a failure: nothing has gone
      // wrong here yet, and a queue that scolds somebody for work that is not
      // late teaches them to ignore the panel.
      detail: `Still on time. ${t.dueToday === 1 ? "It is" : "They are"} due before the end of today.`,
      href: "/owner/tasks?who=mine&due=today",
    });
  }

  return items;
}

/**
 * The one sentence under the queue: what this person is carrying, in words.
 *
 * Deliberately separate from `headline`, which states OUTPUT (calls, connect
 * rate, quality) and is the top line of the page. This states LOAD. Merging them
 * produced a sentence nobody finished reading.
 */
export function loadHeadline(card: AgentScorecard): string {
  const parts: string[] = [];
  if (card.sla.open > 0) {
    parts.push(`${card.sla.open} open lead${card.sla.open === 1 ? "" : "s"}`);
  }
  if (card.tasks.linked && card.tasks.openTotal > 0) {
    parts.push(`${card.tasks.openTotal} open follow-up${card.tasks.openTotal === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return "Nothing open in your name right now.";
  return `You are carrying ${parts.join(" and ")}.`;
}
