import { Injectable } from "@nestjs/common";
import {
  type GateState,
  loadGateState,
  platformKillSwitch,
  gateSubjectForCall,
  gateSubjectForTelecaller,
} from "@aura/db";
import {
  type AgentCapability,
  type GateDecision,
  type GateSubject,
  type GatedFeatureKey,
  evaluateCaps,
  gateUnavailable,
  gatedFeatureSpec,
  resolveGate,
} from "@aura/shared";
import { DbService } from "../db/db.service";

/**
 * `FeatureGate.check` - THE ONE PLACE A GATE IS DECIDED
 * (Build docs/transcript-agent-build-plan §3A.4).
 *
 * §3A.4: "all of the following call one `FeatureGate.check(feature,
 * capability, subject_user)` service; **no code reads flags directly**."
 *
 * That sentence is why this is a service and not a helper function. Seven
 * layers have to agree - the UI, the API, ingestion, the queue workers, the
 * planner, the executor and the scheduled sweeps - and a second place that
 * reads `feature_settings` is a second answer to "is this on", which is how a
 * worker goes on spending money for a user an owner switched off this morning.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  FAIL CLOSED, STRUCTURALLY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §3A.4: "if the gate service or its data is unavailable, deny."
 *
 * Every path out of `check` that is not a successful resolution returns
 * `gateUnavailable(...)`, which is `enabled: false` with no capabilities. The
 * `catch` is around the WHOLE read, not around individual statements, so a
 * query that throws, a connection that drops, a malformed stored mode and an
 * org row that does not come back all land in the same place. A new branch that
 * forgets to decide falls through to the denial.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  §3A.4's FIVE-SECOND PROPAGATION, AND WHY A TTL CACHE IS ENOUGH
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "A change takes effect within 5 seconds (cache with invalidation on change);
 * in-flight work respects the new state at its next gate check."
 *
 * Two mechanisms, not one:
 *
 *   · a 3-second TTL, which bounds the staleness even for a process that never
 *     learns about the change (a second API instance, the worker);
 *   · `invalidate()`, called by the admin controller in the same request that
 *     writes the setting, which makes the change immediate for the instance
 *     that made it.
 *
 * The TTL is what makes the 5-second promise true rather than aspirational: a
 * cache that relies only on invalidation is a cache that is stale forever in
 * every process that did not receive the invalidation, and this deployment runs
 * more than one.
 *
 * WHY CACHE AT ALL: the executor re-checks before EVERY tool call (§3A.4), and
 * this database is ~125ms away. An uncached gate would add a quarter-second to
 * each of a plan's eight actions, for an answer that changes a few times a
 * month.
 */

/** §3A.4's propagation budget is 5s; the cache is held well inside it. */
const CACHE_TTL_MS = Number(process.env.FEATURE_GATE_CACHE_TTL_MS ?? 3_000);

type CachedOrgState = GateState & { at: number };

/**
 * Re-exported, not re-implemented.
 *
 * `platformKillSwitch` lives in `@aura/db` beside the loader, because the
 * WORKER needs the same answer and §3A.4's rule is that there is one. Exported
 * from here as well so a reader of this file - which is where the gate "lives"
 * from the API's point of view - can find it without following an import.
 */
export { platformKillSwitch };

@Injectable()
export class FeatureGateService {
  private readonly cache = new Map<string, CachedOrgState>();

  constructor(private readonly db: DbService) {}

