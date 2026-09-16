import { z } from "zod";
import { LeadSourceChannel } from "./lead-intake";

/**
 * Automated lead distribution (migration 0094) - the PURE half.
 *
 * ── WHAT THIS FILE IS ─────────────────────────────────────────────────────
 *
 * Everything about "who gets the next lead" that does not need a database: the
 * rule shape, whether a rule matches a lead, and the pick itself. The half
 * that reads and writes state lives in `@aura/db`'s `lead-routing.ts`, and the
 * split is the same one `automation.ts` draws, for the same reason: the API
 * writes rules, the API and the worker both execute them, and a distribution
 * policy whose halves disagree about what "30%" means is worse than no policy.
 *
 * Keeping the pick pure is also what makes it TESTABLE. Fairness is the only
 * thing anybody will judge this feature on, and fairness is a property of a
 * sequence, not of one call - `lead-routing.test.ts` runs a thousand leads
 * through it and asserts the split. That test cannot exist if the algorithm
 * needs a transaction.
 *
 * ── THE TWO STRATEGIES ────────────────────────────────────────────────────
 *
 *   round_robin - strict rotation over the target list. A, B, C, A, B, C.
 *                 A durable cursor, not a random pick, so the sequence is
 *                 predictable and a manager can point at the board and say
 *                 "that one was Priya's turn".
 *
 *   percentage  - each telecaller carries a share of the volume: 50/30/20.
 *
 * ── WHY PERCENTAGE IS NOT A DICE ROLL ─────────────────────────────────────
 *
 * The obvious implementation of "route 30% to Priya" is a random number and
 * three buckets. It is right in expectation and wrong in practice: a desk that
 * takes nine leads a day will regularly see six in a row go to one person, and
 * the tenant will report it as a bug - correctly, because what they asked for
 * was a RATIO OF THE STREAM, not the outcome of a coin.
 *
 * So the pick is deterministic and deficit-driven (the largest-remainder
 * method, applied incrementally - the same family as the smooth weighted
 * round-robin load balancers use). Each lead goes to whoever is furthest below
 * their share of what has been handed out so far. Two consequences worth
 * knowing:
 *
 *   1. The running split is never more than one lead away from the exact
 *      ratio, at any point, not just in the limit.
 *   2. Every decision has a one-sentence explanation - "Priya was 1.4 leads
 *      below her 50% share" - which is what the console shows, and what makes
 *      this feature arguable with rather than mysterious.
 *
 * With equal shares the deficit method degenerates to strict rotation, so
 * round-robin could have been expressed as "everyone at the same percentage".
 * It is kept separate anyway: a cursor survives a target being paused and
 * resumed in a way a deficit does not, and "sequential" is a promise about
 * ORDER that a tenant picking round-robin is entitled to.
 */

export const LeadRoutingStrategy = z.enum(["round_robin", "percentage"]);
export type LeadRoutingStrategy = z.infer<typeof LeadRoutingStrategy>;

export const LEAD_ROUTING_STRATEGY_LABELS: Record<LeadRoutingStrategy, string> = {
  round_robin: "Round robin",
  percentage: "Percentage split",
};

export const LEAD_ROUTING_STRATEGY_BLURBS: Record<LeadRoutingStrategy, string> = {
  round_robin: "Each new lead goes to the next telecaller in the list, in order, and then round again.",
  percentage: "Each telecaller takes a fixed share of the volume - 50/30/20 - held exactly as leads arrive.",
};

/**
 * Which leads a rule is about.
 *
 * Field comparisons as data, never an expression language - the same call
 * `AutomationConditions` makes and the same reasoning: a DSL here needs a
 * parser, a sandbox, and an answer for what happens when somebody types an
 * infinite loop into a text box. Every criterion below is something a person
 * can pick from a dropdown.
 *
 * An empty object matches every lead, and that is the useful default: the
 * first rule most tenants write is "share everything out between these four
 * people". A catch-all is therefore not a special case in the engine, it is
 * just a rule with no criteria and the lowest priority.
 *
 * All present criteria must hold (AND); within one criterion any value counts
 * (OR). That is the only combination that reads correctly in the UI without a
 * boolean editor: "web forms AND Meta ads, for the LexDraft project".
 */
