import {
  ADDONS,
  BYTES_PER_GIB,
  MINUTES_PER_HOUR,
  type AddonKey,
  type BillingRegion,
} from "./pricing";
import type { HardValue, PlanKey, QuotaValue, WindowValue } from "./entitlements";
import { sweepDays } from "./entitlements";

/**
 * A tenant's EFFECTIVE limits: the plan, plus what they have bought on top.
 *
 * ── WHY THIS IS ONE QUERY AND ONE PURE FUNCTION ─────────────────────────────
 *
 * Four different processes need the same answer and must not disagree about
 * it: the API refusing a pairing, the worker deciding whether to transcribe a
 * call, the reaper deciding when audio dies, and the owner's own plan page
 * drawing the meters. Four implementations of "200 hours plus a 25-hour pack"
 * is four chances for a customer to be refused something they paid for.
 *
 * So the SQL is a named constant both the API and the worker execute, and the
 * arithmetic over its result is a pure function with tests. Neither half knows
 * which process it is running in.
 *
 * ── WHY THE ADMIN POOL ──────────────────────────────────────────────────────
 *
 * `plans`, `plan_entitlements`, `plan_prices` and `plan_addons` are the
 * catalogue and `aura_app` is REVOKED on all of them (0192, 0197). A statement
 * inside `withOrg` runs as `aura_app` and may not join them - four statements
 * in `entitlements.controller.ts` learned that by answering `permission denied
 * for table plans` the first time a real request hit them. The query below is
 * therefore an ADMIN-pool query, narrowed by an explicit `org_id = $1` that
 * the caller takes from the authenticated principal and never from a header.
 *
 * ── WHAT A RECURRING ADD-ON DOES vs A PACK ──────────────────────────────────
 *
 * A recurring add-on raises a CEILING for as long as it is held, so it is
 * added to the plan's limit: four handsets plus two extra handsets is six. A
 * pack is a CREDIT spent inside one period, so it is added to the monthly
 * allowance for that period only: 200 hours plus a 25-hour pack is 225 hours
 * this month and 200 next.
 *
 * Both are summed BEFORE any comparison against usage, never after - a limit
 * compared first and topped up second is a limit that refuses a customer who
 * has already paid.
 */

/** One row, as `EFFECTIVE_LIMITS_SQL` returns it. */
export interface EffectiveLimitsRow {
  plan_key: string | null;
  plan_family: string | null;
  plan_name: string | null;
  billing_region: string;
  /** `plan_entitlements.value`, keyed by entitlement, for this org's plan. */
  entitlements: Record<string, unknown> | null;
  /** Recurring add-on units held, keyed by add-on. */
  addon_units: Record<string, number> | null;
  /** Pack units granted for the period asked about, keyed by add-on. */
  grant_amounts: Record<string, number> | null;
  /** Whether a counsel opinion has been recorded for this tenant. */
  consent_cleared: boolean;
  /** The org's own column, which an operator may still override by hand. */
  asr_monthly_minutes_budget: number | null;
  transcription_enabled: boolean;
}

/**
 * Everything a tenant's four meters resolve to, plus the two switches.
 *
 * Every `null` means UNLIMITED and never "unknown" - an unknown is an error the
 * caller raises, because a limit that reads as unlimited by accident is a limit
 * that does not hold. `planKey: null` is the one legitimate absence: a tenant
 * who predates the plan system, who has no limits at all, which is exactly the
 * product they have today.
 */
export interface EffectiveLimits {
  planKey: PlanKey | null;
  planName: string | null;
  family: "capture" | "insights" | null;
  region: BillingRegion;
  /** Handsets that may be paired at once. */
  handsets: number | null;
  /** Transcription minutes for the period, plan plus any packs bought in it. */
  transcriptionMinutes: number | null;
  /** Included hours, for display. The minutes above are what enforcement uses. */
  transcriptionHours: number | null;
  /** Hours bought as packs in this period, for the "you topped up" line. */
  toppedUpHours: number;
  /** Days a recording file is kept. `null` leaves the sweep alone entirely. */
  audioRetentionDays: number | null;
  /** The storage ceiling in bytes, or null for no ceiling. */
  storageCapBytes: number | null;
  /** Whether speaker labels and talk-time ratios may be produced. */
  speakerSeparation: boolean;
  /** Whether the AI read of a call is sold on this plan at all. */
  aiAnalysis: boolean;
  /**
   * Whether this tenant's audio may be sent to a speech-to-text provider.
   *
   * False on Record (zero hours, no AI) and false whenever an operator has
   * switched the org's own `transcription_enabled` off. Either way the call is
   * still recorded, stored, listed and playable - only the paid stages are
   * skipped. See `LIMIT_BEHAVIOURS` in pricing.ts: a call is never refused.
   */
  transcriptionAllowed: boolean;
  /** True when the tenant may not record at all: an AE region with no opinion. */
  recordingProhibited: boolean;
}