  /** §3A.4's invalidation. Called by every write in the admin controller. */
  invalidate(orgId: string, feature?: GatedFeatureKey): void {
    if (feature) {
      this.cache.delete(`${orgId}:${feature}`);
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${orgId}:`)) this.cache.delete(key);
    }
  }

  /** For tests, and for the worker's long-lived process on a restart. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * THE gate decision.
   *
   * `capability` is optional: a caller asking "is this on at all" (the console
   * drawing a nav entry) passes none, and a caller about to do something
   * (the executor) passes the one it needs. Both get the full decision back, so
   * the audit snapshot is the same object either way.
   */
  async check(
    feature: GatedFeatureKey,
    subject: GateSubject,
    orgId: string,
  ): Promise<GateDecision> {
    try {
      const state = await this.orgState(orgId, feature);
      // `capState` is already computed by the loader - read it rather than
      // recomputing, so the cap the gate honours is the cap the admin screen
      // shows.
      const capState = state.capState;
      return resolveGate({
        feature,
        subject,
        enabledModules: state.enabledModules,
        settings: state.settings,
        platformKillSwitch: platformKillSwitch(feature),
        capState,
        now: new Date(),
      });
    } catch (error) {
      // §3A.4: fail closed. Logged at error level rather than swallowed,
      // because a gate that is denying everything because of a broken query
      // looks from the outside exactly like a feature nobody enabled.
      console.error(
        `FeatureGate.check(${feature}) failed for org ${orgId} - DENYING:`,
        error instanceof Error ? error.message : error,
      );
      return gateUnavailable(feature, subject);
    }
  }

  /**
   * Is this capability permitted for this subject? The question the executor
   * asks before every tool call.
   *
   * Returns the DECISION and not a boolean, because §3A.4 requires a refused
   * action to be marked with a reason - and `blocked_by_gate` and
   * `capability_off` are different sentences to the owner reading the review
   * queue.
   */
  async checkCapability(
    feature: GatedFeatureKey,
    capability: AgentCapability,
    subject: GateSubject,
    orgId: string,
  ): Promise<{ decision: GateDecision; allowed: boolean }> {
    const decision = await this.check(feature, subject, orgId);
    return {
      decision,
      allowed: decision.enabled && decision.capabilities.includes(capability),
    };
  }

  /**
   * The subject for a CALL, resolved from the call's own attribution.
   *
   * ── WHY THIS IS A METHOD AND NOT THE CALLER'S JOB ──────────────────────────
   *
   * §3A.3: "a call is processed only if the feature is enabled for the
   * telecaller who handled the call." Getting that subject right is the whole
   * processing gate, and there are three ways to get it wrong:
   *
   *   1. reading `calls.device_id -> devices.telecaller_id` (the CURRENT holder
   *      of the handset, not whoever made the call - which is what 0068 exists
   *      to fix);
   *   2. keying on `users` alone, which silently skips every telecaller who has
   *      never signed in - most of a floor;
   *   3. forgetting the team, which is where the bulk toggle writes its rows.
   *
   * One query, one place, all three right.
   */
  async subjectForCall(orgId: string, callId: string): Promise<GateSubject | null> {
    // Delegated, not reimplemented. The three ways to get this subject wrong
    // are documented on `gateSubjectForCall` in `@aura/db`, and the worker
    // needs the identical answer - which is the whole reason it is there.
    return this.db.withOrg(orgId, (client) => gateSubjectForCall(client, callId));
  }

  /**
   * The subject for the TELECALLER a suggestion belongs to.
   *
   * Needed where a call id is not what is in hand - the review queue holds an
   * `agent_actions` row whose transcript already names the telecaller, and
   * approving it has to ask about THEM, not about the person clicking Approve.
   * Both questions are asked at approval: the reviewer needs the capability,
   * and the telecaller whose call it was still needs the feature, or the owner
   * switched it off for them while the item waited.
   */
  async subjectForTelecaller(orgId: string, telecallerId: string): Promise<GateSubject> {
    return this.db.withOrg(orgId, (client) => gateSubjectForTelecaller(client, telecallerId));
  }

  /** The subject for a signed-in person - the access gate's own question. */
  async subjectForUser(orgId: string, userId: string): Promise<GateSubject> {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        telecaller_id: string | null;
        team_id: string | null;
        owner_role: string | null;
      }>(
        `SELECT (SELECT t.id FROM telecallers t WHERE t.user_id = $1 LIMIT 1) AS telecaller_id,
                (SELECT p.team_id
                   FROM position_assignments pa
                   JOIN positions p ON p.id = pa.position_id
                  WHERE pa.user_id = $1 AND pa.end_date IS NULL
                  ORDER BY pa.start_date DESC
                  LIMIT 1) AS team_id,
                (SELECT m.owner_role FROM memberships m WHERE m.user_id = $1 LIMIT 1) AS owner_role`,
        [userId],
      );
      const row = rows[0];
      return {
        userId,
        telecallerId: row?.telecaller_id ?? null,
        teamId: row?.team_id ?? null,
        ownerRole: row?.owner_role ?? null,
      };
    });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * The cached org state, loaded by the ONE loader in `@aura/db`.
   *
   * ── THE LOADER IS NOT HERE, AND THAT IS THE POINT ────────────────────────
   *
   * §3A.4: "no code reads flags directly." The API and the WORKER are separate
   * processes, and a loader in each would be two answers to "is this on" - the
   * one that drifts being the worker's, because nobody opens it in a browser.
   * So `loadGateState` lives in `@aura/db`, beside `finance-connectors.ts` and
   * `lead-routing.ts`, which are there for the same reason.
   *
   * What this class adds is the CACHE and the request-scoped subject
   * resolution, neither of which the worker wants: the worker resolves one
   * subject per run and holds no long-lived cache to invalidate.
   */
  private async orgState(orgId: string, feature: GatedFeatureKey): Promise<CachedOrgState> {
    const key = `${orgId}:${feature}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;

    const state = await this.db.withOrg(orgId, (client) => loadGateState(client, feature));
    const entry: CachedOrgState = { ...state, at: Date.now() };
    this.cache.set(key, entry);
    return entry;
  }

  /** The caps, for the metering sweep's alert and the admin screen's bar. */
  async capsFor(orgId: string, feature: GatedFeatureKey) {
    const state = await this.orgState(orgId, feature);
    return { ...evaluateCaps(state.usage, state.limits), usage: state.usage };
  }

  /** The spec, for the console's locked/upgrade state. */
  spec(feature: GatedFeatureKey) {
    return gatedFeatureSpec(feature);
  }
}
