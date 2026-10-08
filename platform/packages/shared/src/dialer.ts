/**
 * THE DIALER'S SHARED VOCABULARY (Build docs/39 §7-§10, migration 0159).
 *
 * ── WHY THESE TYPES ARE NOT IN THE API ──────────────────────────────────────
 *
 * Three processes have to agree on every string in this file:
 *
 *   - the API, which writes `dial_campaigns.mode` and reads it back;
 *   - the console, which renders a mode picker and a live board;
 *   - the HANDSET, which claims an item, reports a result, and decides at
 *     dial time whether it may still ring the number.
 *
 * `dialable.ts` already made that argument for the predicate. This is the
 * argument's other half: a predicate three callers share is worth nothing if
 * each of them spells `cancelled_by_agent` differently, and a result string
 * the database refuses arrives as a 23514 that reads like a bug in the phone.
 * Every literal below is transcribed from 0159's CHECK constraints and the
 * tests at the bottom of this module's suite assert the sets are EQUAL rather
 * than merely overlapping - the drift trap `notifications.kind` already paid
 * for in both directions at once.
 *
 * ── THE ONE THING THAT IS NOT HERE ──────────────────────────────────────────
 *
 * Dialability. `dialable.ts` owns it, the three callers import it from there,
 * and this file deliberately re-exports nothing of it - two modules exporting
 * one name through the shared index's `export *` is an ambiguity waiting for
 * whichever lands second, which is the same reason `DialConsentBasis` is
 * spelled with its prefix.
 *
 * What this file DOES add is `isPersistentDialBlock`, because the split it
 * draws is not dialability's business and would not belong there: dialability
 * answers "may we, now", and every caller then has to decide what to DO with a
 * no. See its own comment.
 */

import { z } from "zod";
import type { DialBlockReason } from "./dialable";

// ── Campaign vocabulary, transcribed from 0159 ──────────────────────────────

/**
 * `preview` hands the agent a record and waits for them to press Call.
 * `progressive` dials the next one by itself after `advanceDelaySec`.
 *
 * A handset that was refused the CALL_PHONE runtime grant degrades to
 * `preview` for itself (§9) regardless of what the campaign says - it can only
 * fire ACTION_DIAL, which pre-fills the dialer and waits for a human thumb.
 */
export const DialCampaignMode = z.enum(["preview", "progressive"]);
export type DialCampaignMode = z.infer<typeof DialCampaignMode>;

/** Where the records come from. Resolved at build time, never frozen as ids. */
export const DialSourceKind = z.enum(["saved_view", "board", "filter"]);
export type DialSourceKind = z.infer<typeof DialSourceKind>;

/**
 * The order records are worked in.
 *
 * `temperature` reads `leads.temperature` (0083): Hot > Medium > Cold. NEVER
 * `leads.score` - that is the extraction's confidence heuristic and reusing it
 * as a rating is explicitly forbidden, which is exactly the kind of mistake a
 * closed enum here prevents somebody from making in a query string.
 */
export const DialPriority = z.enum(["temperature", "oldest", "newest", "value"]);
export type DialPriority = z.infer<typeof DialPriority>;

export const DialCampaignStatus = z.enum(["draft", "active", "paused", "completed"]);
export type DialCampaignStatus = z.infer<typeof DialCampaignStatus>;

/**
 * A queue item's life.
 *
 *   queued   waiting its turn
 *   locked   leased to a handset for DIAL_LEASE_SECONDS
 *   dialed   an attempt was placed and the record KEEPS ITS TURN - attempts
 *            remain and the retry gap is what holds it back, not this state
 *   done     no more attempts from this campaign (connected, or the ceiling)
 *   skipped  an agent passed on it, with a reason
 *   blocked  dialability() said no, permanently - see isPersistentDialBlock
 *
 * The distinction that matters is `dialed` vs `done`. A no-answer leaves the
 * record dialable: `max_attempts` of 3 means three tries, and a state machine
 * that retired the record on the first ring would make the setting a lie.
 */
export const DialQueueItemState = z.enum([
  "queued",
  "locked",
  "dialed",
  "done",
  "skipped",
  "blocked",
]);
export type DialQueueItemState = z.infer<typeof DialQueueItemState>;

/** The states a handset may claim from. `dialed` is in it; see above. */
export const CLAIMABLE_DIAL_STATES: readonly DialQueueItemState[] = ["queued", "dialed"];