/**
 * The one query. Parameters: `$1` org id, `$2` period key ('2026-10').
 *
 * A named constant so a verification script can execute this exact text
 * against a real database - typecheck cannot see SQL, and every defect this
 * file could carry is in the joins rather than the types.
 *
 * `LEFT JOIN` throughout: an org with no subscription, no add-ons and no
 * grants must come back as one row of nulls rather than no rows, because "no
 * plan" is a real and common state and a caller that got zero rows would have
 * to invent an answer.
 */
export const EFFECTIVE_LIMITS_SQL = `
  SELECT o.billing_region,
         o.asr_monthly_minutes_budget,
         o.transcription_enabled,
         (o.consent_cleared_at IS NOT NULL)                       AS consent_cleared,
         p.key    AS plan_key,
         p.family AS plan_family,
         p.name   AS plan_name,
         -- The plan a trial is running on, if one is, exactly as
         -- EntitlementsService.resolve picks it: the comparison is in the
         -- query so a late revert sweep cannot hand a tenant a tier they no
         -- longer have.
         (SELECT jsonb_object_agg(pe.entitlement_key, pe.value)
            FROM plan_entitlements pe
           WHERE pe.plan_id = COALESCE(
                   CASE WHEN s.trial_plan_id IS NOT NULL AND s.trial_ends_at > now()
                        THEN s.trial_plan_id END,
                   s.plan_id))                                    AS entitlements,
         (SELECT jsonb_object_agg(a.addon_key, a.units)
            FROM org_plan_addons a
           WHERE a.org_id = o.id AND a.units > 0)                 AS addon_units,
         (SELECT jsonb_object_agg(g.addon_key, g.total)
            FROM (SELECT addon_key, sum(amount)::int AS total
                    FROM org_addon_grants
                   WHERE org_id = o.id AND period = $2
                   GROUP BY addon_key) g)                         AS grant_amounts
    FROM organizations o
    LEFT JOIN org_subscriptions s ON s.org_id = o.id
    LEFT JOIN plans p ON p.id = COALESCE(
      CASE WHEN s.trial_plan_id IS NOT NULL AND s.trial_ends_at > now()
           THEN s.trial_plan_id END,
      s.plan_id)
   WHERE o.id = $1`;