export const LeadRoutingMatch = z.object({
  /** Which front door the lead came through. */
  sourceChannels: z.array(LeadSourceChannel).max(12).optional(),
  /** Specific configured `lead_sources` rows - one landing page, not all of them. */
  leadSourceIds: z.array(z.string().uuid()).max(25).optional(),
  /** The tenant's own offering the lead is about (0073). */
  projectIds: z.array(z.string().uuid()).max(25).optional(),
  /**
   * Deal-size floor, so "enquiries over ₹5,00,000 go to the senior desk" is
   * expressible. A lead with no value never matches a rule that sets this -
   * absent is not zero, and treating it as zero would route every unvalued
   * enquiry into the "small" rule rather than leaving it for the catch-all.
   */
  minValue: z.number().nonnegative().max(1e12).optional(),
});
export type LeadRoutingMatch = z.infer<typeof LeadRoutingMatch>;

/** The lead's own fields, as the matcher needs to see them. */
export interface RoutableLead {
  sourceChannel: string | null;
  leadSourceId: string | null;
  projectId: string | null;
  value: number | null;
}

/**
 * Does this rule apply to this lead?
 *
 * An EMPTY array is treated as "no criterion", not as "match nothing". The
 * console cannot produce one - it deletes the key when the last chip is
 * removed - but a hand-edited row or an older client can, and a rule that
 * silently stops matching everything is the worst failure an automation has:
 * it looks configured and it is not.
 */
export function ruleMatchesLead(match: LeadRoutingMatch, lead: RoutableLead): boolean {
  const inList = (list: string[] | undefined, value: string | null): boolean =>
    !list || list.length === 0 || (value !== null && list.includes(value));

  if (!inList(match.sourceChannels, lead.sourceChannel)) return false;
  if (!inList(match.leadSourceIds, lead.leadSourceId)) return false;
  if (!inList(match.projectIds, lead.projectId)) return false;
  if (match.minValue !== undefined) {
    if (lead.value === null || lead.value < match.minValue) return false;
  }
  return true;
}

/**
 * The first rule that matches, by priority then by age.
 *
 * FIRST MATCH WINS rather than "every match runs". A lead has one owner, so
 * running two rules would mean the second silently overwrote the first, and
 * which one won would depend on row order. Priority makes the precedence a
 * thing the tenant SET rather than a thing they discovered.
 *
 * Callers pass rules already ordered (priority ASC, created_at ASC); this
 * function does not sort, so the order the console displays and the order the
 * engine applies are the same list.
 */
export function firstMatchingRule<T extends { match: LeadRoutingMatch }>(
  rules: readonly T[],
  lead: RoutableLead,
): T | null {
  return rules.find((rule) => ruleMatchesLead(rule.match, lead)) ?? null;
}

// ── the pick ────────────────────────────────────────────────────────────────

/** One telecaller on a rule, with the state the pick needs. */
export interface RoutingCandidate {
  /** `lead_routing_targets.id` - the row, not the person. */
  id: string;
  telecallerId: string;
  /** Display name, so a decision can explain itself. */
  name: string;
  /** Stable ordering within the rule. Round robin's sequence IS this order. */
  position: number;
  /** Percentage strategy only. 0 means "on the list but not receiving". */
  sharePct: number;
  /** Leads taken since the allocation window opened - see `windowStartedAt`. */
  delivered: number;
  /** Temporarily off the rotation: leave, training, a bad week. */
  paused: boolean;
  /** Refuse more than this many in one day. null = no ceiling. */
  dailyCap: number | null;
  /** Already taken today, in the org's reporting timezone. */
  assignedToday: number;
}

export type RoutingRefusal =
  | "no_targets"
  | "all_paused"
  | "all_capped"
  | "no_share";

export interface RoutingDecision {
  /** The chosen target, or null when nobody could take it. */
  picked: RoutingCandidate | null;
  /** Why - shown verbatim in the console's decision log. */
  reason: string;
  /** Set when `picked` is null. Lets callers branch without parsing prose. */
  refusal: RoutingRefusal | null;
  /** What to store back on the rule. Unchanged for the percentage strategy. */
  nextCursor: number;
}

/** Available to take a lead at all. */
function eligible(candidate: RoutingCandidate): boolean {
  if (candidate.paused) return false;
  if (candidate.dailyCap !== null && candidate.assignedToday >= candidate.dailyCap) return false;
  return true;
}

/**
 * Distinguish "everyone is paused" from "everyone is full".
 *
 * Both leave the lead unassigned, and they are completely different problems:
 * one is a rota nobody updated, the other is a desk at capacity that needs
 * another pair of hands. Collapsing them into "no telecaller available" is how
 * a support ticket takes three exchanges instead of none.
 */