/**
 * The handset's read of the DIAL MECHANICS, from READ_PHONE_STATE.
 *
 * Not the disposition. A disposition is a human judgement about the
 * conversation ("interested", "wrong number") and lives on the call, where
 * 0144's resolution model already handles it. Conflating the two would let the
 * phone decide an outcome, and the one thing the phone knows is whether the
 * line was picked up.
 */
export const DialAttemptResult = z.enum([
  "connected",
  "no_answer",
  "busy",
  "rejected",
  "failed",
  "invalid_number",
  "cancelled_by_agent",
]);
export type DialAttemptResult = z.infer<typeof DialAttemptResult>;

/** Agent-facing copy for a result, so three surfaces cannot word it three ways. */
export const DIAL_RESULT_LABELS: Record<DialAttemptResult, string> = {
  connected: "Connected",
  no_answer: "No answer",
  busy: "Busy",
  rejected: "Rejected",
  failed: "Call failed",
  invalid_number: "Invalid number",
  cancelled_by_agent: "Cancelled",
};

/**
 * A result that ends the record's run through this campaign.
 *
 * Only `connected`. Everything else is a reason to try again later, which is
 * what `retry_after_hours` and `max_attempts` are for. `invalid_number` is the
 * tempting second entry and is deliberately absent: the phone reporting an
 * invalid number is a network answer, not a verdict on the vault row, and
 * retiring a record on it would silently delete a customer from a campaign on
 * one bad handset's say-so.
 */
export function dialResultEndsRecord(result: DialAttemptResult | null): boolean {
  return result === "connected";
}

// ── The lease, and the matching window ──────────────────────────────────────

/**
 * §7's 120-second optimistic lease.
 *
 * Long enough for an agent to read the previous call's summary and press Call,
 * short enough that a phone which dies mid-queue releases its record while the
 * shift is still running. An expired lease is RECLAIMABLE, which is the whole
 * point: nothing reaps it, the next claim simply takes it.
 */
export const DIAL_LEASE_SECONDS = 120;

/**
 * §10's matching window, in seconds either side of `dialed_at`.
 *
 * Asymmetric on purpose. A `calls` row can be stamped slightly BEFORE the
 * attempt report reaches us (clock skew, and the handset writes its own
 * `started_at`), but the long tail is on the other side: ACTION_CALL to the
 * recorder noticing an outgoing call is where the seconds go.
 */
export const DIAL_MATCH_BEFORE_SECONDS = 30;
export const DIAL_MATCH_AFTER_SECONDS = 120;

/**
 * How long the matcher keeps looking before it gives up. §10: "the sweep
 * retries for 24h".
 */
export const DIAL_MATCH_WINDOW_HOURS = 24;

// ── What a caller does with a `no` ──────────────────────────────────────────

/**
 * Is this block a fact about the record, or about the clock?
 *
 * ── WHY THIS SPLIT EXISTS, AND WHY IT IS NOT IN dialable.ts ─────────────────
 *
 * `dialability()` answers one question and answers it completely. But the
 * queue has to do something with the answer, and the right something differs:
 *
 *   PERSISTENT - five of the eight. Nothing that happens today changes
 *   them, so the item is written `state = 'blocked'` with the reason stored
 *   verbatim, and the agent screen greys it out and says why. Leaving it
 *   `queued` would make every claim re-evaluate a record that can never be
 *   dialled, which is a queue that gets slower the longer it runs.
 *
 *   TRANSIENT - `person_daily_cap`, `quiet_hours` and `retry_too_soon`. All
 *   three become false by themselves. Persisting them as `blocked` is the
 *   dangerous mistake: it retires a perfectly good record because an agent
 *   happened to reach it at 21:05, and nothing would ever put it back. These
 *   leave the item `queued`.
 *
 * ── THE TIERS ARE NO LONGER THE CUT ─────────────────────────────────────────
 *
 * They were, until `person_daily_cap` was added. That reason sits in tier 2 of
 * DIAL_BLOCK_ORDER, because what a supervisor needs told is ordered by how long
 * the block lasts and a day outlasts an evening - but it is TRANSIENT here,
 * because midnight clears it and a record retired for hitting today's ceiling
 * would never dial again.
 *
 * So tier 2 now straddles the line: `max_attempts` is persistent and
 * `person_daily_cap` is not. Do not re-derive this set from the array's
 * indices to "simplify" it; the two orderings answer different questions and
 * only coincided by luck. That this list is written out by hand is what makes
 * the divergence safe.
 */
