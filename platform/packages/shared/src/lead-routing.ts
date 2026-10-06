import { z } from "zod";
import { HandsetState } from "./attendance";
import { LeadSourceChannel } from "./lead-intake";

/**
 * Automated lead distribution (migration 0105) - the PURE half.
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
 * ── THE THREE STRATEGIES ──────────────────────────────────────────────────
 *
 *   round_robin - strict rotation over the target list. A, B, C, A, B, C.
 *                 A durable cursor, not a random pick, so the sequence is
 *                 predictable and a manager can point at the board and say
 *                 "that one was Priya's turn".
 *
 *   percentage  - each telecaller carries a share of the volume: 50/30/20.
 *
 *   sticky      - a returning caller goes back to the person who already
 *                 knows them, and anything stickiness cannot resolve falls
 *                 through to one of the other two (migration 0160, Build
 *                 docs/39 §14). It is a third strategy rather than a feature
 *                 beside routing, so it inherits the match criteria, the
 *                 priority order, the daily caps and the decision ledger
 *                 instead of needing its own copy of each.
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
 *
 * ── WHY STICKY IS NOT ALLOWED TO GUESS ────────────────────────────────────
 *
 * `pickSticky` below has exactly one hard rule, and it is the whole phase:
 * when two DIFFERENT people owned earlier leads from the same number, the
 * lead goes to the fallback and the decision says so. It does not go to
 * whoever spoke to them most recently.
 *
 * 0146 already made this call for the call-to-lead match, and its header is
 * the argument: `leads.contact_number_key` is deliberately not unique, two
 * leads in one workspace can legitimately share it, and "that collision is
 * exactly the ambiguity lead_for_unlinked_call refuses to guess at". Recency
 * would be right about half the time, and the wrong half is INVISIBLE - the
 * prospect reaches the wrong person, and the right person never learns the
 * call happened. A fallback assignment with a reason on it is a thing a
 * manager can read; a silently misrouted customer is not.
 */

// ── the vocabulary, which has a CHECK constraint as its twin ────────────────

/**
 * Pinned against `lead_routing_rules_strategy_check` (0105, widened by 0160).
 *
 * THE DRIFT TRAP. Widening this enum without the CHECK throws 23514 on the
 * write and reads like a bug in the caller; widening the CHECK without this
 * enum makes the API reject a strategy the database would accept. It has
 * happened here already - `notifications.kind` drifted in both directions at
 * once and broke lead routing while every type-check and lint stayed green.
 *
 * `lead-routing.test.ts` asserts the two sets are equal, by parsing the
 * migration tree. Do not widen one of them alone.
 */
export const LeadRoutingStrategy = z.enum(["round_robin", "percentage", "sticky"]);
export type LeadRoutingStrategy = z.infer<typeof LeadRoutingStrategy>;

/**
 * What a sticky rule does with a lead stickiness could not resolve - pinned
 * against `lead_routing_rules_sticky_fallback_check` (0160).
 *
 * NOT the same set as the strategies: it is the two that can distribute a
 * lead with no history behind it, plus 'unassigned'. 'sticky' itself is
 * absent, because a sticky rule falling back to itself is an infinite regress
 * and not a policy.
 *
 * 'unassigned' is a VALUE somebody picks, not the absence of one. NULL would
 * also leave the lead unassigned, and the difference matters: a lead nobody
 * chose to leave on the board is a lead the rule silently killed, so the
 * column is NOT NULL for sticky rules by CHECK.
 */
export const LeadRoutingStickyFallback = z.enum(["round_robin", "percentage", "unassigned"]);
export type LeadRoutingStickyFallback = z.infer<typeof LeadRoutingStickyFallback>;

export const LEAD_ROUTING_STRATEGY_LABELS: Record<LeadRoutingStrategy, string> = {
  round_robin: "Round robin",
  percentage: "Percentage split",
  sticky: "Sticky ownership",
};

export const LEAD_ROUTING_STRATEGY_BLURBS: Record<LeadRoutingStrategy, string> = {
  round_robin: "Each new lead goes to the next telecaller in the list, in order, and then round again.",
  percentage: "Each telecaller takes a fixed share of the volume - 50/30/20 - held exactly as leads arrive.",
  sticky:
    "A caller who has been here before goes back to the person who already knows them. " +
    "Everything else - a new number, an owner who is off shift, or two people who both " +
    "handled this number - goes to the fallback.",
};

