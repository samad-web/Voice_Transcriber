import { z } from "zod";
import type { OrgModule } from "./org-modules";

/**
 * The GATED FEATURE framework (Build docs/transcript-agent-build-plan §3A).
 *
 * ── WHY THIS IS NOT `features.ts` ───────────────────────────────────────────
 *
 * `features.ts` is a switchboard: one boolean per feature, per org, and its
 * whole design rests on that - `resolveFeatures` takes a module list and a
 * sparse override map and returns on/off/unavailable/blocked. Forty-two rows in
 * `org_feature_settings` mean "this business made a decision".
 *
 * §3A asks for something a boolean cannot express:
 *
 *   · FIVE scopes, not one. platform → plan → org → team/role → user.
 *   · A MODE, not a state. `shadow` analyses and never acts; `suggest` puts
 *     every action in front of a person; `assisted` executes the internal ones;
 *     `auto` executes customer-visible ones under their own gates.
 *   · CAPABILITIES. An owner may want call summaries and callbacks and
 *     categorically not customer messaging.
 *   · A CEILING. A user's setting may never exceed the org's maximum, and an
 *     explicit OFF at any broader scope always wins.
 *
 * Widening `org_feature_settings.enabled` into this shape would change the
 * meaning of every existing row, so this is a second, narrower mechanism that
 * sits BELOW the switchboard rather than beside it: the switchboard (and the
 * module behind it) is the plan ceiling this consults in step 2.
 *
 * ── WHY IT IS GENERIC WHEN THERE IS ONE FEATURE ─────────────────────────────
 *
 * §3A: "build the gate as a generic, reusable feature-gate framework rather
 * than agent-specific code, so KPI, Finance, Org Chart and future modules can
 * use the same toggles, admin screen and audit trail." `GATED_FEATURES` has one
 * entry today. Adding a second is a row here plus a migration-free settings
 * row - no new tables, no new admin screen, no new audit path. That is the
 * deliverable, and §20 asks for it explicitly.
 *
 * ── AND WHY THE CATALOGUE IS CODE, NOT A TABLE ──────────────────────────────
 *
 * §15 models `feature_definition` as a table. `features.ts`'s header makes the
 * argument against that at length and it applies unchanged: the API gates a
 * request with this, the web tier draws a screen from it, and the worker decides
 * whether to spend money on a provider call with it. Those three answers
 * drifting apart is the failure mode. One exported table, three importers.
 *
 * ── EVERY FUNCTION HERE IS PURE ─────────────────────────────────────────────
 *
 * No clock, no database, no cache. The instant is always a parameter, because
 * `effective_from`/`effective_to` windows are the whole behaviour of §3A.5's
 * scheduled changes and a boundary you cannot test at 23:59:59 is a boundary
 * nobody tests.
 */

// ── The catalogue ───────────────────────────────────────────────────────────

/**
 * Features governed by this framework. One today.
 *
 * `transcript_agent` is deliberately NOT a `FeatureKey` in `features.ts`. The
 * two switchboards answer different questions and a key in both would make
 * "is it on" ambiguous: the console's switchboard decides whether a PAGE
 * exists, this decides whether WORK HAPPENS FOR A PERSON, and the agent's work
 * is per-telecaller by construction.
 */
export const GatedFeatureKey = z.enum(["transcript_agent"]);
export type GatedFeatureKey = z.infer<typeof GatedFeatureKey>;

/**
 * §3A.2's modes, LOWEST TO HIGHEST. The order is load-bearing: the effective
 * mode is the lower of the user's and the org's maximum, and `modeRank` is the
 * only place that comparison is expressed.
 *
 *   off       nothing runs. No ingestion, no model call, no UI.
 *   shadow    analyse and log. No actions, nothing shown to staff. This is
 *             §13.4's shadow rollout and it still COSTS MONEY - the model runs -
 *             which is why it is a mode an owner chooses and not a default.
 *   suggest   every proposed action goes to the review queue. The default on
 *             first enablement (§18).
 *   assisted  T0/T1 execute automatically; T2 needs confirmation.
 *   auto      T2 may execute where the org enabled it per intent AND that
 *             intent's measured precision meets §13.3's gate. T3 never.
 */
