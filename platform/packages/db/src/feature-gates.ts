import {
  type AgentCapability,
  type GateCapState,
  type GateDecision,
  type GateLimit,
  type GateSetting,
  type GateSubject,
  type GateUsage,
  type GatedFeatureKey,
  evaluateCaps,
  gateUnavailable,
  resolveGate,
} from "@aura/shared";

/**
 * READING THE GATE - ONE LOADER, TWO PROCESSES
 * (Build docs/transcript-agent-build-plan §3A.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS IN `@aura/db` AND NOT IN THE API
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §3A.4: "all of the following call one `FeatureGate.check(...)` service; NO
 * CODE READS FLAGS DIRECTLY."
 *
 * The API and the WORKER are separate processes. The API gates a request; the
 * worker gates an ingestion, a run, and - §3A.4's hardest line - every single
 * tool call. If each had its own loader there would be two answers to "is this
 * on", and the one that drifts is the worker's, because nobody opens it in a
 * browser. That is how a worker goes on spending money reading the calls of a
 * telecaller an owner switched off this morning.
 *
 * So the LOADER is here, beside `finance-connectors.ts` and `lead-routing.ts`,
 * which are in this package for exactly the same reason their headers give:
 * more than one process needs the same definition. `resolveGate` in
 * `@aura/shared` is the pure decision; this is the read that feeds it.
 *
 * `FeatureGateService` in the API wraps this with a TTL cache and the
 * request-scoped subject resolution. The worker calls it directly, per run.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  FAIL CLOSED, AND THE SHAPE IS WHAT GUARANTEES IT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `gateFor` has exactly one path that returns an enabled decision, and it is
 * the last line. Everything else - a throw, a missing org row, an unreadable
 * stored row - returns `gateUnavailable`, which is `enabled: false` with no
 * capabilities. A new branch that forgets to decide denies.
 */