export const PERSISTENT_DIAL_BLOCKS: ReadonlySet<DialBlockReason> = new Set<DialBlockReason>([
  "no_number",
  "consent_unknown",
  "opt_out",
  "dnc_list",
  "max_attempts",
]);

export function isPersistentDialBlock(reason: DialBlockReason): boolean {
  return PERSISTENT_DIAL_BLOCKS.has(reason);
}

// ── Request bodies ──────────────────────────────────────────────────────────

const CampaignName = z.string().trim().min(1, "Name this campaign.").max(120);

/**
 * The ad-hoc filter, and the shape a saved view's stored query is read as.
 *
 * Deliberately a SMALL, CLOSED set rather than a pass-through of the leads
 * list's whole query string. `source_filter` is jsonb and anything could be
 * put in it; a filter the queue builder does not understand is a filter the
 * PREVIEW does not understand either, and the two disagreeing about which
 * records are in scope is the precise failure §5 exists to prevent. An
 * unrecognised key is dropped, loudly, rather than guessed at.
 */
export const DialSourceFilter = z
  .object({
    /** `leads.stage` - any of these. Empty means every stage. */
    stage: z.array(z.string().trim().min(1).max(60)).max(16).optional(),
    /** `leads.status`. Defaults to open-only at the query, not here. */
    status: z.array(z.enum(["open", "won", "lost"])).max(3).optional(),
    /** `leads.temperature` (0083). */
    temperature: z.array(z.enum(["hot", "medium", "cold"])).max(3).optional(),
    assignedTelecallerId: z.string().uuid().nullable().optional(),
    boardId: z.string().uuid().nullable().optional(),
    createdAfter: z.string().datetime({ offset: true }).optional(),
    createdBefore: z.string().datetime({ offset: true }).optional(),
    /**
     * Archived leads are out by default and this is the only way back in.
     * 0154 archives a lead precisely so it stops appearing in work lists, and
     * a campaign that swept them back up would undo somebody's decision in
     * bulk.
     */
    includeArchived: z.boolean().optional(),
  })
  .strict();
export type DialSourceFilter = z.infer<typeof DialSourceFilter>;

