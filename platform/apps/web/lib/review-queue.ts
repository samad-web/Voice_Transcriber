import { enabledFeatures, type FeatureKey, type FeatureOverrides, type OwnerRole } from "@aura/shared";

/**
 * The review queue's contract (CRM dashboard Phase 7).
 *
 * One screen for everything a machine proposed and a person must decide:
 * a WhatsApp thread scored as a prospect, a message that MAY have been a
 * request to stop, two records that may be the same person. Each came from a
 * different subsystem with its own API, and each had (or lacked) its own page.
 *
 * This file is the part that has no I/O: which sources exist, who may see
 * them, how the items are ordered and how a link to a filtered view is built.
 * Loading lives in `app/(owner)/owner/review/sources.ts`, one adapter per
 * source, so a tenant whose proposals come from a different backend replaces
 * an adapter and nothing here.
 *
 * NOTHING A REVIEWER DOES HERE SENDS A MESSAGE. Approve creates CRM records,
 * confirm/dismiss only change whether the send path refuses, merge and dismiss
 * only touch records.
 */

export type ReviewSourceKey = "agent_actions" | "whatsapp" | "opt_outs" | "duplicates";
export type ReviewFilter = ReviewSourceKey | "all";

export interface ReviewSourceSpec {
  key: ReviewSourceKey;
  label: string;
  /** One line under the tabs, when this source is the one shown. */
  blurb: string;
  /** The org feature (0101) the source's own page is gated on, if any. */
  feature: FeatureKey | null;
  /**
   * The PLAN module (`organizations.enabled_modules`) the source needs, if
   * any. Separate from `feature`: 0101's switchboard is what a tenant turns on
   * inside a plan they already hold, and the transcript agent's ceiling is the
   * plan itself (§3A.1 step 2). A tenant without the module must not see the
   * tab at all, because the tab IS the disclosure that the feature exists.
   */
  module: string | null;
  /**
   * The personas the source's own page and API admit. Mirrors lib/nav.ts for
   * the two pages that exist, and the API's owner+manager gate for opt-outs -
   * offering a tab whose every action 403s is a dead end with extra steps.
   */
  ownerRoles: readonly OwnerRole[];
  /**
   * A 403 from this source's API removes its TAB rather than showing it empty.
   *
   * The default is the opposite, and deliberately so: a telecaller who holds
   * `conversation:view` but not the duplicates grant still gets a duplicates
   * tab reading zero, which is honest - the queue exists and they cannot act
   * on it. §3A.4 requires the other behaviour for the agent: "agent sections
   * are HIDDEN, not greyed out", because a person whose owner has not switched
   * the assistant on for them should not be told how many suggestions they are
   * not allowed to see.
   */
  hideWhenDenied?: boolean;
}

export const REVIEW_SOURCES: readonly ReviewSourceSpec[] = [
  {
    // First, and it is the only source here with a DEADLINE: §12's SLA timer
    // escalates a suggestion that sits too long, so burying it under three
    // queues that never expire would be the wrong default order.
    key: "agent_actions",
    label: "Call suggestions",
    blurb:
      "What the assistant read out of a call and proposes doing about it. Nothing here has happened yet; approving is what makes it happen.",
    feature: null,
    module: "call_intel",
    ownerRoles: ["owner", "manager", "telecaller", "sales"],
    hideWhenDenied: true,
  },
  {
    key: "whatsapp",
    label: "WhatsApp leads",
    blurb: "Threads from unknown numbers the qualifier scored as prospects. Nothing becomes a lead until you approve it.",
    feature: "whatsapp_leads",
    module: null,
    ownerRoles: ["owner", "manager", "telecaller", "sales"],
  },
  {
    key: "opt_outs",
    label: "Possible opt-outs",
    blurb: "Messages that might be a request to stop. Confirming blocks sending to that number; dismissing changes nothing.",
    feature: null,
    module: null,
    ownerRoles: ["owner", "manager"],
  },
  {
    key: "duplicates",
    label: "Duplicates",
    blurb: "Records that look like the same person or company. Keep one and the other merges into it.",
    feature: "duplicates",
    module: null,
    ownerRoles: ["owner", "manager", "marketing"],
  },
];

export function reviewSourceSpec(key: ReviewSourceKey): ReviewSourceSpec {
  return REVIEW_SOURCES.find((s) => s.key === key)!;
}

/** The sources this person may review in this tenant, in display order. */
export function reviewSourcesFor(
  role: OwnerRole,
  modules: readonly string[],
  features: FeatureOverrides,
): ReviewSourceKey[] {
  // Resolved once, not per source: `enabledFeatures` walks the catalogue and
  // its dependencies, and there is no reason to redo that for each row.
  const on = enabledFeatures(modules, features);
  return REVIEW_SOURCES.filter(
    (s) =>
      s.ownerRoles.includes(role) &&
      (s.feature === null || on.has(s.feature)) &&
      (s.module === null || modules.includes(s.module)),
  ).map((s) => s.key);
}

/** `?source=` - anything unknown or not available to this person means "all". */
export function parseReviewFilter(value: unknown, available: readonly ReviewSourceKey[]): ReviewFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && (available as readonly string[]).includes(raw)
    ? (raw as ReviewSourceKey)
    : "all";
}