/** The UTC calendar-month bucket, matching `usage_meters.period`. */
export function periodKeyUtc(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quotaLimit(entitlements: Record<string, unknown>, key: string): number | null {
  const value = entitlements[key] as QuotaValue | undefined;
  if (!value) return null;
  return value.limit ?? null;
}

function hardEnabled(entitlements: Record<string, unknown>, key: string): boolean {
  return Boolean((entitlements[key] as HardValue | undefined)?.enabled);
}

/**
 * Add a recurring add-on's grant to a plan ceiling.
 *
 * `null` in means unlimited, and unlimited plus anything is still unlimited -
 * written out rather than relied on, because `null + 5` is 5 in JavaScript,
 * which would turn "no ceiling" into "a ceiling of five" and refuse almost
 * everything. That is the arithmetic bug this helper exists to make impossible.
 */
function addToCeiling(
  limit: number | null,
  key: AddonKey,
  units: Record<string, number>,
): number | null {
  if (limit === null) return null;
  const held = units[key] ?? 0;
  if (held <= 0) return limit;
  const spec = ADDONS[key];
  return limit + Math.min(held, spec.maxUnits) * spec.grant;
}

/**
 * Resolve one row into the limits every enforcement point reads.
 *
 * Pure, so the whole table of cases - no plan, Record, a trial, a plan plus
 * two handsets plus a 100-hour pack, an operator override - is testable without
 * a database.
 */
export function effectiveLimits(row: EffectiveLimitsRow): EffectiveLimits {
  const region = (row.billing_region === "AE" ? "AE" : "IN") as BillingRegion;
  const family =
    row.plan_family === "capture" ? "capture" : row.plan_family === "insights" ? "insights" : null;
  const entitlements = row.entitlements ?? {};
  const addonUnits = row.addon_units ?? {};
  const grants = row.grant_amounts ?? {};

  // An AE tenant with no recorded counsel opinion records nothing. The column
  // is clamped by a trigger in 0197 as well; this is the same rule read back,
  // so a surface can SAY why rather than only observing that nothing records.
  const recordingProhibited = region === "AE" && !row.consent_cleared;

  // No plan is no limits, which is what every tenant that predates the plan
  // system has. The two switches still apply - an operator may have turned
  // transcription off by hand, and the consent gate is not a plan lever.
  if (!row.plan_key) {
    return {
      planKey: null,
      planName: null,
      family: null,
      region,
      handsets: null,
      transcriptionMinutes: row.asr_monthly_minutes_budget ?? null,
      transcriptionHours: null,
      toppedUpHours: 0,
      audioRetentionDays: null,
      storageCapBytes: null,
      speakerSeparation: true,
      aiAnalysis: true,
      transcriptionAllowed: row.transcription_enabled && !recordingProhibited,
      recordingProhibited,
    };
  }

  const handsets = addToCeiling(
    quotaLimit(entitlements, "paired_handsets"),
    "extra_handset",
    addonUnits,
  );

  const planHours = quotaLimit(entitlements, "transcription_hours_monthly");
  // Packs are summed from the GRANT LEDGER, in the entitlement's own unit, not
  // recomputed from today's catalogue price: an operator who changes what a
  // 25-hour pack contains must not retroactively change what a customer
  // already bought. `org_addon_grants.amount` is that frozen number.
  const toppedUpHours =
    (grants.topup_hours_25 ?? 0) + (grants.topup_hours_100 ?? 0);
  const transcriptionHours = planHours === null ? null : planHours + toppedUpHours;

  const storageGb = addToCeiling(
    quotaLimit(entitlements, "storage_cap_gb"),
    "extra_storage_5gb",
    addonUnits,
  );

  const planRetention = sweepDays(entitlements.audio_retention_days as WindowValue | undefined);
  const retentionAddon = ADDONS.extra_retention_30d;
  const retentionUnits = Math.min(
    addonUnits.extra_retention_30d ?? 0,
    retentionAddon.maxUnits,
  );
  const audioRetentionDays =
    planRetention === null ? null : planRetention + retentionUnits * retentionAddon.grant;

  const aiAnalysis = hardEnabled(entitlements, "ai_features");

  // ── WHY THE OPERATOR'S OWN COLUMN WINS ──────────────────────────────────
  //
  // `asr_monthly_minutes_budget` predates plans (0086) and is how an operator
  // caps a tenant by hand - including a capture Enterprise tenant whose
  // negotiated hours are a contract term rather than a catalogue row. When it
  // is set it is the authority; when it is null the plan decides. The reverse
  // precedence would make a hand-set ceiling silently ignored, which is how an
  // instance that was capped on purpose starts spending again.
  const planMinutes =
    transcriptionHours === null ? null : transcriptionHours * MINUTES_PER_HOUR;
  const transcriptionMinutes =
    row.asr_monthly_minutes_budget ?? planMinutes;

  return {
    planKey: row.plan_key as PlanKey,
    planName: row.plan_name,
    family,
    region,
    handsets,
    transcriptionMinutes,
    transcriptionHours,
    toppedUpHours,
    audioRetentionDays,
    storageCapBytes: storageGb === null ? null : storageGb * BYTES_PER_GIB,
    speakerSeparation: hardEnabled(entitlements, "speaker_separation"),
    aiAnalysis,
    // Three things have to be true to send audio to a provider: the plan sells
    // the AI read, the operator has not switched transcription off, and the
    // tenant is allowed to record at all. A zero-hour plan (Record) is caught
    // by `aiAnalysis` rather than by the minute ceiling, so a Record tenant
    // never reaches the budget query at all.
    transcriptionAllowed: aiAnalysis && row.transcription_enabled && !recordingProhibited,
    recordingProhibited,
  };
}
