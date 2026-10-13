import {
  EFFECTIVE_LIMITS_SQL,
  effectiveLimits,
  periodKeyUtc,
  type EffectiveLimits,
  type EffectiveLimitsRow,
} from "@aura/shared";

/**
 * Resolving a capture plan into the columns that already enforce it.
 *
 * ── WHY THIS LIVES IN `packages/db` ─────────────────────────────────────────
 *
 * Three processes have to do exactly this, and the same argument the finance
 * rollup and the feature-gate loader make applies: the API applies a plan when
 * an operator clicks Apply or a verified webhook settles an order, and the
 * WORKER applies one when a trial expires or a scheduled downgrade lands. Two
 * processes, one definition. The drift would be the worker's, because nobody
 * opens it in a browser.
 *
 * ── WHAT "APPLYING A PLAN" ACTUALLY MEANS ───────────────────────────────────
 *
 * Every limit on the published price list is already enforced, today, by a
 * column on `organizations` that predates the plan system:
 *
 *   transcription hours  `asr_monthly_minutes_budget` (0086), checked by the
 *                        worker pipeline before the transcode advance
 *   audio retention      `retention_days` (0001), swept by the reaper
 *   storage cap          `storage_quota_bytes` (doc 27), swept hourly
 *   speaker separation   `asr_diarization`, read when the ASR call is built
 *   transcription at all `transcription_enabled` (0014)
 *
 * So assigning a plan RESOLVES it into those columns, exactly as 0192's apply
 * path resolves a plan into `enabled_modules`. The alternative - teaching five
 * hot paths to join the plan catalogue - would put a cross-pool query on the
 * path of every call, and `plans` is revoked from `aura_app` anyway.
 *
 * The handset cap is the one meter NOT written here. It has no column: it is a
 * count of `devices` rows compared against the entitlement at pairing time,
 * because a cap written into a column would have to be kept in step with every
 * add-on purchase, and the one place it is read is not a hot path.
 *
 * ── THE ONE THING THIS MUST NEVER DO ────────────────────────────────────────
 *
 * Narrow `data_retention_days`. That column is the FULL purge - transcripts,
 * analysis, dormant leads, deals and contacts - and it is deliberately off the
 * price list. A plan's 60-day audio window must never reach it: that is the
 * bug 0197 exists to prevent, and it would present as a paying customer's CRM
 * history disappearing. So the write below only ever RAISES it, and only to
 * keep it at or above the audio clock, because audio outliving the transcript
 * that describes it is the one ordering that makes no sense.
 */