export const AgentMode = z.enum(["off", "shadow", "suggest", "assisted", "auto"]);
export type AgentMode = z.infer<typeof AgentMode>;

const MODE_ORDER: readonly AgentMode[] = ["off", "shadow", "suggest", "assisted", "auto"];

export function modeRank(mode: AgentMode): number {
  return MODE_ORDER.indexOf(mode);
}

/** The LOWER of two modes - §3A.1 step 5. A user can never exceed the org. */
export function lowerMode(a: AgentMode, b: AgentMode): AgentMode {
  return modeRank(a) <= modeRank(b) ? a : b;
}

export function modeAtLeast(mode: AgentMode, floor: AgentMode): boolean {
  return modeRank(mode) >= modeRank(floor);
}

/** One line each, for the admin screen. Phrased as what the agent WILL DO. */
export const AGENT_MODE_LABELS: Record<AgentMode, string> = {
  off: "Off",
  shadow: "Watch only",
  suggest: "Suggest everything",
  assisted: "Do the internal work",
  auto: "Act automatically",
};

export const AGENT_MODE_BLURBS: Record<AgentMode, string> = {
  off: "Nothing runs for this person. No transcript is read and nothing is charged.",
  shadow:
    "Reads calls and records what it would have done. Nobody is shown anything and nothing is created. You still pay for the reading.",
  suggest:
    "Reads calls and puts every suggestion in front of a person to approve, edit or reject.",
  assisted:
    "Writes summaries, dispositions, follow-ups and callbacks by itself. Anything the customer would see waits for a person.",
  auto: "As above, plus the customer-visible actions you have switched on and that are measuring accurately enough.",
};

/**
 * §3A.2's capabilities - independent sub-toggles, so an owner can enable
 * summaries and callbacks and categorically not customer messaging.
 */
export const AgentCapability = z.enum([
  /** Summaries, dispositions, sentiment, quality signals. */
  "record",
  /** Follow-ups, payment promises, contact updates, referrals. */
  "tasks",
  /** §10A: the to-call list, popups, missed-callback escalation. */
  "callbacks",
  /** Calendar actions: book, reschedule, cancel. */
  "booking",
  /** Template messages and information sharing to the CUSTOMER. */
  "messaging",
  /** Payment links, via the Finance connectors. */
  "payments",
  /** Complaint and refund review tasks. */
  "sensitive_flows",
  /** M12. Catalogued so the gate exists before the feature does. */
  "live_assist",
]);
export type AgentCapability = z.infer<typeof AgentCapability>;

export const AGENT_CAPABILITY_LABELS: Record<AgentCapability, string> = {
  record: "Write call summaries",
  tasks: "Create follow-ups and reminders",
  callbacks: "Manage the call-back list",
  booking: "Book and move appointments",
  messaging: "Send messages to customers",
  payments: "Create payment links",
  sensitive_flows: "Raise complaints and refund reviews",
  live_assist: "Help during the call (not available yet)",
};

export const AGENT_CAPABILITY_BLURBS: Record<AgentCapability, string> = {
  record:
    "A summary, the outcome, the mood and the quality signals land on the call. Nothing leaves the workspace.",
  tasks:
    "Promises made on the call become follow-ups, payment promises and contact corrections for your own team.",
  callbacks:
    '"Call me at 5" becomes an item in that telecaller\'s call-back list, with a reminder and an escalation if it is missed.',
  booking: "A confirmed appointment is put in the right person's diary, after checking they are free.",
  messaging:
    "Approved templates only, to customers who have not opted out. Every one of these waits for a person unless you say otherwise.",
  payments: "A payment link against the right deal and instalment. Always waits for a person.",
  sensitive_flows:
    "A complaint or a refund request becomes a review task for whoever owns it. Never acted on by itself.",
  live_assist: "Suggestions to the telecaller while the call is happening.",
};

