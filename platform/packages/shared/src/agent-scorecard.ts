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