export const LEAD_ROUTING_STICKY_FALLBACK_LABELS: Record<LeadRoutingStickyFallback, string> = {
  round_robin: "Round robin",
  percentage: "Percentage split",
  unassigned: "Leave on the board, unassigned",
};

/**
 * The window a tenant gets if they switch a rule to sticky without choosing
 * one. A quarter: long enough to cover a re-enquiry cycle, short enough that
 * somebody who left the desk four months ago stops collecting leads on the
 * strength of one conversation.
 *
 * §14 does not state a default, so this is a decision rather than a reading of
 * it. Both constants exist so the API and the console cannot pick different
 * ones - the fallback especially, where the only wrong answer is the one that
 * silently leaves leads on the board.
 */
export const STICKY_DEFAULT_WINDOW_DAYS = 90;
export const STICKY_DEFAULT_FALLBACK: LeadRoutingStickyFallback = "round_robin";

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
  /**
   * This person's live handset state (`attendance_live_state.state`, 0140).
   *
   * STICKY ONLY. Round robin and percentage do not read it, and must not: they
   * distribute over a rota the tenant maintains, and a rotation that silently
   * skipped whoever had not opened the app would be a rotation nobody could
   * predict. Stickiness is the one strategy that can concentrate a whole day's
   * leads on ONE person, which is why it is the one that has to ask.
   *
   * Optional and `null`-able on purpose: a telecaller who has never reported
   * presence has no row, which is normal for a console-only person with no
   * handset. See `stickyOwnerOnShift` for what each case means.
   */
  handsetState?: HandsetState | null;
}

export type RoutingRefusal =
  | "no_targets"
  | "all_paused"
  | "all_capped"
  | "no_share"
  /**
   * A sticky rule resolved to nobody and its fallback is 'unassigned' - the
   * tenant's own choice, not a failure. Distinct from the four above because
   * nothing is wrong with the rule or the staffing.
   */
  | "sticky_unassigned"
  /**
   * A sticky rule with no window or no fallback. 0160's
   * `lead_routing_rules_sticky_configured` CHECK makes this unreachable
   * through the API; it is here for a hand-edited row and for a rule written
   * before the constraint existed.
   */
  | "sticky_unconfigured"
  /**
   * `pickRoutingTarget` was asked for a sticky decision with no history to
   * resolve it against - a caller that has not been taught to load it.
   *
   * It REFUSES rather than quietly running the fallback, and that direction is
   * the whole point: a fallback here would look like a working sticky rule and
   * silently never be sticky, which is the failure nobody finds. An
   * unassigned lead is on the board where somebody can see it.
   */
  | "sticky_unresolved";

/** How far the sticky resolution got, for the console and for the ledger. */
export type StickyResolution =
  /** One prior owner, available: the returning caller reached their person. */
  | "matched"
  /** Nobody in this workspace has spoken to this number inside the window. */
  | "no_history"
  /** Two or more DIFFERENT prior owners. Never guessed - see the file header. */
  | "ambiguous"
  /** One prior owner who could not take it. `unavailable` says why. */
  | "owner_unavailable"
  /** The rule is sticky and not configured, or no history was supplied. */
  | "unresolvable";

/** Why the one prior owner could not be given the lead. */
export type StickyUnavailable =
  /** They are not on this rule's target list - a leaver, or a different desk. */
  | "not_on_rule"
  /** Paused: leave, training, a bad week. */
  | "paused"
  /** At their daily cap. */
  | "capped"
  /** Attendance (0140) says OFF_SHIFT or AWAY. */
  | "off_shift";

/** What stickiness decided, alongside what the pick ended up being. */
export interface StickyOutcome {
  resolution: StickyResolution;
  /** The prior owners considered, de-duplicated, as the caller supplied them. */
  priorOwners: readonly StickyPriorOwner[];
  /** Set only on `owner_unavailable`. */
  unavailable: StickyUnavailable | null;
  /** The strategy that actually made the pick, when sticky fell through. */
  fellBackTo: LeadRoutingStickyFallback | null;
}

export interface RoutingDecision {
  /** The chosen target, or null when nobody could take it. */
  picked: RoutingCandidate | null;
  /** Why - shown verbatim in the console's decision log. */
  reason: string;
  /** Set when `picked` is null. Lets callers branch without parsing prose. */
  refusal: RoutingRefusal | null;
  /** What to store back on the rule. Unchanged for the percentage strategy. */
  nextCursor: number;
  /**
   * Set by the sticky strategy and by nothing else, so the console can badge
   * an ambiguous collision without parsing `reason`. §14 asks for the
   * collision to be VISIBLE; the prose is for a person, this is for the UI.
   */
  sticky?: StickyOutcome;
}