function refusalFor(candidates: readonly RoutingCandidate[]): { refusal: RoutingRefusal; reason: string } {
  if (candidates.length === 0) {
    return { refusal: "no_targets", reason: "this rule has no telecallers on it" };
  }
  if (candidates.every((c) => c.paused)) {
    return { refusal: "all_paused", reason: "every telecaller on this rule is paused" };
  }
  return {
    refusal: "all_capped",
    reason: "every available telecaller on this rule has hit their daily cap",
  };
}

/**
 * Strict rotation from a durable cursor.
 *
 * The cursor is an INDEX INTO THE LIST, taken modulo its length, so a target
 * being added or removed cannot leave it dangling - it just means the next
 * lead resumes somewhere sensible rather than at the top. Storing a
 * telecaller id instead would need a "what if that person left" branch, and
 * that branch is where rotations quietly become "always the first person".
 *
 * A skipped candidate (paused, or at their cap) still advances the cursor past
 * everyone scanned. Someone on leave must not hold their place in the queue
 * and take the next lead the moment they return - the rotation continues
 * without them, which is what "round robin" means to the person watching it.
 */
function pickRoundRobin(candidates: readonly RoutingCandidate[], cursor: number): RoutingDecision {
  const n = candidates.length;
  if (n === 0) {
    const { refusal, reason } = refusalFor(candidates);
    return { picked: null, reason, refusal, nextCursor: cursor };
  }

  // Normalised twice so a negative cursor - which no writer produces, and a
  // hand-edited row can - lands in range rather than throwing an index error
  // that would take the whole intake transaction down with it.
  const start = ((Math.trunc(cursor) % n) + n) % n;
  for (let step = 0; step < n; step += 1) {
    const index = (start + step) % n;
    const candidate = candidates[index];
    if (!eligible(candidate)) continue;
    return {
      picked: candidate,
      reason:
        step === 0
          ? `${candidate.name} was next in the rotation`
          : `${candidate.name} was next in the rotation after ${step} unavailable`,
      refusal: null,
      nextCursor: index + 1,
    };
  }

  const { refusal, reason } = refusalFor(candidates);
  return { picked: null, reason, refusal, nextCursor: cursor };
}

/**
 * The largest-remainder pick: whoever is furthest below their share.
 *
 * For each eligible target, its deficit is
 *
 *     share_i / Σshare  ×  (Σdelivered + 1)   -   delivered_i
 *
 * i.e. how many leads they SHOULD have had by the time this one is handed out,
 * minus how many they did. The largest deficit wins.
 *
 * ── SHARES ARE RE-NORMALISED OVER WHO IS ACTUALLY AVAILABLE ───────────────
 *
 * Both sums run over ELIGIBLE targets only. If the 20% person is on leave, the
 * remaining two split the stream 50:30 → 62.5:37.5 rather than the desk
 * dropping a fifth of its leads on the floor. The alternative - keeping the
 * absent person in the denominator - means a paused telecaller silently
 * shrinks everyone else's volume, which is a bug that takes weeks to notice
 * because the board still fills up.
 *
 * ── A ZERO SHARE IS NOT ELIGIBLE ──────────────────────────────────────────
 *
 * 0% means "on this rule but not receiving" - a real state, used to keep
 * somebody's history and counters while they are off the rotation. Their
 * deficit would otherwise be a flat 0 and they would win every tie.
 */
function pickPercentage(candidates: readonly RoutingCandidate[], cursor: number): RoutingDecision {
  const available = candidates.filter((c) => eligible(c) && c.sharePct > 0);

  if (available.length === 0) {
    // Somebody IS free - they are just all on 0%. That is its own diagnosis,
    // and not the same as being paused or capped: the rule is configured to
    // hand out nothing, which is a typo, not a staffing problem.
    if (candidates.some(eligible)) {
      return {
        picked: null,
        reason: "every available telecaller on this rule is set to 0%",
        refusal: "no_share",
        nextCursor: cursor,
      };
    }
    const { refusal, reason } = refusalFor(candidates);
    return { picked: null, reason, refusal, nextCursor: cursor };
  }

  const totalShare = available.reduce((sum, c) => sum + c.sharePct, 0);
  const totalDelivered = available.reduce((sum, c) => sum + c.delivered, 0);

  let best = available[0];
  let bestDeficit = -Infinity;
  for (const candidate of available) {
    const entitled = (candidate.sharePct / totalShare) * (totalDelivered + 1);
    const deficit = entitled - candidate.delivered;
    // Strictly greater, so an exact tie keeps the EARLIER candidate - and
    // `available` preserves the caller's (position, id) ordering. Ties are the
    // common case on the first few leads of a fresh window, and a tie broken
    // by anything unstable would make the sequence depend on row order.
    if (deficit > bestDeficit) {
      best = candidate;
      bestDeficit = deficit;
    }
  }

  const targetPct = (best.sharePct / totalShare) * 100;
  return {
    picked: best,
    reason:
      totalDelivered === 0
        ? `${best.name} opens the split at ${formatPct(targetPct)}`
        : `${best.name} was ${bestDeficit.toFixed(1)} leads below their ${formatPct(targetPct)} share`,
    refusal: null,
    nextCursor: cursor,
  };
}