interface QueryClient {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface GateState {
  enabledModules: readonly string[];
  settings: readonly GateSetting[];
  usage: GateUsage;
  limits: readonly GateLimit[];
  capState: GateCapState;
}

interface SettingRow {
  scope_type: string;
  scope_id: string | null;
  scope_role: string | null;
  state: string;
  mode: string | null;
  capabilities: unknown;
  effective_from: string | Date | null;
  effective_to: string | Date | null;
}

/**
 * §3A.1 step 1's platform kill switch.
 *
 * An env var and not a row - a platform-wide switch has to work when the
 * database is the thing that is wrong, and `verify-rls.js` fails the build for
 * a public table with no `org_id`.
 *
 * A COMMA-SEPARATED LIST of feature keys rather than a boolean, because the
 * framework is generic: killing the transcript agent must not kill a future
 * module that adopts the same gate. `*` kills everything.
 */
export function platformKillSwitch(
  feature: GatedFeatureKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // `?.trim()` then a falsy check, never `??`: compose passes `${VAR:-}`, so an
  // unset variable arrives as "" rather than undefined and `??` would keep it.
  // That exact mistake disabled Google Calendar on 2026-08-10.
  const raw = env.FEATURE_GATE_KILL_SWITCH?.trim();
  if (!raw) return false;
  const killed = raw.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  return killed.includes("*") || killed.includes(feature);
}

/**
 * Everything the resolver needs, in ONE round trip.
 *
 * The entitlement is on `organizations`, the settings are in
 * `feature_settings`, the usage in `feature_usage` and the limits in
 * `feature_limits` - four tables, and this deployment pays ~125ms per exchange
 * (Mumbai worker, Seoul database). Four queries would be half a second per
 * run, so they ride as aggregated columns on one read. The same trick
 * `loadOrgFeatures` and `contextFor` use.
 *
 * Must be called inside an org RLS context: there is no `org_id` predicate
 * here and no way to ask about a tenant other than the one the connection is
 * scoped to. Same reasoning `orgHasModule` and `loadOrgFeatures` give.
 */
export async function loadGateState(
  client: QueryClient,
  feature: GatedFeatureKey,
  now: Date = new Date(),
): Promise<GateState> {
  const period = now.toISOString().slice(0, 7);

  const { rows } = await client.query<{
    modules: string[] | null;
    settings: SettingRow[] | null;
    usage: { transcripts: number; audio_minutes: number; model_cost_minor: string } | null;
    limits: Array<{ metric: string; soft_limit: string | null; hard_limit: string | null }> | null;
  }>(
    `SELECT o.enabled_modules AS modules,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'scope_type', s.scope_type,
                        'scope_id', s.scope_id,
                        'scope_role', s.scope_role,
                        'state', s.state,
                        'mode', s.mode,
                        'capabilities', s.capabilities,
                        'effective_from', s.effective_from,
                        'effective_to', s.effective_to))
                        FROM feature_settings s
                       WHERE s.feature_key = $1), '[]'::jsonb) AS settings,
            (SELECT to_jsonb(u) FROM feature_usage u
              WHERE u.feature_key = $1 AND u.period = $2
                AND u.user_id IS NULL AND u.telecaller_id IS NULL) AS usage,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'metric', l.metric,
                        'soft_limit', l.soft_limit,
                        'hard_limit', l.hard_limit))
                        FROM feature_limits l
                       WHERE l.feature_key = $1 AND l.scope_type = 'org'), '[]'::jsonb) AS limits
       FROM organizations o
      LIMIT 1`,
    [feature, period],
  );

  const row = rows[0];
  // An org row that does not come back is impossible under a correct RLS
  // context and reachable if this is called outside one. A THROW rather than
  // "no modules", so the caller's catch logs it - "no modules" would deny
  // silently and look like a plan problem.
  if (!row) throw new Error("loadGateState: no organizations row in this RLS context");

  const usage: GateUsage = {
    transcripts: Number(row.usage?.transcripts ?? 0),
    audioMinutes: Number(row.usage?.audio_minutes ?? 0),
    modelCostMinor: Number(row.usage?.model_cost_minor ?? 0),
  };
  const limits: GateLimit[] = (row.limits ?? []).map((l) => ({
    metric: l.metric as GateLimit["metric"],
    softLimit: l.soft_limit === null ? null : Number(l.soft_limit),
    hardLimit: l.hard_limit === null ? null : Number(l.hard_limit),
  }));

  return {
    enabledModules: Array.isArray(row.modules) ? row.modules : [],
    settings: (row.settings ?? [])
      .map(toSetting)
      .filter((setting): setting is GateSetting => setting !== null),
    usage,
    limits,
    capState: evaluateCaps(usage, limits).state,
  };
}

/** The whole question, start to finish, for one subject. */
export async function gateFor(
  client: QueryClient,
  feature: GatedFeatureKey,
  subject: GateSubject,
  now: Date = new Date(),
): Promise<GateDecision> {
  try {
    const state = await loadGateState(client, feature, now);
    return resolveGate({
      feature,
      subject,
      enabledModules: state.enabledModules,
      settings: state.settings,
      platformKillSwitch: platformKillSwitch(feature),
      capState: state.capState,
      now,
    });
  } catch (error) {
    // §3A.4: fail closed. Logged at error level rather than swallowed - a gate
    // denying everything because of a broken query looks from the outside
    // exactly like a feature nobody enabled.
    console.error(
      `gateFor(${feature}) failed - DENYING:`,
      error instanceof Error ? error.message : error,
    );
    return gateUnavailable(feature, subject);
  }
}

/**
 * The subject for a CALL, resolved from the call's own attribution.
 *
 * ── THE THREE WAYS TO GET THIS WRONG ──────────────────────────────────────
 *
 * §3A.3: "a call is processed only if the feature is enabled for the
 * telecaller who handled the call." That subject is the whole processing gate:
 *
 *   1. reading `calls.device_id -> devices.telecaller_id` gives the CURRENT
 *      holder of the handset, not whoever made the call - which is exactly
 *      what 0068's write-once `calls.telecaller_id` exists to fix;
 *   2. keying on `users` alone silently skips every telecaller who has never
 *      signed in, which is most of a floor (`telecallers.user_id` is nullable
 *      since 0017, and lead routing already skips them for this reason);
 *   3. forgetting the team misses where the bulk toggle writes its rows.
 *
 * One query, one place, all three right.
 */
export async function gateSubjectForCall(
  client: QueryClient,
  callId: string,
): Promise<GateSubject | null> {
  const { rows } = await client.query<{
    telecaller_id: string | null;
    user_id: string | null;
    team_id: string | null;
    owner_role: string | null;
  }>(
    `SELECT c.telecaller_id,
            t.user_id,
            (SELECT p.team_id
               FROM position_assignments pa
               JOIN positions p ON p.id = pa.position_id
              WHERE pa.user_id = t.user_id AND pa.end_date IS NULL
              ORDER BY pa.start_date DESC
              LIMIT 1) AS team_id,
            m.owner_role
       FROM calls c
       LEFT JOIN telecallers t ON t.id = c.telecaller_id
       LEFT JOIN memberships m ON m.user_id = t.user_id AND m.org_id = c.org_id
      WHERE c.id = $1`,
    [callId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    telecallerId: row.telecaller_id,
    teamId: row.team_id,
    ownerRole: row.owner_role,
  };
}

/** The subject for a telecaller, for the reminder and escalation sweeps. */
export async function gateSubjectForTelecaller(
  client: QueryClient,
  telecallerId: string,
): Promise<GateSubject> {
  const { rows } = await client.query<{
    user_id: string | null;
    team_id: string | null;
    owner_role: string | null;
  }>(
    `SELECT t.user_id,
            (SELECT p.team_id
               FROM position_assignments pa
               JOIN positions p ON p.id = pa.position_id
              WHERE pa.user_id = t.user_id AND pa.end_date IS NULL
              ORDER BY pa.start_date DESC
              LIMIT 1) AS team_id,
            m.owner_role
       FROM telecallers t
       LEFT JOIN memberships m ON m.user_id = t.user_id
      WHERE t.id = $1`,
    [telecallerId],
  );
  const row = rows[0];
  return {
    userId: row?.user_id ?? null,
    telecallerId,
    teamId: row?.team_id ?? null,
    ownerRole: row?.owner_role ?? null,
  };
}

/**
 * §3A.7's metering. Called once per processed transcript, never for a skipped
 * one - §19's "no-cost proof" asserts ZERO metered usage for a disabled user.
 *
 * Two rows per call: the subject's own, and the ORG total the cap is checked
 * against. Incremented in the same statement rather than read-modify-written,
 * so two workers finishing at once cannot lose a count.
 */
export async function meterGateUsage(
  client: QueryClient,
  orgId: string,
  feature: GatedFeatureKey,
  subject: { userId: string | null; telecallerId: string | null },
  usage: { transcripts: number; audioMinutes: number; modelCostMinor: number },
  now: Date = new Date(),
): Promise<void> {
  const period = now.toISOString().slice(0, 7);

  // The org total. `user_id IS NULL AND telecaller_id IS NULL` is its own
  // partial unique index in 0184 - a composite primary key with two NULLABLE
  // columns does NOT enforce uniqueness in Postgres, because NULL is distinct
  // from NULL, so the same row could otherwise be inserted twice.
  await client.query(
    `INSERT INTO feature_usage
       (org_id, feature_key, user_id, telecaller_id, period,
        transcripts, audio_minutes, model_cost_minor)
     VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6)
     ON CONFLICT (org_id, feature_key, period) WHERE user_id IS NULL AND telecaller_id IS NULL
     DO UPDATE SET transcripts = feature_usage.transcripts + EXCLUDED.transcripts,
                   audio_minutes = feature_usage.audio_minutes + EXCLUDED.audio_minutes,
                   model_cost_minor = feature_usage.model_cost_minor + EXCLUDED.model_cost_minor,
                   updated_at = now()`,
    [orgId, feature, period, usage.transcripts, usage.audioMinutes, usage.modelCostMinor],
  );

  // And the subject's own, so §3A.7's per-user cost column has something to
  // show. Keyed on whichever identity the subject has - a handset-only
  // telecaller has no user id, and attributing their spend to nobody is how
  // the admin table's cost column reads zero for the people doing the work.
  if (subject.userId) {
    await client.query(
      `INSERT INTO feature_usage
         (org_id, feature_key, user_id, telecaller_id, period,
          transcripts, audio_minutes, model_cost_minor)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7)
       ON CONFLICT (org_id, feature_key, period, user_id) WHERE user_id IS NOT NULL
       DO UPDATE SET transcripts = feature_usage.transcripts + EXCLUDED.transcripts,
                     audio_minutes = feature_usage.audio_minutes + EXCLUDED.audio_minutes,
                     model_cost_minor = feature_usage.model_cost_minor + EXCLUDED.model_cost_minor,
                     updated_at = now()`,
      [
        orgId,
        feature,
        subject.userId,
        period,
        usage.transcripts,
        usage.audioMinutes,
        usage.modelCostMinor,
      ],
    );
  } else if (subject.telecallerId) {
    await client.query(
      `INSERT INTO feature_usage
         (org_id, feature_key, user_id, telecaller_id, period,
          transcripts, audio_minutes, model_cost_minor)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, feature_key, period, telecaller_id)
         WHERE telecaller_id IS NOT NULL AND user_id IS NULL
       DO UPDATE SET transcripts = feature_usage.transcripts + EXCLUDED.transcripts,
                     audio_minutes = feature_usage.audio_minutes + EXCLUDED.audio_minutes,
                     model_cost_minor = feature_usage.model_cost_minor + EXCLUDED.model_cost_minor,
                     updated_at = now()`,
      [
        orgId,
        feature,
        subject.telecallerId,
        period,
        usage.transcripts,
        usage.audioMinutes,
        usage.modelCostMinor,
      ],
    );
  }
}

/**
 * A stored row into the resolver's shape, or NULL if it cannot be trusted.
 *
 * ── AN UNREADABLE ROW IS DROPPED, NOT DEFAULTED ───────────────────────────
 *
 * A `mode` outside the enum, a `state` outside it, a `capabilities` that is
 * not an array: each means the row was written by something that is not this
 * code. Defaulting it to "off" would be the same as dropping it; defaulting it
 * to anything else would let a malformed row GRANT something. Dropping means
 * the resolver falls back to the next scope out, and the org default is OFF -
 * so the fail-closed direction is preserved with no special case.
 */
function toSetting(row: SettingRow): GateSetting | null {
  const scopeTypes = ["org", "team", "role", "user"] as const;
  const states = ["on", "off", "inherit"] as const;
  const modes = ["off", "shadow", "suggest", "assisted", "auto"] as const;

  if (!scopeTypes.includes(row.scope_type as (typeof scopeTypes)[number])) return null;
  if (!states.includes(row.state as (typeof states)[number])) return null;
  if (row.mode !== null && !modes.includes(row.mode as (typeof modes)[number])) return null;

  let capabilities: AgentCapability[] | null = null;
  if (row.capabilities !== null && row.capabilities !== undefined) {
    if (!Array.isArray(row.capabilities)) return null;
    capabilities = row.capabilities.filter((c): c is AgentCapability => typeof c === "string");
  }

  return {
    scopeType: row.scope_type as GateSetting["scopeType"],
    // A `role` row names a persona in `scope_role`; the resolver compares it
    // to `subject.ownerRole`, so it travels in `scopeId`.
    scopeId: row.scope_type === "role" ? row.scope_role : row.scope_id,
    state: row.state as GateSetting["state"],
    mode: row.mode as GateSetting["mode"],
    capabilities,
    effectiveFrom: row.effective_from ? new Date(row.effective_from) : null,
    effectiveTo: row.effective_to ? new Date(row.effective_to) : null,
  };
}