/**
 * The LOWEST mode in which a capability does anything at all - §3A.1 step 6's
 * "permitted by the mode".
 *
 * `record` at `shadow` and everything else at `suggest` is the whole table, and
 * it is what makes `shadow` mean what §3A.2 says it means: "analyze and log
 * only, no actions, no UI to staff". A shadow run that could create a callback
 * would be an action, and a shadow run that could not even write its own
 * analysis would have nothing to compare against in §13.4.
 *
 * `live_assist` needs `assisted`, because a suggestion whispered to a
 * telecaller mid-call is not something a review queue can hold.
 */
export const CAPABILITY_MIN_MODE: Record<AgentCapability, AgentMode> = {
  record: "shadow",
  tasks: "suggest",
  callbacks: "suggest",
  booking: "suggest",
  messaging: "suggest",
  payments: "suggest",
  sensitive_flows: "suggest",
  live_assist: "assisted",
};

export interface GatedFeatureSpec {
  key: GatedFeatureKey;
  name: string;
  /** One line, for the admin screen and the locked/upgrade state. */
  description: string;
  /**
   * The entitlement that must be present. Absent module = `unavailable`,
   * which §3A.1 step 2 calls "locked, show upgrade prompt".
   *
   * `call_intel` and not `aura`: the agent reads a word-for-word account of a
   * customer's phone call, and `org-modules.ts` already records that who may
   * read one is "a decision per client contract, not a product default".
   */
  module: OrgModule;
  /** Modes this feature understands, lowest first. */
  modes: readonly AgentMode[];
  capabilities: readonly AgentCapability[];
  /** §18: `suggest` on first enablement. */
  defaultModeOnEnable: AgentMode;
  /**
   * What a fresh enablement switches on. Deliberately the three that cannot
   * reach a customer: §18's "feature default OFF" applies to the feature, and
   * the same caution applies one level down.
   */
  defaultCapabilitiesOnEnable: readonly AgentCapability[];
  /**
   * §3A.5: first enablement needs an owner's acknowledgement of the recording,
   * transcription, data-processing and messaging-consent notice. Bump this when
   * the notice text changes and every org acknowledges again.
   */
  consentNoticeVersion: string;
}

export const GATED_FEATURES: readonly GatedFeatureSpec[] = [
  {
    key: "transcript_agent",
    name: "Transcript assistant",
    description:
      "Reads what was said on a call and turns it into the work it implies - a call-back at the time the customer asked for, a follow-up, an appointment, a summary.",
    module: "call_intel",
    modes: MODE_ORDER,
    capabilities: AgentCapability.options,
    defaultModeOnEnable: "suggest",
    defaultCapabilitiesOnEnable: ["record", "tasks", "callbacks"],
    consentNoticeVersion: "2026-10-09",
  },
];

const GATED_BY_KEY = new Map<GatedFeatureKey, GatedFeatureSpec>(
  GATED_FEATURES.map((f) => [f.key, f]),
);

export function gatedFeatureSpec(key: GatedFeatureKey): GatedFeatureSpec {
  const spec = GATED_BY_KEY.get(key);
  if (!spec) throw new Error(`unknown gated feature: ${key}`);
  return spec;
}

// ── Stored settings ─────────────────────────────────────────────────────────

/**
 * §3A.1's scopes, broadest first.
 *
 * `platform` and `plan` are NOT stored in `feature_settings`:
 *
 *   · `platform` is an env var (`FEATURE_GATE_KILL_SWITCH`). A platform-wide
 *     kill switch has to work when the database is the thing that is wrong, and
 *     `verify-rls.js` fails the build for a public table with no `org_id` -
 *     its allowlist is short on purpose and a kill switch does not earn a row.
 *   · `plan` is `organizations.enabled_modules` (0072), already the resolved
 *     entitlement and already the ceiling a client switch cannot widen.
 *
 * They are in the enum anyway so a `GateDecision` can SAY which scope refused.
 */
