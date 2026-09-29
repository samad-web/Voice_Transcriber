/**
 * The command centre - one page where an owner reads the floor, the sales
 * desk, the marketing spend and the quarter's targets against each other.
 *
 * ── WHY THIS IS NOT THE DASHBOARD ───────────────────────────────────────────
 *
 * `/owner` already composes a dashboard per persona (0079), and it is a good
 * one. It answers "how is my department doing" for whoever is reading. This
 * answers a different question - "are the departments pulling in the same
 * direction" - and it cannot be a sixth persona view for a structural reason:
 * every figure here is only meaningful NEXT TO one from another department.
 * Cost per lead is a marketing number until you put it beside the win rate on
 * the leads it bought, and a rep's call volume is an activity number until you
 * put it beside the pipeline that came out of it. The dashboard shows
 * departments; this shows the seams between them.
 *
 * ── AND WHY THE DERIVATIONS ARE HERE ────────────────────────────────────────
 *
 * Same reason `agent-scorecard.ts` states next door: these numbers are quoted
 * in a management meeting, and a conversion rate rounded one way on this page
 * and another on `/owner/reports` is two people arguing about the same
 * quarter. Everything that decides what a figure SAYS lives in this file.
 *
 * ── THE RULE EVERY FUNCTION HERE FOLLOWS ────────────────────────────────────
 *
 * `null` means "not enough to say", never zero. A campaign with four leads has
 * no cost per lead worth printing, and a quarter nobody set a target for is
 * not a quarter at 0% attainment. This is the same discipline the scorecard
 * and the staff roll-up hold themselves to, and it matters more here, not
 * less: these are the numbers budgets get moved on.
 */

import { type Attainment } from "./targets";

// ── Sample floors ────────────────────────────────────────────────────────────

/**
 * A campaign needs this many leads before its cost per lead is reported.
 *
 * Ten rather than the five used for a rep's rates, because the consequence is
 * different: a thin connect rate misleads one person about one morning, and a
 * thin cost-per-lead gets a campaign switched off. Two leads from a ₹40,000
 * spend reads as ₹20,000 a lead, and the honest answer is that nobody knows
 * yet.
 */
export const MIN_CAMPAIGN_LEADS = 10;

/** A conversion rate needs a base this size before it is printed. */
export const MIN_CONVERSION_BASE = 10;

// ── What the API returns ─────────────────────────────────────────────────────

/** One campaign's cost and what came back from it. */
export interface CampaignPerformance {
  id: string;
  name: string;
  channel: string | null;
  leads: number;
  won: number;
  wonValue: number;
  /** What it cost. `null` when nobody has recorded a spend for it. */
  spend: number | null;
}

/** One acquisition channel, rolled up across its campaigns. */
export interface ChannelPerformance {
  channel: string;
  leads: number;
  won: number;
  wonValue: number;
  spend: number | null;
}

/** How fast work moves through the pipeline. */
export interface PipelineVelocity {
  /** Deals closed won in the window - the base every figure here rests on. */
  wonDeals: number;
  /** Mean days from creation to win. Null below a usable base. */
  avgDaysToWin: number | null;
  /** Median, which is the one to quote: one enterprise deal skews the mean. */
  medianDaysToWin: number | null;
  /** Open pipeline value now. */
  openValue: number;
  openCount: number;
}

/** One person's line in the team roll-up, linking to their own scorecard. */
export interface TeamMemberLine {
  telecallerId: string;
  displayName: string;
  calls: number;
  connected: number;
  /** Mean AI quality score, or null below the scorecard's own sample floor. */
  qaScore: number | null;
  leads: number;
  won: number;
}

export interface PerformanceOverview {
  from: string;
  to: string;

  sales: {
    leadsCreated: number;
    won: number;
    lost: number;
    pipelineValue: number;
    wonValue: number;
    velocity: PipelineVelocity;
  };

  marketing: {
    campaigns: CampaignPerformance[];
    channels: ChannelPerformance[];
    /** Total recorded spend in the window. Null when nothing is recorded. */
    totalSpend: number | null;
    /**
     * False when no campaign carries a spend, so the page can say "no spend
     * recorded" rather than drawing an ROI column of dashes that reads like
     * a broken join.
     */
    spendRecorded: boolean;
  };

  team: TeamMemberLine[];

  /** The quarter's targets, from `sales_targets` (0050). */
  goals: Attainment[];
}

// ── Derived figures ──────────────────────────────────────────────────────────

/** A rate, or null when the base is too thin to carry one. */
export function shareOf(part: number, whole: number, minBase = MIN_CONVERSION_BASE): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole)) return null;
  if (whole < minBase || whole <= 0) return null;
  return part / whole;
}

/**
 * Lead-to-win conversion.
 *
 * Over leads CREATED in the window, which is the honest denominator for a
 * window report and also the pessimistic one: a lead created on the last day
 * has had no chance to convert. The page says so rather than quietly using a
 * lagged denominator, because every alternative - converting deals against
 * leads from an earlier window - invents a cohort the reader did not ask for.
 */
export function conversionRate(sales: PerformanceOverview["sales"]): number | null {
  return shareOf(sales.won, sales.leadsCreated);
}