/**
 * One earlier lead's owner, as the caller found them.
 *
 * Built by whoever loads the history - the executor in `@aura/db` reads
 * `leads` by `(workspace_id, contact_number_key)` inside the window and groups
 * by `assigned_telecaller_id`. Kept out of this file because it is a query,
 * and the pick stays pure so a thousand leads can be run through it without a
 * database.
 */
export interface StickyPriorOwner {
  telecallerId: string;
  /**
   * For the reason prose. Nullable because the person may have been archived
   * since, and a decision that cannot name them is still worth recording.
   */
  name: string | null;
  /** How many leads from this number, inside the window, are theirs. */
  leadCount: number;
  /** The newest of those leads, ISO. For the prose only - NEVER a tie-break. */
  lastLeadAt?: string | null;
}

/**
 * Everything the sticky pick needs that it cannot compute.
 *
 * Deliberately the facts and not a database handle: the caller has already
 * decided what "inside the window" means and who owned what, so this function
 * stays testable and the window arithmetic happens once, in SQL, in the org's
 * own timezone.
 */
export interface StickyContext {
  /** `lead_routing_rules.sticky_window_days`. Null = rule not configured. */
  windowDays: number | null;
  /** `lead_routing_rules.sticky_fallback`. Null = rule not configured. */
  fallback: LeadRoutingStickyFallback | null;
  /**
   * The distinct owners of prior leads from this number in this workspace,
   * inside the window. Leads with no owner are not prior owners and must be
   * left out by the caller - an unassigned lead from last month binds nobody.
   */
  priorOwners: readonly StickyPriorOwner[];
  /**
   * `organizations.attendance_enabled` (0140). FALSE for most tenants, and it
   * is why the shift gate is conditional - see `stickyOwnerOnShift`.
   */
  attendanceTracked: boolean;
}

/**
 * The handset states that mean "not at work right now".
 *
 * Only these two. The other six - ACTIVE, IN_CALL, PROMPTING, BREAK_DUE,
 * ON_BREAK, TECHNICAL - are all somebody who is on shift: a fifteen-minute
 * break, or a phone with no signal, is not a reason to take a customer off the
 * person who knows them. `lead-routing.test.ts` enumerates every
 * `HandsetState` and asserts which side it falls on, so a ninth state cannot
 * be added without somebody deciding.
 *
 * PROMPTING is on the working side on purpose: the phone has asked "are you
 * there" and not yet been answered. That becomes AWAY when the prompt expires,
 * and until it does it is a question, not an answer.
 */
export const STICKY_OFF_SHIFT_STATES: readonly HandsetState[] = ["OFF_SHIFT", "AWAY"];

/**
 * Is this person at work, as far as the platform can actually tell?
 *
 * §14: "Attendance is a real coupling, not a nicety: a sticky owner who is
 * absent must not accumulate leads all day." The gate is real. It is also
 * conditional, in two ways that are both load-bearing:
 *
 *   1. ATTENDANCE IS OFF BY DEFAULT. `organizations.attendance_enabled`
 *      defaults false (0140) and most tenants have never turned it on. Gating
 *      on presence they do not collect would send every sticky lead to the
 *      fallback, forever, for a reason nobody would connect to a switch on
 *      another page - the feature would simply not work and would not say so.
 *
 *   2. NO ROW IS NOT ABSENCE. A telecaller with no `attendance_live_state` has
 *      never reported presence: a console-only person with no handset, which
 *      is an ordinary way to staff a desk. Treating silence as absence would
 *      quietly exclude exactly those people from ever owning a repeat caller.
 *
 * So what blocks a sticky assignment is KNOWN absence, and the decision's
 * reason distinguishes the three cases rather than flattening them.
 */