interface QueryClient {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * A tenant's effective limits, read on an ADMIN client.
 *
 * The client MUST be an admin one. `EFFECTIVE_LIMITS_SQL` joins `plans` and
 * `plan_entitlements`, which `aura_app` is revoked on (0192) - a statement
 * inside `withOrg` answers `permission denied for table plans`. The query is
 * narrowed by an explicit `org_id = $1` that the caller takes from the
 * authenticated principal, which is the same bootstrap exception `ApiKeyGuard`
 * documents for resolving an org from a key hash.
 */
export async function readEffectiveLimits(
  admin: QueryClient,
  orgId: string,
  now: Date = new Date(),
): Promise<EffectiveLimits> {
  const { rows } = await admin.query<EffectiveLimitsRow & Record<string, unknown>>(
    EFFECTIVE_LIMITS_SQL,
    [orgId, periodKeyUtc(now)],
  );
  const row = rows[0];
  // No row means no such organization, which is a caller bug rather than a
  // tenant state. Throwing beats returning an all-null shape that would read
  // as "unlimited" and hand an unknown org every feature.
  if (!row) throw new Error(`no such organization: ${orgId}`);
  return effectiveLimits(row);
}

/**
 * Write a tenant's plan limits into the columns that enforce them.
 *
 * Idempotent, and safe to re-run after an add-on purchase or a catalogue edit:
 * every value is computed from the plan plus the add-ons held, never
 * incremented. That matters because an add-on is bought more than once and a
 * column that accumulated would drift upward every time this ran.
 *
 * ── `asr_monthly_minutes_budget` IS NOT WRITTEN ─────────────────────────────
 *
 * Deliberately. Hour PACKS are credited per period and expire with it, so a
 * column holding "the ceiling including this month's top-ups" would be stale
 * on the first of every month and would need a sweep to correct - a sweep that,
 * if it were ever late, would hand a customer either hours they had not bought
 * or a refusal after they had. The worker resolves the ceiling at read time
 * from this same function instead, which cannot be late.
 *
 * The column keeps its original job: an OPERATOR's hand-set cap, which
 * `effectiveLimits` lets win over the plan. That is how a negotiated
 * Enterprise hour count is expressed.
 */
export async function applyPlanMeters(
  admin: QueryClient,
  orgId: string,
  limits: EffectiveLimits,
): Promise<void> {
  // A tenant with no plan has no meters to write. Returning rather than
  // writing nulls is what keeps 0197's promise that existing tenants keep
  // exactly the product they have: a pre-plan tenant on 365-day retention must
  // not be narrowed by a code path that merely looked at them.
  if (!limits.planKey) return;

  await admin.query(
    `UPDATE organizations SET
       -- The AUDIO clock. COALESCE, not an overwrite: a plan whose
       -- audio_retention_days row an operator cleared leaves the tenant's
       -- current window alone rather than setting it to null (the column is
       -- NOT NULL) or to zero (which would delete every recording tonight).
       retention_days        = COALESCE($2::int, retention_days),
       -- RAISED ONLY. See the header: the full purge must never be narrowed by
       -- a plan, and audio outliving its own transcript makes no sense, so the
       -- data clock is pushed up to meet the audio clock and never pulled down
       -- to it.
       data_retention_days   = GREATEST(data_retention_days, COALESCE($2::int, 0)),
       storage_quota_bytes   = $3::bigint,
       -- Record sells no transcription at all, which is what makes it nearly
       -- free to run: with this false the audio is stored, listed and playable
       -- but never sent to a provider. An operator who had switched it off by
       -- hand stays switched off - a plan grants the right to transcribe, it
       -- does not override a deliberate pause.
       transcription_enabled = transcription_enabled AND $4::bool,
       -- Speaker separation is the one ASR option a plan gates. Forced OFF
       -- when the plan does not sell it, rather than left to the tenant's
       -- setting: diarization on Sarvam costs ₹45 an hour against ₹30, so a
       -- Starter tenant who toggled it on would be spending Growth money.
       asr_diarization       = asr_diarization AND $5::bool,
       updated_at            = now()
     WHERE id = $1`,
    [
      orgId,
      limits.audioRetentionDays,
      // bigint as a string: 5 GiB is 5368709120, and handing the driver a
      // string is what money.ts's boundary rule asks for anywhere a value
      // crosses into a wide integer column.
      limits.storageCapBytes === null ? null : String(limits.storageCapBytes),
      limits.aiAnalysis,
      limits.speakerSeparation,
    ],
  );
}

/** Read a tenant's limits and write them to their columns, in one call. */
export async function resolveAndApplyPlanMeters(
  admin: QueryClient,
  orgId: string,
  now: Date = new Date(),
): Promise<EffectiveLimits> {
  const limits = await readEffectiveLimits(admin, orgId, now);
  await applyPlanMeters(admin, orgId, limits);
  return limits;
}

/**
 * Reconcile `organizations.enabled_modules` to a plan's set.
 *
 * `aura` and `wasi` are preserved unconditionally. Every tenant has an
 * instance and a workspace, so there is no "no-Aura" tenant; and Wasi is
 * configured by hand on the Wasi side with no plan aware of it. A sweep that
 * unpaired a client's WhatsApp number at 3am because their trial ended would
 * be a very bad morning.
 */
export async function applyPlanModules(
  admin: QueryClient,
  orgId: string,
  planKey: string,
  modules: string[],
): Promise<void> {
  await admin.query(
    `UPDATE organizations o
        SET plan_key = $2,
            enabled_modules = (
              SELECT array_agg(DISTINCT m ORDER BY m)
                FROM unnest(
                  ARRAY(SELECT x FROM unnest(o.enabled_modules) x WHERE x IN ('aura', 'wasi'))
                  || $3::text[]
                ) m
            ),
            updated_at = now()
      WHERE o.id = $1`,
    [orgId, planKey, modules],
  );
}

/**
 * Put a tenant on a plan: the subscription row, the module set, and the meters.
 *
 * ── ALL THREE, TOGETHER, OR NONE ────────────────────────────────────────────
 *
 * This is what 0072's header promised and what 0192's apply path began. The
 * failure worth guarding against is doing one without the others:
 *
 *   * subscription without modules - a tenant on `capture_growth` whose
 *     `enabled_modules` still omits `crm` is paying for a console whose every
 *     route 403s at `CrmPermissionsGuard`, and the symptom ("the CRM pages are
 *     missing") points nowhere near the cause.
 *   * modules without meters - a tenant on Record whose
 *     `transcription_enabled` is still true gets the AI read they did not buy,
 *     and every call costs us money nobody paid for.
 *   * meters without the subscription - nothing can tell you why, and the next
 *     thing to read the plan will undo it.
 *
 * So the caller runs this INSIDE a transaction it owns. It is passed a client
 * rather than a pool for exactly that reason: a half-applied plan is worse
 * than an unapplied one, because an unapplied one is visible.
 *
 * ── A DOWNGRADE NARROWS; THAT IS NOT A DELETE ───────────────────────────────
 *
 * Moving a tenant from `capture_growth` to `record` removes `call_intel` and
 * switches transcription off. Their transcripts, leads and deals are
 * untouched, `role_permissions` rows survive, and re-applying the higher plan
 * restores everything. Nothing in this function removes tenant data - and
 * notably it does NOT narrow `data_retention_days`, which is the one write
 * that could.
 */
export async function assignPlanToOrg(
  client: QueryClient,
  args: {
    orgId: string;
    planId: string;
    planKey: string;
    modules: string[];
    /** Left as it was when omitted - a plan change is not a cadence change. */
    billingPeriod?: "annual" | "monthly";
    /** Clear a trial in flight. True for an explicit assignment. */
    clearTrial?: boolean;
    now?: Date;
  },
): Promise<EffectiveLimits> {
  const { orgId, planId, planKey, modules, billingPeriod, clearTrial = true } = args;

  await client.query(
    `INSERT INTO org_subscriptions (org_id, plan_id, status, billing_period)
          VALUES ($1, $2, 'active', COALESCE($3, 'annual'))
     ON CONFLICT (org_id) DO UPDATE SET
       plan_id         = EXCLUDED.plan_id,
       status          = 'active',
       billing_period  = COALESCE($3, org_subscriptions.billing_period),
       -- A trial in flight is CLEARED by an explicit assignment: whoever
       -- applied this plan is the authoritative answer, and leaving a trial
       -- running on top of it would silently keep the tenant on the trial's
       -- tier until it expired.
       trial_plan_id   = CASE WHEN $4 THEN NULL ELSE org_subscriptions.trial_plan_id END,
       trial_ends_at   = CASE WHEN $4 THEN NULL ELSE org_subscriptions.trial_ends_at END,
       pending_plan_id = NULL,
       updated_at      = now()`,
    [orgId, planId, billingPeriod ?? null, clearTrial],
  );

  await applyPlanModules(client, orgId, planKey, modules);

  // The meters LAST, because they are resolved from the subscription row this
  // function just wrote. Reading them first would resolve the OLD plan and
  // write its limits over the new one - a downgrade that left the dearer
  // tier's retention in place, or an upgrade that did not take.
  return resolveAndApplyPlanMeters(client, orgId, args.now ?? new Date());
}