export const CreateDialCampaignInput = z.object({
  name: CampaignName,
  workspaceId: z.string().uuid(),
  mode: DialCampaignMode.default("preview"),
  advanceDelaySec: z.number().int().min(0).max(60).default(5),
  sourceKind: DialSourceKind,
  sourceRef: z.string().uuid().nullable().optional(),
  sourceFilter: DialSourceFilter.default({}),
  priority: DialPriority.default("temperature"),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /**
   * No CHECK on the column, by §5.3's decision, so zero and negatives are
   * storable - but an API is allowed to be stricter than its schema, and a
   * negative gap means nothing an owner could have intended. Zero is kept
   * legal and means "no gap".
   */
  retryAfterHours: z.number().int().min(0).max(24 * 30).default(24),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type CreateDialCampaignInput = z.infer<typeof CreateDialCampaignInput>;

/**
 * HAND-BUILT. NOT `CreateDialCampaignInput.partial()`.
 *
 * ── THE BUG THIS AVOIDS, WHICH IS LIVE IN THIS CODEBASE TODAY ──────────────
 *
 * `.partial()` makes every key optional. It does NOT remove `.default()`, so
 * parsing `{ "name": "Q4 winbacks" }` through a partialled schema that has
 * `mode: DialCampaignMode.default("preview")` yields
 * `{ name: "Q4 winbacks", mode: "preview" }` - a value the caller never sent,
 * indistinguishable at the handler from one they did. A supervisor renaming a
 * progressive campaign would silently put the whole floor back into preview
 * mode, and nothing would log a thing.
 *
 * There is one live instance of exactly this in outreach cadences, and doc 39
 * §8 flags it again for this very route. Every field below is therefore
 * declared `.optional()` with NO default, and the handler COALESCEs against
 * the stored row so an omitted field is genuinely omitted.
 */
export const UpdateDialCampaignInput = z
  .object({
    name: CampaignName.optional(),
    mode: DialCampaignMode.optional(),
    advanceDelaySec: z.number().int().min(0).max(60).optional(),
    sourceKind: DialSourceKind.optional(),
    sourceRef: z.string().uuid().nullable().optional(),
    sourceFilter: DialSourceFilter.optional(),
    priority: DialPriority.optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    retryAfterHours: z.number().int().min(0).max(24 * 30).optional(),
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to update");
export type UpdateDialCampaignInput = z.infer<typeof UpdateDialCampaignInput>;

/**
 * The three org-wide dial settings, as the console reads and writes them
 * (Build docs/40 §B1).
 *
 * ── WHY THESE EXISTED WITH NO WRITER AT ALL ─────────────────────────────────
 *
 * 0157 added the columns, `dialability()` enforces them and the handset obeys
 * them - but nothing in the product could SET them. There was no console route
 * and no screen, so `dialer_max_calls_per_person_per_day` was NULL for every
 * tenant that has ever existed and the per-person ceiling was unreachable
 * rather than merely defaulted-off. A ceiling nobody can raise is not a default;
 * it is an absent feature with a column.
 *
 * The calling window is the same story in a milder form: 09:00-21:00 in the
 * org's reporting timezone was the only window any tenant could ever have.
 */
export interface DialSettingsView {
  allowsUnknownConsent: boolean;
  startHour: number;
  endHour: number;
  /** Read-only here: it follows `reporting_timezone`, set under Time & location. */
  timeZone: string;
  /** null is UNCAPPED, and that remains the shipped default. */
  personDailyCap: number | null;
  /** Whether this caller may change the above, so the page can say so. */
  canEdit: boolean;
}

export const UpdateDialSettingsInput = z
  .object({
    allowsUnknownConsent: z.boolean().optional(),
    // 0..23, and the window is validated as a PAIR below rather than per field:
    // a start of 21 and an end of 9 are each individually legal hours.
    startHour: z.number().int().min(0).max(23).optional(),
    endHour: z.number().int().min(0).max(23).optional(),
    // Matches 0157's CHECK exactly - BETWEEN 1 AND 50, or null for uncapped.
    // Drift here would surface as a 23514 reading like a bug in the console, the
    // same failure `notifications.kind` produced twice.
    personDailyCap: z.number().int().min(1).max(50).nullable().optional(),
  })
  // Hand-built, NOT `.partial()` of a create schema: `.partial()` keeps
  // `.default()`, so a PATCH that touched only the cap would quietly rewrite the
  // calling window to whatever the defaults said. One live instance of that bug
  // already exists in outreach cadences.
  .refine((b) => Object.keys(b).length > 0, "nothing to update")
  .refine(
    // A window must be a window. `startHour === endHour` is the dangerous one:
    // read as "ring for zero hours" it stops the floor dead, and read as "ring
    // for 24" it rings at 3am. Refusing it means neither reading can happen.
    //
    // THIS IS NOT THE WHOLE CHECK, and treating it as such is the trap. It can
    // only see a body carrying BOTH hours; a PATCH sending `startHour: 22`
    // against a stored `endHour` of 21 passes here and still inverts the
    // window. The complete check needs the stored row, so it lives in the
    // controller, over the MERGED values - `dialWindowOrdered` below, called
    // from both places so the two cannot disagree.
    (b) => dialWindowOrdered(b.startHour, b.endHour),
    { message: "The calling window must start before it ends.", path: ["endHour"] },
  );
export type UpdateDialSettingsInput = z.infer<typeof UpdateDialSettingsInput>;

/**
 * Is this a window somebody can ring inside?
 *
 * `undefined` on either side means "not being changed", which only the zod
 * refine above passes - the controller resolves both against the stored row
 * first, so by the time it asks, both are numbers.
 */
export function dialWindowOrdered(startHour?: number, endHour?: number): boolean {
  if (startHour === undefined || endHour === undefined) return true;
  return startHour < endHour;
}

export const BuildDialQueueInput = z.object({
  /**
   * Whom to hand the records to, round-robin in the order given. Empty leaves
   * every item unassigned, which any agent on the campaign may then claim -
   * the right default for a small floor, and the reason assignment is on the
   * ITEM rather than the campaign.
   */
  assignUserIds: z.array(z.string().uuid()).max(200).default([]),
});
export type BuildDialQueueInput = z.infer<typeof BuildDialQueueInput>;

/**
 * An agent passing on the record in front of them.
 *
 * The reason is REQUIRED and free text. A skip with no reason is
 * indistinguishable from a queue nobody worked, and the supervisor screen's
 * only honest answer to "why did 200 records get skipped" is the agents' own
 * words.
 */
export const SkipDialQueueItemInput = z.object({
  reason: z.string().trim().min(1, "Say why you are skipping this record.").max(280),
});
export type SkipDialQueueItemInput = z.infer<typeof SkipDialQueueItemInput>;

/**
 * The handset's attempt report.
 *
 * `clientRef` is the phone's own idempotency key, same contract as the call
 * upload: a report retried after a lost response is stored once and the replay
 * gets the stored attempt back. Without it a flaky lift double-counts the dial
 * AND steps the record past `max_attempts`.
 *
 * `dialedAt` comes from the PHONE, not from the server's clock, because the
 * phone may have been offline for an hour when it drains its pending reports
 * (§9). That is also why `dialability()` blocks on a last attempt in the
 * future rather than ignoring it - a handset with a wrong clock is a real
 * thing and §5.3 chose which way to be wrong.
 */
export const DeviceDialAttemptInput = z.object({
  clientRef: z.string().trim().min(8).max(64),
  queueItemId: z.string().uuid(),
  dialedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable().optional(),
  durationSec: z.number().int().min(0).max(24 * 3600).nullable().optional(),
  result: DialAttemptResult.nullable().optional(),
});
export type DeviceDialAttemptInput = z.infer<typeof DeviceDialAttemptInput>;

// ── Response shapes ─────────────────────────────────────────────────────────

export interface DialCampaignView {
  id: string;
  workspaceId: string;
  name: string;
  mode: DialCampaignMode;
  advanceDelaySec: number;
  sourceKind: DialSourceKind;
  sourceRef: string | null;
  sourceFilter: DialSourceFilter;
  priority: DialPriority;
  maxAttempts: number;
  retryAfterHours: number;
  status: DialCampaignStatus;
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Queue size, when the queue has been built. Zero for a draft. */
  queuedCount: number;
}

/**
 * The preview, which is the centrepiece of the builder screen (§11):
 *
 *   6,003 selected · 4,812 dialable · 902 no number · 211 on a DNC list · …
 *
 * Counts only, never numbers. A preview that could be asked for a thousand
 * E.164s would be an export with a different name, which is the argument
 * `numbers.controller.ts` makes for serving one key at a time.
 */
export interface DialPreviewCounts {
  selected: number;
  dialable: number;
  /** Keyed by DialBlockReason; a reason with no records is omitted. */
  blocked: Partial<Record<DialBlockReason, number>>;
  /**
   * Records with a `probable` opt-out that are STILL DIALABLE (§5.4). Not a
   * block - the agent screen shows a banner and a person decides - but a
   * supervisor committing a day of calls is owed the number.
   */
  unconfirmedOptOut: number;
  /** True when the source produced more records than the preview would read. */
  truncated: boolean;
}

/** One record as the HANDSET receives it. The only shape here carrying a number. */
export interface DeviceDialItem {
  queueItemId: string;
  campaignId: string;
  campaignName: string;
  mode: DialCampaignMode;
  advanceDelaySec: number;
  /** The number to ring. From the vault (0157), served by one of two routes. */
  e164: string;
  /** Who it is, as much as the console would show. Never a second copy of the number. */
  title: string;
  leadId: string | null;
  contactId: string | null;
  attemptCount: number;
  maxAttempts: number;
  /** Expiry of the 120s lease this claim took, ISO-8601. */
  lockedUntil: string;
  /** §5.4's banner: they may have asked us to stop. Shown, never enforced here. */
  unconfirmedOptOut: boolean;
  /** The previous call's AI summary, above the dial button (§12). */
  lastCallSummary: string | null;
  lastCallAt: string | null;
}

export interface DialAgentStats {
  userId: string | null;
  name: string | null;
  position: number | null;
  attempts: number;
  connects: number;
  /** 0-1, or null when the agent has not dialled anything yet. */
  connectRate: number | null;
  /** Mean handle time of this agent's CONNECTED attempts, seconds. */
  avgHandleSec: number | null;
  state: DialQueueItemState | null;
}

/**
 * The supervisor's live board (§11).
 *
 * `medianConnectRate` and `medianHandleSec` are MEDIANS, not means, and that
 * is 0144's settled decision: one forty-minute call drags a mean far enough to
 * make a good agent look idle, and the whole point of the peer column is to
 * tell those two apart.
 */
export interface DialCampaignLive {
  campaignId: string;
  status: DialCampaignStatus;
  total: number;
  byState: Partial<Record<DialQueueItemState, number>>;
  attempts: number;
  connects: number;
  /** Attempts the §10 matcher refused to link because two calls fitted. */
  ambiguousLinks: number;
  /** Attempts still waiting for their call, inside the 24h window. */
  pendingLinks: number;
  agents: DialAgentStats[];
  medianConnectRate: number | null;
  medianHandleSec: number | null;
}