export function stickyOwnerOnShift(
  candidate: Pick<RoutingCandidate, "handsetState">,
  attendanceTracked: boolean,
): boolean {
  if (!attendanceTracked) return true;
  const state = candidate.handsetState ?? null;
  if (state === null) return true;
  return !STICKY_OFF_SHIFT_STATES.includes(state);
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

// ── sticky ──────────────────────────────────────────────────────────────────

/** De-duplicate by person, keeping the first mention and summing their leads. */
function distinctOwners(owners: readonly StickyPriorOwner[]): StickyPriorOwner[] {
  const byId = new Map<string, StickyPriorOwner>();
  for (const owner of owners) {
    const seen = byId.get(owner.telecallerId);
    if (!seen) {
      byId.set(owner.telecallerId, { ...owner });
      continue;
    }
    // A caller that grouped properly never hits this. One that returned a row
    // per lead does, and silently counting that person twice would turn one
    // owner into "two owners" and send every repeat caller to the fallback.
    seen.leadCount += owner.leadCount;
  }
  return [...byId.values()];
}

/**
 * One phrase for an owner, including the one nobody can name any more.
 *
 * A prior owner's row can outlive their telecaller record, and a decision that
 * cannot name them is still worth recording - "somebody no longer on the
 * roster already owns this number" is the sentence that tells a manager why
 * the lead went to the fallback. Used by both the collision prose and the
 * single-owner prose, so the two cannot describe the same person differently.
 */
function displayName(owner: StickyPriorOwner): string {
  return owner.name ?? "somebody no longer on the roster";
}

function ownerNames(owners: readonly StickyPriorOwner[]): string {
  return owners.map(displayName).join(" and ");
}

function leadsPhrase(count: number, windowDays: number): string {
  const leads = count === 1 ? "1 earlier lead" : `${count} earlier leads`;
  return `${leads} in the last ${windowDays} days`;
}

/**
 * Attach the sticky story to whatever the fallback decided.
 *
 * ONE decision row per lead, so one sentence has to carry both halves: why
 * stickiness did not place the lead, and what placed it instead. Splitting
 * them would mean the ledger showed "Asha was next in the rotation" with no
 * trace of the collision that sent it there - which is the one thing §14 asks
 * to be visible.
 */
function withFallback(
  inner: RoutingDecision,
  stickyReason: string,
  outcome: StickyOutcome,
): RoutingDecision {
  return {
    ...inner,
    reason: `${stickyReason}, so the fallback ran: ${inner.reason}`,
    sticky: outcome,
  };
}

/**
 * A returning caller goes back to the person who already knows them.
 *
 * ── THE RESOLUTION ORDER, EXACTLY §14 ────────────────────────────────────
 *
 *   1. Prior leads in this workspace with the same `contact_number_key`,
 *      inside the window. The caller has already done that query; what
 *      arrives here is the distinct set of people who own them.
 *   2. More than one distinct prior owner -> AMBIGUOUS -> the fallback. Not
 *      the most recent. See the file header, and 0146 before it.
 *   3. One prior owner who is on this rule, not paused, under their daily cap
 *      and on shift -> they get it.
 *   4. Otherwise -> the fallback.
 *
 * ── WHAT THE CURSOR DOES ──────────────────────────────────────────────────
 *
 * A sticky match does NOT advance it. The rotation is a queue of turns, and a
 * repeat caller returning to their owner did not consume anybody's turn - the
 * next genuinely new lead must still go to whoever was next. Falling through
 * to round robin advances it exactly as round robin would, because that lead
 * DID come out of the rotation.
 */
function pickSticky(
  candidates: readonly RoutingCandidate[],
  cursor: number,
  sticky: StickyContext | undefined,
): RoutingDecision {
  // No history supplied at all. Refuse loudly rather than running the
  // fallback: a fallback here is a rule that looks sticky, never is, and says
  // nothing about it.
  if (!sticky) {
    return {
      picked: null,
      reason:
        "this rule routes by sticky ownership and the caller did not load the number's " +
        "history, so no decision could be made - the lead was left on the board",
      refusal: "sticky_unresolved",
      nextCursor: cursor,
      sticky: {
        resolution: "unresolvable",
        priorOwners: [],
        unavailable: null,
        fellBackTo: null,
      },
    };
  }

  const { windowDays, fallback, attendanceTracked } = sticky;
  if (windowDays === null || fallback === null) {
    return {
      picked: null,
      reason:
        "this sticky rule has no " +
        (windowDays === null ? "window" : "fallback") +
        " set, so it cannot decide anything - the lead was left on the board",
      refusal: "sticky_unconfigured",
      nextCursor: cursor,
      sticky: {
        resolution: "unresolvable",
        priorOwners: distinctOwners(sticky.priorOwners),
        unavailable: null,
        fellBackTo: null,
      },
    };
  }

  const owners = distinctOwners(sticky.priorOwners);

  const runFallback = (
    resolution: StickyResolution,
    unavailable: StickyUnavailable | null,
    stickyReason: string,
  ): RoutingDecision => {
    const outcome: StickyOutcome = {
      resolution,
      priorOwners: owners,
      unavailable,
      fellBackTo: fallback,
    };
    if (fallback === "unassigned") {
      return {
        picked: null,
        reason: `${stickyReason}, and this rule leaves those on the board for somebody to pick up`,
        refusal: "sticky_unassigned",
        nextCursor: cursor,
        sticky: outcome,
      };
    }
    const inner =
      fallback === "round_robin"
        ? pickRoundRobin(candidates, cursor)
        : pickPercentage(candidates, cursor);
    return withFallback(inner, stickyReason, outcome);
  };

  // ── 1 & 2. History, and the collision that must not be guessed at ────────
  if (owners.length === 0) {
    return runFallback("no_history", null, `nobody here has spoken to this number in ${windowDays} days`);
  }
  if (owners.length > 1) {
    return runFallback(
      "ambiguous",
      null,
      `earlier leads from this number belong to different people (${ownerNames(owners)}), ` +
        "so stickiness would have had to guess",
    );
  }

  // ── 3. One owner: are they actually able to take it? ─────────────────────
  const owner = owners[0];
  const history = leadsPhrase(owner.leadCount, windowDays);
  const name = displayName(owner);

  const candidate = candidates.find((c) => c.telecallerId === owner.telecallerId);
  if (!candidate) {
    // The person who owns the history is not on this rule's target list: they
    // left, were archived, or work a different desk. Routing may only hand a
    // lead to somebody the rule names - that list is also where `dailyCap`
    // lives, so assigning off it would be an assignment with no ceiling.
    return runFallback(
      "owner_unavailable",
      "not_on_rule",
      `${name} owns this number (${history}) but is not on this rule`,
    );
  }
  if (candidate.paused) {
    return runFallback(
      "owner_unavailable",
      "paused",
      `${candidate.name} owns this number (${history}) but is paused`,
    );
  }
  if (candidate.dailyCap !== null && candidate.assignedToday >= candidate.dailyCap) {
    return runFallback(
      "owner_unavailable",
      "capped",
      `${candidate.name} owns this number (${history}) but has hit their daily cap of ${candidate.dailyCap}`,
    );
  }
  if (!stickyOwnerOnShift(candidate, attendanceTracked)) {
    return runFallback(
      "owner_unavailable",
      "off_shift",
      `${candidate.name} owns this number (${history}) but attendance says they are ` +
        (candidate.handsetState === "AWAY" ? "away" : "off shift"),
    );
  }

  // ── 4. Sticky, and said in words a manager can check ─────────────────────
  //
  // The shift clause is three different sentences on purpose. "on shift" is a
  // measurement; "attendance is off for this workspace" and "has never
  // reported from a handset" are reasons the measurement does not exist, and a
  // manager reading the ledger needs to know which one they are looking at
  // before they conclude the gate works.
  const shift = !attendanceTracked
    ? "attendance is off for this workspace"
    : candidate.handsetState === null || candidate.handsetState === undefined
      ? "their shift is unknown - they have never reported from a handset"
      : `they are on shift (${candidate.handsetState})`;

  return {
    picked: candidate,
    reason: `${candidate.name} already owns this number - ${history}, and ${shift}`,
    refusal: null,
    nextCursor: cursor,
    sticky: {
      resolution: "matched",
      priorOwners: owners,
      unavailable: null,
      fellBackTo: null,
    },
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
 *
 * `sticky` is required in practice by the sticky strategy and ignored by the
 * other two. It is the LAST and OPTIONAL parameter so that every existing
 * three-argument call site keeps compiling and keeps behaving identically -
 * and so that one which has not been taught to load the history gets the loud
 * `sticky_unresolved` refusal rather than a silent rotation.
 */
export function pickRoutingTarget(
  strategy: LeadRoutingStrategy,
  candidates: readonly RoutingCandidate[],
  cursor: number,
  sticky?: StickyContext,
): RoutingDecision {
  if (strategy === "sticky") return pickSticky(candidates, cursor, sticky);
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
 *
 * ── WHAT A STICKY PREVIEW MEANS ───────────────────────────────────────────
 *
 * One `sticky` context across every step, because there is no real lead and
 * therefore no second number to resolve. The console passes the rule's own
 * window and fallback with `priorOwners: []`, which answers the question
 * somebody actually has in front of the rules page - "who gets the next lead
 * from a number nobody has called?" - and shows the fallback sequence, which
 * is what the overwhelming majority of leads will take.
 *
 * Passing a context WITH prior owners previews one returning caller instead,
 * and then the same person legitimately appears over and over until their cap
 * stops them. That is not a bug in the preview, it is what stickiness is.
 */
export function simulateRouting(
  strategy: LeadRoutingStrategy,
  candidates: readonly RoutingCandidate[],
  cursor: number,
  count: number,
  sticky?: StickyContext,
): RoutingDecision[] {
  const scratch = candidates.map((c) => ({ ...c }));
  const out: RoutingDecision[] = [];
  let nextCursor = cursor;

  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const decision = pickRoutingTarget(strategy, scratch, nextCursor, sticky);
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
  /**
   * A sticky rule's fallback. Required for a sticky rule whose fallback is
   * 'percentage', because those shares are the ones that will actually run -
   * on most leads, in fact, since most callers have no history. Without this
   * the form would happily save 50/30 under a sticky rule and the fallback
   * would hand out a split nobody chose.
   */
  stickyFallback?: LeadRoutingStickyFallback | null,
): string | null {
  const splits = strategy === "percentage" || (strategy === "sticky" && stickyFallback === "percentage");
  if (!splits) return null;
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
    //
    // Sticky promises nothing about volume at all: it promises that a
    // returning caller reaches their own person, and the resulting split is
    // whatever the customers did. An even split is still the right comparison
    // to draw, for the reason this function exists - "one person is taking 80%
    // of this desk" is worth knowing whether or not it was promised, and on a
    // sticky rule it is the warning that one owner is being buried.
    const targetPct =
      strategy !== "percentage"
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

  // ── sticky only (0160) ───────────────────────────────────────────────────
  //
  // Both `.nullish()` rather than defaulted, for two separate reasons:
  //
  //   * A DEFAULT here would write a window and a fallback onto every
  //     round-robin rule anybody creates - configuration nobody chose, on a
  //     column the migration deliberately leaves NULL for them.
  //   * `LeadRoutingRulePatch` is built from these same fields and must fill
  //     NOTHING (see the comment above). A `.default()` survives `.partial()`,
  //     which is the bug that made the Pause button erase a rule's criteria.
  //
  // The defaults a sticky rule needs are applied by `resolveStickyConfig`,
  // which both the create and the patch path call, so they cannot disagree.
  //
  // Ten years is the ceiling, not a recommendation: it is the point past
  // which "sticky" is really "permanent", and a typed 36500 should be a
  // sentence from the form rather than a 23514.
  stickyWindowDays: z.number().int().min(1).max(3650).nullish(),
  stickyFallback: LeadRoutingStickyFallback.nullish(),
};

/**
 * The window and fallback a rule should be STORED with, given what the caller
 * sent and what is already there.
 *
 * One function for create and patch, because the invariant it maintains is a
 * database CHECK: `lead_routing_rules_sticky_configured` refuses a sticky rule
 * with a NULL window or a NULL fallback. A caller that switched a rule to
 * sticky with `PATCH { strategy }` alone - which is exactly what a strategy
 * dropdown sends - would otherwise 23514, and a 23514 on a form is a 500 that
 * reads like a platform fault.
 *
 * Two behaviours worth stating:
 *
 *   * A NON-sticky rule KEEPS a window and fallback somebody typed, exactly as
 *     `share_pct` is kept on a round-robin rule: switching a rule to
 *     percentage to try it and switching back must not silently discard the
 *     configuration you had.
 *   * `undefined` means "not sent" and falls through to the stored value;
 *     `null` means "clear it" and is honoured, except on a sticky rule, where
 *     the default takes over rather than writing a row the CHECK would reject.
 */
export function resolveStickyConfig(
  strategy: LeadRoutingStrategy,
  sent: {
    stickyWindowDays?: number | null;
    stickyFallback?: LeadRoutingStickyFallback | null;
  },
  stored?: {
    stickyWindowDays?: number | null;
    stickyFallback?: LeadRoutingStickyFallback | null;
  },
): { stickyWindowDays: number | null; stickyFallback: LeadRoutingStickyFallback | null } {
  const windowDays =
    (sent.stickyWindowDays !== undefined ? sent.stickyWindowDays : stored?.stickyWindowDays) ?? null;
  const fallback =
    (sent.stickyFallback !== undefined ? sent.stickyFallback : stored?.stickyFallback) ?? null;

  if (strategy !== "sticky") return { stickyWindowDays: windowDays, stickyFallback: fallback };
  return {
    stickyWindowDays: windowDays ?? STICKY_DEFAULT_WINDOW_DAYS,
    stickyFallback: fallback ?? STICKY_DEFAULT_FALLBACK,
  };
}

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