/** Won as a share of closed (won + lost) - the rate a sales manager means. */
export function winRate(sales: PerformanceOverview["sales"]): number | null {
  return shareOf(sales.won, sales.won + sales.lost);
}

/**
 * What one lead cost.
 *
 * Null when the campaign has no recorded spend, and null again below
 * `MIN_CAMPAIGN_LEADS` - the two are different absences and the page words
 * them differently, but neither is a number.
 */
export function costPerLead(c: Pick<CampaignPerformance, "spend" | "leads">): number | null {
  if (c.spend == null || c.spend <= 0) return null;
  if (c.leads < MIN_CAMPAIGN_LEADS) return null;
  return c.spend / c.leads;
}

/**
 * Return on spend: won value per unit spent.
 *
 * ── WHY THIS IS A MULTIPLE AND NOT A PERCENTAGE "ROI" ───────────────────────
 *
 * True ROI is (gain - cost) / cost and needs the MARGIN on what was sold.
 * This platform stores deal value, not cost of goods, so a percentage here
 * would be return on REVENUE presented as return on profit - and it would
 * flatter every campaign by exactly the margin nobody entered. A multiple
 * ("3.2x spend") makes the thing being divided obvious, and the page labels it
 * as revenue rather than profit.
 *
 * Reported however few leads there are, unlike cost per lead: a campaign that
 * produced one deal worth ten times its spend is a fact about money that
 * already landed, not an estimate.
 */
export function returnOnSpend(
  c: Pick<CampaignPerformance, "spend" | "wonValue">,
): number | null {
  if (c.spend == null || c.spend <= 0) return null;
  return c.wonValue / c.spend;
}

/** Won deals as a share of the leads a campaign produced. */
export function campaignWinRate(c: Pick<CampaignPerformance, "won" | "leads">): number | null {
  return shareOf(c.won, c.leads, MIN_CAMPAIGN_LEADS);
}

/**
 * Campaigns worth a decision, best return first.
 *
 * Campaigns with no recorded spend sort LAST rather than first. With `null`
 * treated as zero they would top a "cheapest lead" ordering and an owner would
 * cut the campaign that is actually working in favour of one whose cost nobody
 * entered.
 */
export function rankedCampaigns(campaigns: CampaignPerformance[]): CampaignPerformance[] {
  return [...campaigns].sort((a, b) => {
    const ra = returnOnSpend(a);
    const rb = returnOnSpend(b);
    if (ra == null && rb == null) return b.leads - a.leads;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  });
}

// ── Reading a target ─────────────────────────────────────────────────────────

export type GoalStanding = "ahead" | "on-track" | "behind" | "at-risk";

/**
 * Where a target stands RIGHT NOW, against where a steady seller would be.
 *
 * ── WHY THIS IS NOT actual/target ───────────────────────────────────────────
 *
 * 40% of a quarterly number is excellent in week two and alarming in week
 * eleven, and a bare attainment percentage cannot tell those apart - which is
 * precisely why `Attainment` carries `pace` (target × periodElapsed). Every
 * judgement here is against pace, never against the raw target.
 *
 * The bands are deliberately wide. A target is a plan, and a seller 4% off
 * pace in week three is not "behind" in any sense worth putting a word to on a
 * page management reads.
 */
export function goalStanding(a: Pick<Attainment, "actual" | "pace" | "periodElapsed">): GoalStanding {
  // Before a period really starts, pace is ~0 and every ratio is meaningless.
  if (a.periodElapsed < 0.05) return "on-track";
  if (a.pace <= 0) return "on-track";
  const against = a.actual / a.pace;
  if (against >= 1.1) return "ahead";
  if (against >= 0.9) return "on-track";
  // "At risk" is reserved for late in a period, where the gap stops being
  // recoverable. The same 70% is a bad week in March and a lost quarter in
  // June, and the page should not use the same word for both.
  if (against < 0.75 && a.periodElapsed > 0.6) return "at-risk";
  return "behind";
}

/** The plain-words version, for the chip beside a target. */
export function goalStandingLabel(standing: GoalStanding): string {
  switch (standing) {
    case "ahead":
      return "Ahead of pace";
    case "on-track":
      return "On track";
    case "behind":
      return "Behind pace";
    case "at-risk":
      return "At risk";
  }
}

/**
 * The one sentence at the top of the command centre.
 *
 * Names what is actually true rather than reciting every number: how many
 * goals are off pace, and whether the money went anywhere. Returns the plain
 * output statement when there are no targets, which is the normal state of a
 * workspace nobody has set one in.
 */
export function overviewHeadline(o: PerformanceOverview): string {
  const behind = o.goals.filter((g) => {
    const s = goalStanding(g);
    return s === "behind" || s === "at-risk";
  }).length;

  if (o.goals.length === 0) {
    return `${o.sales.leadsCreated} new leads and ${o.sales.won} closed in this range. No targets are set for it.`;
  }
  if (behind === 0) {
    return `All ${o.goals.length} target${o.goals.length === 1 ? " is" : "s are"} at or ahead of pace.`;
  }
  return `${behind} of ${o.goals.length} target${o.goals.length === 1 ? "" : "s"} ${behind === 1 ? "is" : "are"} behind pace.`;
}