export const GateScopeType = z.enum(["platform", "plan", "org", "team", "role", "user"]);
export type GateScopeType = z.infer<typeof GateScopeType>;

/** The scopes that are actually rows. */
export const STORED_GATE_SCOPES: readonly GateScopeType[] = ["org", "team", "role", "user"];

/**
 * `inherit` is not "off". It is the absence of a decision at this scope, and it
 * is the difference between a team that has been deliberately excluded and a
 * team nobody has thought about yet - §3A.1 step 4 walks past the second and
 * stops at the first.
 */
export const GateSettingState = z.enum(["on", "off", "inherit"]);
export type GateSettingState = z.infer<typeof GateSettingState>;

/** One row of `feature_settings`, as the resolver wants it. */
export interface GateSetting {
  scopeType: GateScopeType;
  /** NULL for `org` (the org is the connection's own); the team/role/user id otherwise. */
  scopeId: string | null;
  state: GateSettingState;
  /**
   * For an `org` row this is the MAXIMUM mode; for the narrower scopes it is
   * the mode asked for. Null means "whatever is inherited".
   */
  mode: AgentMode | null;
  /**
   * For an `org` row this is the maximum capability set; narrower scopes
   * request a subset. Null means inherited.
   */
  capabilities: readonly AgentCapability[] | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

/** Is this row in force at `now`? §3A.5's scheduled changes. */
export function settingInForce(setting: GateSetting, now: Date): boolean {
  if (setting.effectiveFrom && setting.effectiveFrom.getTime() > now.getTime()) return false;
  if (setting.effectiveTo && setting.effectiveTo.getTime() <= now.getTime()) return false;
  return true;
}

// ── The decision ────────────────────────────────────────────────────────────

/**
 * Why the gate said what it said.
 *
 * `feature_disabled` is the machine-readable code §3A.4 asks the API to return.
 * The others exist because "you have not bought this", "your owner switched it
 * off" and "we switched it off for everybody" are three different
 * conversations - the same argument `FeatureState` makes in `features.ts`.
 */
export const GateDenialReason = z.enum([
  "platform_kill_switch",
  "plan_missing",
  "org_off",
  "scope_off",
  "no_decision",
  "mode_off",
  "capability_off",
  "capability_above_mode",
  "usage_cap_reached",
  "gate_unavailable",
]);
export type GateDenialReason = z.infer<typeof GateDenialReason>;

/** The scope that produced the answer, for the audit snapshot (§3A.4). */
export interface GateScopeTrace {
  scopeType: GateScopeType;
  scopeId: string | null;
  state: GateSettingState | "absent";
  mode: AgentMode | null;
}

export interface GateDecision {
  feature: GatedFeatureKey;
  /** Is the feature on for this subject at all? */
  enabled: boolean;
  /** `off` whenever `enabled` is false. Never above the org maximum. */
  mode: AgentMode;
  /** The capabilities that are BOTH granted and permitted by `mode`. */
  capabilities: readonly AgentCapability[];
  /**
   * True when the org's plan does not include the feature. The console shows
   * this as a locked row with an upgrade prompt (owners only) rather than an
   * off switch - §3A.6.
   */
  lockedByPlan: boolean;
  reason: GateDenialReason | "enabled";
  /** Every scope consulted, broadest first. Stored on `agent_runs`. */
  scopes: readonly GateScopeTrace[];
  /** The subject this answers for. */
  subject: GateSubject;
}

/**
 * WHO the question is about.
 *
 * ── THE ONE PLACE THIS PLATFORM AND §3A DISAGREE ────────────────────────────
 *
 * §3A.3 keys the processing gate on "the telecaller who handled the call", and
 * assumes that is a user. On this platform it often is not: `telecallers.user_id`
 * is nullable since 0017 because most telecallers carry a paired handset and
 * have never signed in to anything. Lead routing already skips them for exactly
 * this reason, and a gate keyed only on `users` would therefore silently refuse
 * to process the calls of the majority of a floor - the most expensive possible
 * failure, because it looks like the feature working.
 *
 * So a subject is a user id, a telecaller id, or both. A telecaller with no
 * user simply has no `user` scope to find and falls through to its team, its
 * role and then the org default, which is the correct reading of §3A.1 step 4.
 */
export interface GateSubject {
  userId: string | null;
  telecallerId: string | null;
  /** `teams.id` (0177), if the subject sits in one. */
  teamId: string | null;
  /** `memberships.owner_role`, if the subject has a login. */
  ownerRole: string | null;
}

export interface GateInput {
  feature: GatedFeatureKey;
  subject: GateSubject;
  /** `organizations.enabled_modules`. The plan ceiling. */
  enabledModules: readonly string[];
  /** Every `feature_settings` row for this feature and org. */
  settings: readonly GateSetting[];
  /** `FEATURE_GATE_KILL_SWITCH` named this feature. */
  platformKillSwitch: boolean;
  /** §3A.7: the hard cap has been hit, so fall back to `record` only. */
  capState?: GateCapState;
  now: Date;
}

const DENIED_CAPABILITIES: readonly AgentCapability[] = [];

function deny(
  input: GateInput,
  reason: GateDenialReason,
  scopes: GateScopeTrace[],
  lockedByPlan = false,
): GateDecision {
  return {
    feature: input.feature,
    enabled: false,
    mode: "off",
    capabilities: DENIED_CAPABILITIES,
    lockedByPlan,
    reason,
    scopes,
    subject: input.subject,
  };
}

/**
 * §3A.1, as written, in order.
 *
 * ── THE SHAPE OF THIS FUNCTION IS THE SPECIFICATION ─────────────────────────
 *
 * Every step is a separate early return and every early return DENIES. The one
 * path that grants is the last line. §3A.4's "fail closed" is therefore
 * structural rather than a branch somebody has to remember: a step added in the
 * middle that forgets to decide falls through to the next denial, and a step
 * that throws is caught by the caller as `gate_unavailable`, which also denies.
 *
 * ── AN EXPLICIT OFF AT ANY HIGHER SCOPE ALWAYS WINS ─────────────────────────
 *
 * Not "a narrower scope overrides a broader one". The walk looks at org, then
 * team/role, then user, and an `off` found at ANY of them ends it - so a team
 * excluded from the trial cannot be opted back in by one of its members'
 * personal setting. §3A.1's closing sentence says exactly this and it is the
 * rule most likely to be implemented backwards, because "most specific wins" is
 * the reflex everywhere else.
 */
export function resolveGate(input: GateInput): GateDecision {
  const spec = GATED_BY_KEY.get(input.feature);
  const scopes: GateScopeTrace[] = [];

  // An unknown feature is a programming error reaching a gate. Deny rather
  // than throw: a 403 is recoverable and an unhandled exception inside a
  // worker's tool loop is not.
  if (!spec) return deny(input, "gate_unavailable", scopes);

  // ── 1. Platform kill switch ──────────────────────────────────────────────
  scopes.push({
    scopeType: "platform",
    scopeId: null,
    state: input.platformKillSwitch ? "off" : "inherit",
    mode: null,
  });
  if (input.platformKillSwitch) return deny(input, "platform_kill_switch", scopes);

  // ── 2. Plan / entitlement ────────────────────────────────────────────────
  const hasModule = input.enabledModules.includes(spec.module);
  scopes.push({
    scopeType: "plan",
    scopeId: spec.module,
    state: hasModule ? "inherit" : "off",
    mode: null,
  });
  if (!hasModule) return deny(input, "plan_missing", scopes, true);

  const inForce = input.settings.filter((s) => settingInForce(s, input.now));

  // ── 3. Org master switch ─────────────────────────────────────────────────
  const orgRow = inForce.find((s) => s.scopeType === "org");
  scopes.push({
    scopeType: "org",
    scopeId: null,
    state: orgRow?.state ?? "absent",
    mode: orgRow?.mode ?? null,
  });
  // Absent is OFF, not "inherit from nowhere": §18's feature default is OFF for
  // the org and every user until the owner enables it. An org that has never
  // been configured must behave exactly like one that was switched off.
  if (!orgRow || orgRow.state !== "on") return deny(input, "org_off", scopes);

  const orgMaxMode = orgRow.mode ?? spec.defaultModeOnEnable;
  const orgCapabilities = orgRow.capabilities ?? spec.defaultCapabilitiesOnEnable;

  // ── 4. team / role / user, narrowest decision wins; any OFF ends it ──────
  //
  // Collected broad-to-narrow so the trace reads in resolution order, then
  // read narrow-to-broad for the decision.
  const teamRow = input.subject.teamId
    ? inForce.find((s) => s.scopeType === "team" && s.scopeId === input.subject.teamId)
    : undefined;
  const roleRow = input.subject.ownerRole
    ? inForce.find((s) => s.scopeType === "role" && s.scopeId === input.subject.ownerRole)
    : undefined;
  const userRow = input.subject.userId
    ? inForce.find((s) => s.scopeType === "user" && s.scopeId === input.subject.userId)
    : undefined;

  for (const [scopeType, scopeId, row] of [
    ["team", input.subject.teamId, teamRow],
    ["role", input.subject.ownerRole, roleRow],
    ["user", input.subject.userId, userRow],
  ] as const) {
    scopes.push({
      scopeType,
      scopeId: scopeId ?? null,
      state: row?.state ?? "absent",
      mode: row?.mode ?? null,
    });
  }

  // Explicit OFF anywhere above the subject wins, per §3A.1's closing rule.
  for (const row of [teamRow, roleRow, userRow]) {
    if (row && row.state === "off") return deny(input, "scope_off", scopes);
  }

  // The narrowest row that says something. A `user` row beats `role`, which
  // beats `team`; none of them beats the org's ON, which is step 3's job.
  const decided = [userRow, roleRow, teamRow].find((row) => row && row.state === "on");
  if (!decided) {
    // §3A.1 step 4's last line: "else org default (default: OFF)". The org row
    // being ON is a MASTER switch, not a grant to everybody - otherwise
    // enabling the feature would switch it on for a hundred telecallers at
    // once, which is the opposite of what §3A.6's per-user table is for.
    //
    // An org that genuinely wants everybody has a `role` row per persona or a
    // `team` row per team; the admin screen's bulk apply writes exactly those.
    return deny(input, "no_decision", scopes);
  }

  // ── 5. Mode = the lower of the subject's and the org's maximum ───────────
  const requested = decided.mode ?? orgMaxMode;
  let mode = lowerMode(requested, orgMaxMode);

  // ── 6. Capabilities: granted at this scope, within the org's set, and
  //       permitted by the mode ────────────────────────────────────────────
  const requestedCapabilities = decided.capabilities ?? orgCapabilities;
  const orgCapabilitySet = new Set(orgCapabilities);

  // §3A.7's hard cap degrades rather than stops: "the feature falls back to
  // `record`-only or `off`". Applied HERE rather than as a sixth early return,
  // because a capped org must still get its summaries - the owner is alerted
  // and the expensive half stops.
  if (input.capState === "hard") {
    mode = lowerMode(mode, "shadow");
  }

  const capabilities = spec.capabilities.filter(
    (capability) =>
      requestedCapabilities.includes(capability) &&
      orgCapabilitySet.has(capability) &&
      modeAtLeast(mode, CAPABILITY_MIN_MODE[capability]),
  );

  if (mode === "off") return deny(input, "mode_off", scopes);

  return {
    feature: input.feature,
    enabled: true,
    mode,
    capabilities,
    lockedByPlan: false,
    reason: "enabled",
    scopes,
    subject: input.subject,
  };
}

/**
 * The gate's answer when it could not be computed. §3A.4: "if the gate service
 * or its data is unavailable, deny."
 *
 * Exported rather than constructed at each call site so there is exactly one
 * shape for "we do not know", and so a log search for `gate_unavailable` finds
 * every occurrence.
 */
export function gateUnavailable(
  feature: GatedFeatureKey,
  subject: GateSubject,
): GateDecision {
  return {
    feature,
    enabled: false,
    mode: "off",
    capabilities: DENIED_CAPABILITIES,
    lockedByPlan: false,
    reason: "gate_unavailable",
    scopes: [],
    subject,
  };
}

/**
 * Does this decision permit this capability? The ONE question the planner, the
 * executor and every UI ask.
 *
 * Takes the decision rather than re-resolving, because §3A.4 requires the
 * executor to re-check before every tool call and re-resolving per tool would
 * be a database round trip per action against a database ~125ms away. The
 * freshness requirement is met by re-reading the DECISION (one cached read per
 * action), not by recomputing it from five scopes.
 */
export function gateAllows(decision: GateDecision, capability: AgentCapability): boolean {
  return decision.enabled && decision.capabilities.includes(capability);
}

// ── Usage caps and metering (§3A.7) ─────────────────────────────────────────

export const GateCapState = z.enum(["ok", "warn", "hard"]);
export type GateCapState = z.infer<typeof GateCapState>;

/** What is metered. `model_cost_minor` is in paise, like every other cost. */
export const GateUsageMetric = z.enum(["transcripts", "audio_minutes", "model_cost_minor"]);
export type GateUsageMetric = z.infer<typeof GateUsageMetric>;

export interface GateLimit {
  metric: GateUsageMetric;
  /** Warn here. Null = no warning. */
  softLimit: number | null;
  /** Stop here. Null = no stop, which is the default for every metric. */
  hardLimit: number | null;
}

export interface GateUsage {
  transcripts: number;
  audioMinutes: number;
  modelCostMinor: number;
}

function usageOf(usage: GateUsage, metric: GateUsageMetric): number {
  switch (metric) {
    case "transcripts":
      return usage.transcripts;
    case "audio_minutes":
      return usage.audioMinutes;
    case "model_cost_minor":
      return usage.modelCostMinor;
  }
}

export interface CapEvaluation {
  state: GateCapState;
  /** Which metric produced the state, for the alert's wording. */
  metric: GateUsageMetric | null;
  used: number;
  limit: number | null;
  /** 0..1, or null where the metric has no limit. The admin table's bar. */
  fraction: number | null;
}

/**
 * §3A.7: warn at 80 %, hard stop at 100 %.
 *
 * The WORST state across every metric wins, and the metric that produced it
 * travels with the answer - an owner told "you have hit your limit" without
 * being told which limit cannot act on it.
 *
 * A limit of 0 is a real limit (stop immediately), which is why every
 * comparison is `>=` against an explicit null check rather than a truthiness
 * test. A soft limit defaults to 80 % of the hard one when only the hard one is
 * set, so an owner who types one number still gets the warning §3A.7 promises.
 */
export function evaluateCaps(
  usage: GateUsage,
  limits: readonly GateLimit[],
  now: Date = new Date(),
): CapEvaluation {
  void now; // present for symmetry with the rest of this file; periods are the caller's.
  let worst: CapEvaluation = { state: "ok", metric: null, used: 0, limit: null, fraction: null };

  for (const limit of limits) {
    const used = usageOf(usage, limit.metric);
    const hard = limit.hardLimit;
    const soft = limit.softLimit ?? (hard === null ? null : Math.floor(hard * 0.8));

    const fraction = hard === null || hard === 0 ? null : used / hard;
    let state: GateCapState = "ok";
    if (hard !== null && used >= hard) state = "hard";
    else if (soft !== null && used >= soft) state = "warn";

    if (state === "ok") continue;
    if (worst.state === "hard") continue;
    if (worst.state === "warn" && state === "warn") continue;
    worst = { state, metric: limit.metric, used, limit: hard, fraction };
  }

  return worst;
}

// ── Write-side schemas (§3A.8) ──────────────────────────────────────────────

const CapabilityList = z
  .array(AgentCapability)
  .max(AgentCapability.options.length)
  .transform((caps) => [...new Set(caps)]);

/**
 * No `.default()` on anything here, and that is deliberate.
 *
 * `Input.partial()` keeps a `.default()`, so a PATCH that omitted `mode` would
 * silently overwrite the org's maximum with the schema's idea of a default.
 * That trap has one live instance in this codebase already (outreach cadences);
 * it is not getting a second. A field the caller left out must be ABSENT in the
 * parsed object so the handler can tell "unchanged" from "set to this".
 */
export const GateOrgSettingInput = z.object({
  state: z.enum(["on", "off"]),
  /** The org MAXIMUM. Everything narrower is clamped to it. */
  maxMode: AgentMode,
  capabilities: CapabilityList,
  /** §3A.5's scheduled change. Absent = now. */
  effectiveFrom: z.string().datetime({ offset: true }).nullish(),
  effectiveTo: z.string().datetime({ offset: true }).nullish(),
  reason: z.string().trim().max(500).nullish(),
});
export type GateOrgSettingInput = z.infer<typeof GateOrgSettingInput>;

export const GateSubjectSettingInput = z.object({
  state: GateSettingState,
  mode: AgentMode.nullish(),
  capabilities: CapabilityList.nullish(),
  effectiveFrom: z.string().datetime({ offset: true }).nullish(),
  effectiveTo: z.string().datetime({ offset: true }).nullish(),
  reason: z.string().trim().max(500).nullish(),
});
export type GateSubjectSettingInput = z.infer<typeof GateSubjectSettingInput>;

export const GateBulkTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("users"), userIds: z.array(z.string().uuid()).min(1).max(500) }),
  z.object({ kind: z.literal("team"), teamId: z.string().uuid() }),
  z.object({ kind: z.literal("role"), ownerRole: z.string().min(1).max(40) }),
]);
export type GateBulkTarget = z.infer<typeof GateBulkTarget>;