export function reviewHref(
  filter: ReviewFilter,
  options: { includeJunk?: boolean; base?: string } = {},
): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("source", filter);
  if (options.includeJunk) params.set("junk", "1");
  const query = params.toString();
  return `${options.base ?? "/owner/review"}${query ? `?${query}` : ""}`;
}

// ── items ─────────────────────────────────────────────────────────────────

export interface ReviewQualification {
  id: string;
  conversation_id: string;
  disposition: string;
  band: "hot" | "warm" | "cold" | "junk";
  score: number;
  intent: string | null;
  rationale: string | null;
  message_count: number;
  extracted_name: string | null;
  extracted_email: string | null;
  extracted_company: string | null;
  extracted_budget: number | null;
  extracted_notes: string | null;
  provider: string | null;
  /** Extra details from the tenant's chat qualifier (0121); `{}` for the built-in prompt. */
  facts?: Record<string, unknown> | null;
  /** The chat qualifier that judged it, when one did. */
  agent_name?: string | null;
  created_at: string;
  peer_address: string;
  peer_label: string | null;
}

export interface ReviewOptOut {
  id: string;
  channel: string;
  peer_address: string;
  peer_label: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  message_body: string | null;
  message_at: string | null;
  /**
   * The message that raised this arrived on a colleague's own WhatsApp number
   * (0125), so its text and thread are withheld from this reviewer. The
   * opt-out itself still applies to the whole business.
   */
  source_private?: boolean;
  created_at: string;
}

export interface ReviewDuplicate {
  id: string;
  object_type: "contact" | "account";
  record_a_id: string;
  record_b_id: string;
  record_a_label: string | null;
  record_a_detail: string | null;
  record_b_label: string | null;
  record_b_detail: string | null;
  match_reason: string;
  created_at: string;
}


/**
 * One suggestion the call assistant is waiting on a person for (§12).
 *
 * ── WHY SO MANY VERSION FIELDS ────────────────────────────────────────────
 *
 * §20: "every decision records prompt, model, schema and resolver versions and
 * is reproducible from stored inputs." They are on the card because the
 * question a reviewer asks about a run of bad suggestions is "what changed",
 * and the answer is one of these four numbers.
 *
 * ── `evidence` IS THE CUSTOMER'S OWN WORDS, NOT A PARAPHRASE ──────────────
 *
 * A reviewer approving an action a model proposed needs the sentence it read
 * it out of. The API serves a window around each quote rather than the whole
 * transcript, because the transcript itself is behind the call-access rules.
 */
export interface ReviewAgentAction {
  id: string;
  tool: string;
  tier: string;
  capability: string;
  /** What the tool would be called with. Edited in place by a reviewer. */
  params: Record<string, unknown> | null;
  state: string;
  policy_code: string | null;
  reason: string | null;
  final_score: number | null;
  band: string | null;
  requested_at: string;
  /** §12's SLA timer. Past this, the item escalates through the Advisor. */
  review_due_at: string | null;
  review_escalated_at: string | null;
  intent_id: string | null;
  intent_type: string | null;
  intent_status: string | null;
  confidence: number | null;
  slots: Record<string, unknown> | null;
  /** What the deterministic resolvers made of the slots - times and amounts. */
  resolved: Record<string, unknown> | null;
  evidence: Array<{ quote?: string; speaker?: string; at_ms?: number }> | null;
  /** §12's "confidence breakdown" - the factors, not one number. */
  confidenceBreakdown: Record<string, unknown> | null;
  thresholds: { auto: number; review: number } | null;
  run_id: string;
  effective_mode: string | null;
  model: string | null;
  prompt_version: string | null;
  schema_version: string | null;
  resolver_version: string | null;
  summary: string | null;
  call_id: string | null;
  language: string | null;
  telecaller_id: string | null;
  telecaller_name: string | null;
  roles_inferred: boolean | null;
  stt_confidence: number | null;
  started_at: string | null;
  lead_id: string | null;
  lead_name: string | null;
}
export type ReviewItem =
  | { source: "agent_actions"; id: string; waitingSince: string; agentAction: ReviewAgentAction }
  | { source: "whatsapp"; id: string; waitingSince: string; qualification: ReviewQualification }
  | { source: "opt_outs"; id: string; waitingSince: string; optOut: ReviewOptOut }
  | { source: "duplicates"; id: string; waitingSince: string; duplicate: ReviewDuplicate };

/**
 * One source keeps the order its API chose - the WhatsApp queue is ranked by
 * score, and re-sorting it by age would bury the hottest lead. Several sources
 * have no shared score, so they interleave by how long each has waited,
 * longest first: the thing most likely to have gone stale is the first thing
 * a person sees.
 */
export function orderReviewItems(items: readonly ReviewItem[], filter: ReviewFilter): ReviewItem[] {
  if (filter !== "all") return items.filter((i) => i.source === filter);
  return [...items].sort(
    (a, b) => a.waitingSince.localeCompare(b.waitingSince) || a.id.localeCompare(b.id),
  );
}

/** "12 min", "3 h", "2 d" - how long an item has been waiting. */
export function waitingFor(since: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