/**
 * Who takes the next lead.
 *
 * Total: it never throws and never returns a target that was ineligible. A
 * caller can treat `picked === null` as "leave it unassigned and say why",
 * which is always a valid outcome - an unassigned lead on the board is a
 * visible problem, and a lead force-fed to somebody over their cap is an
 * invisible one.
 */
export function pickRoutingTarget(
  strategy: LeadRoutingStrategy,
  candidates: readonly RoutingCandidate[],
  cursor: number,
): RoutingDecision {
  return strategy === "round_robin"
    ? pickRoundRobin(candidates, cursor)
    : pickPercentage(candidates, cursor);
}

/**
 * The next `count` picks, without touching any state.
 *
 * This is what the console's "next up" strip renders. It matters more than it
 * looks: the single question every tenant asks about a distribution rule is
 * "so who gets the next one", and the only trustworthy answer is the engine's
 * own, run forward on a copy. A separate preview implementation would drift
 * from the executor and be worse than no preview at all.
 *
 * Daily caps are advanced alongside delivered counts, so the preview shows the
 * rotation genuinely stepping over somebody who fills up partway through.
 */
export function simulateRouting(
  strategy: LeadRoutingStrategy,
  candidates: readonly RoutingCandidate[],
  cursor: number,
  count: number,
): RoutingDecision[] {
  const scratch = candidates.map((c) => ({ ...c }));
  const out: RoutingDecision[] = [];
  let nextCursor = cursor;

  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const decision = pickRoutingTarget(strategy, scratch, nextCursor);
    out.push(decision);
    nextCursor = decision.nextCursor;
    if (!decision.picked) break; // Nothing changes, so every later step is identical.
    const row = scratch.find((c) => c.id === decision.picked?.id);
    if (row) {
      row.delivered += 1;
      row.assignedToday += 1;
    }
  }
  return out;
}

// ── configuration ───────────────────────────────────────────────────────────

/** One row of `lead_routing_targets`, as the console writes it. */
export const LeadRoutingTargetInput = z.object({
  telecallerId: z.string().uuid(),
  /**
   * Whole-ish percentages: three decimals is enough for a seven-way split and
   * few enough that the sum can be checked against 100 without float drama.
   * Ignored by the round-robin strategy, and deliberately still stored - a
   * tenant who switches a rule from round robin to percentage keeps the split
   * they typed rather than starting from a blank form.
   */
  sharePct: z.number().min(0).max(100).optional(),
  /** Refuse more than this many leads per day. Applies to BOTH strategies. */
  dailyCap: z.number().int().min(1).max(10000).nullish(),
  paused: z.boolean().optional(),
});
export type LeadRoutingTargetInput = z.infer<typeof LeadRoutingTargetInput>;

/**
 * Shares must add up, and the check lives here so the form and the API agree.
 *
 * ── WHY 100 AND NOT "ANY WEIGHTS, NORMALISED" ─────────────────────────────
 *
 * Normalised weights are strictly more flexible and strictly worse to operate.
 * "50, 30, 20" and "5, 3, 2" behave identically, so a tenant who edits one
 * person from 30 to 40 believes they gave them more and has instead changed
 * everybody's share - silently, with no error, and visible only in a month of
 * lead counts. Requiring the numbers to total 100 makes that edit impossible
 * to get wrong: you cannot raise one person without lowering somebody else,
 * which is exactly the trade-off you are actually making.
 *
 * The tolerance is for thirds (33.333 × 3 = 99.999), not for sloppiness.
 */
export const SHARE_TOTAL_TOLERANCE = 0.01;