export const GateBulkInput = z.object({
  target: GateBulkTarget,
  setting: GateSubjectSettingInput,
});
export type GateBulkInput = z.infer<typeof GateBulkInput>;

/**
 * §3A.5's backfill. Three constraints are in the SCHEMA rather than the
 * handler, because every one of them is a spend-money-on-old-calls mistake
 * that cannot be undone once it has run:
 *
 *   · `days` is capped at 7 (§18).
 *   · the mode is not a parameter at all - a backfill is always `suggest`.
 *   · `sendMessages` does not exist as a field. §3A.5: "no customer messages".
 *     A field that can be set to true is a field somebody sets to true.
 */
export const GateBackfillInput = z.object({
  days: z.number().int().min(1).max(7),
  userIds: z.array(z.string().uuid()).min(1).max(200),
  /** A preview returns counts and estimated cost and starts nothing. */
  confirm: z.boolean(),
});
export type GateBackfillInput = z.infer<typeof GateBackfillInput>;

/**
 * What the admin screen needs to draw one row of §3A.6's users table. Assembled
 * by the API; shaped here so the console and the API cannot disagree about what
 * "last activity" means.
 */
export interface GateUserRow {
  userId: string | null;
  telecallerId: string | null;
  name: string;
  /** The seat title from the org chart, where there is one. */
  position: string | null;
  teamId: string | null;
  teamName: string | null;
  ownerRole: string | null;
  state: GateSettingState;
  /** The EFFECTIVE mode, after clamping - not the stored one. */
  mode: AgentMode;
  capabilities: readonly AgentCapability[];
  effectiveFrom: string | null;
  effectiveTo: string | null;
  lastActivityAt: string | null;
  usage: GateUsage;
  /**
   * §3A.7: "show usage and cost per user next to measured accuracy, so owners
   * can decide where the feature pays off". Null until there are enough
   * reviewed cases to mean anything - a precision of 1.0 over two decisions is
   * a number that misleads, and §13.3's gate needs 200.
   */
  precision: number | null;
  reviewedCases: number;
}