export function sharesProblem(
  strategy: LeadRoutingStrategy,
  targets: readonly { sharePct?: number | null; paused?: boolean | null }[],
): string | null {
  if (strategy !== "percentage") return null;
  if (targets.length === 0) return null; // An empty rule is allowed; it just routes nothing.

  const total = targets.reduce((sum, t) => sum + (t.sharePct ?? 0), 0);
  if (Math.abs(total - 100) > SHARE_TOTAL_TOLERANCE) {
    return `Percentages must add up to 100 - these add up to ${formatPct(total)}`;
  }
  return null;
}

/** `50%`, `33.3%`, `12.5%` - never `33.333000000000004%`. */
export function formatPct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * What each telecaller ACTUALLY got, against what they were promised.
 *
 * The console's honesty check. A rule can look perfectly configured and still
 * be handing 80% of the leads to one person because everybody else is paused,
 * and this is the only view that shows it.
 */
export interface ShareReality {
  telecallerId: string;
  name: string;
  targetPct: number;
  actualPct: number;
  delivered: number;
  /** actual - target, in points. Negative means they are owed leads. */
  driftPct: number;
}

export function shareReality(
  strategy: LeadRoutingStrategy,
  candidates: readonly RoutingCandidate[],
): ShareReality[] {
  const totalDelivered = candidates.reduce((sum, c) => sum + c.delivered, 0);
  const totalShare = candidates.reduce((sum, c) => sum + c.sharePct, 0);

  return candidates.map((c) => {
    // Round robin promises everyone the same volume, so its "target" is an
    // even split - which is the number worth comparing against, and the one a
    // manager already has in their head.
    const targetPct =
      strategy === "round_robin"
        ? candidates.length > 0
          ? 100 / candidates.length
          : 0
        : totalShare > 0
          ? (c.sharePct / totalShare) * 100
          : 0;
    const actualPct = totalDelivered > 0 ? (c.delivered / totalDelivered) * 100 : 0;
    return {
      telecallerId: c.telecallerId,
      name: c.name,
      targetPct,
      actualPct,
      delivered: c.delivered,
      driftPct: actualPct - targetPct,
    };
  });
}

/**
 * The fields, WITHOUT defaults. Both schemas below are built from these.
 *
 * ── WHY THE PATCH IS NOT `LeadRoutingRuleInput.partial()` ─────────────────
 *
 * Because `.partial()` does not remove `.default()`. A field that is optional
 * AND defaulted still MATERIALISES its default when the key is absent, so
 * `partial().parse({ status: "paused" })` returns
 *
 *     { status: "paused", match: {}, priority: 100 }
 *
 * and a PATCH built from that would wipe the rule's channel criteria and reset
 * its priority - triggered by the Pause button, which sends nothing else. The
 * rule would go on looking configured on the page it was configured from and
 * quietly start matching every lead in the tenant.
 *
 * That is not a hypothetical: it is what this file did until the schema was
 * exercised directly. Defaults belong on CREATE, where "unspecified" really
 * does mean "give me the default", and nowhere near an UPDATE, where it means
 * "leave this alone".
 */
const RULE_FIELDS = {
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  strategy: LeadRoutingStrategy,
  match: LeadRoutingMatch,
  /** Lower runs first. Ties fall back to age, so a value is never required. */
  priority: z.number().int().min(0).max(1000),
  status: z.enum(["active", "paused"]),
  /** Restrict to one desk. NULL routes leads from every workspace in the org. */
  workspaceId: z.string().uuid().nullish(),
};

export const LeadRoutingRuleInput = z.object({
  ...RULE_FIELDS,
  match: RULE_FIELDS.match.default({}),
  priority: RULE_FIELDS.priority.default(100),
  status: RULE_FIELDS.status.default("active"),
});
export type LeadRoutingRuleInput = z.infer<typeof LeadRoutingRuleInput>;

/** Every field optional and NONE defaulted - absent means "do not touch". */
export const LeadRoutingRulePatch = z.object(RULE_FIELDS).partial();
export type LeadRoutingRulePatch = z.infer<typeof LeadRoutingRulePatch>;

/** How the engine was invoked - stored on every decision. */
export const LeadRoutingTrigger = z.enum([
  /** A lead arrived through the intake engine or the public API. */
  "intake",
  /** An owner pressed "Distribute now" over the unassigned backlog. */
  "backfill",
]);
export type LeadRoutingTrigger = z.infer<typeof LeadRoutingTrigger>;

export const LeadRoutingOutcome = z.enum(["assigned", "unassigned"]);
export type LeadRoutingOutcome = z.infer<typeof LeadRoutingOutcome>;
