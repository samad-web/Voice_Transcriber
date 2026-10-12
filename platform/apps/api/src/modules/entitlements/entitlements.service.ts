import { Injectable } from "@nestjs/common";
import {
  type EntitlementKey,
  type EntitlementValue,
  type HardValue,
  type PlanKey,
  type QuotaReading,
  type QuotaValue,
  type WindowValue,
  atLeastVariant,
  entitlementSpec,
  readQuota,
  retentionFloor,
} from "@aura/shared";
import { DbService } from "../../db/db.service";

/**
 * The one place a plan limit is decided.
 *
 * `Build docs/no-crm-api-dashboard-build-plan.md` §4's MUST: "Every entitlement
 * is checked by one `Entitlements.check()` service, server-side, in the UI,
 * API, jobs, exports and scheduled reports. No direct plan-name checks
 * scattered through code."
 *
 * There is no `if (plan === "growth")` anywhere in this codebase and there must
 * never be one. `packages/shared/src/plans.ts` was left as an inert stub for
 * two years rather than guess at this, and its header says why: a gate written
 * before the plan system exists is a gate that encodes one product decision
 * forever.
 *
 * ── THE ADMIN POOL, AND WHY THAT IS NOT A SHORTCUT ──────────────────────────
 *
 * `plans` and `plan_entitlements` are the catalogue, not a tenant's copy of
 * it, so they carry no `org_id` and `aura_app` is revoked on both (0192). The
 * resolution below therefore runs on the admin pool, narrowed by an explicit
 * `org_id = $1` on `org_subscriptions`.
 *
 * That is the same bootstrap exception `ApiKeyGuard` documents for resolving an
 * org from a key hash, and the reason is the same: "what may this tenant do"
 * has to be answerable before a tenant context exists to ask it in. The guard
 * runs before `TenantGuard`; the console's page guard runs before any
 * `withOrg`. Every query here is narrowed by a parameter the caller cannot
 * choose - the org comes from the authenticated principal, never from a header
 * or a body.
 *
 * ── FAIL CLOSED FOR FEATURES, FAIL OPEN FOR DATA ────────────────────────────
 *
 * §4's last bullet, and the asymmetry worth understanding before changing
 * anything here:
 *
 *   `hard()` and `quota()` throw on a resolution failure. A feature whose
 *   entitlement cannot be read is a feature the tenant does not get.
 *
 *   `retentionFloorFor()` returns `null` on a resolution failure, meaning "no
 *   floor". A plan-check outage must not hide a customer's own dashboard.
 *
 * Both directions are tested. Collapsing them into one behaviour would either
 * give away paid features during a database blip or black out a paying
 * customer's data during the same blip.
 */

export interface ResolvedPlan {
  planKey: PlanKey | null;
  planName: string | null;
  status: string | null;
  /** The plan being trialled, if any. Entitlements resolve against THIS. */
  trialPlanKey: PlanKey | null;
  trialEndsAt: Date | null;
  pendingPlanKey: PlanKey | null;
  currentPeriodEnd: Date | null;
  values: Map<string, EntitlementValue>;
  limitTypes: Map<string, string>;
}

/** What `check()` answers. Never a bare boolean - the caller needs the reason. */
export interface EntitlementDecision {
  allowed: boolean;
  key: EntitlementKey;
  limitType: string;
  value: EntitlementValue | null;
  /** Present for a quota. */
  quota?: QuotaReading;
  /** A machine reason, mirrored into the §9.4 body. */
  reason: "ok" | "not_entitled" | "variant_too_low" | "quota_exceeded" | "unresolved";
}

/**
 * How long a resolved plan is reused.
 *
 * §9.6 requires an upgrade to unlock "within seconds (entitlement cache
 * invalidated within seconds)". Thirty seconds satisfies that on its own, and
 * `invalidate()` makes it immediate for the path that knows - the operator
 * applying a plan change. The TTL is the backstop for the paths that do not:
 * a trial expiring under the revert sweep, or a limit an operator edited
 * directly in `plan_entitlements`.
 *
 * It is a per-process cache, so a multi-instance deployment can serve a stale
 * answer for up to the TTL on the instances that did not handle the change.
 * Accepted: the worst case is a tenant keeping a feature 30 seconds longer
 * than they paid for, and the alternative is a round trip to Seoul on every
 * request (DB_LATENCY_MIGRATION.md: ~125ms each).
 */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  plan: ResolvedPlan;
  at: number;
}

@Injectable()
export class EntitlementsService {
  private readonly cache = new Map<string, CacheEntry>();
  private planIdCache?: { value: { byKey: Map<string, string>; byId: Map<string, string> }; at: number };

  constructor(private readonly db: DbService) {}

  /** Drop a tenant's cached plan. Called by every write that changes one. */
  invalidate(orgId: string): void {
    this.cache.delete(orgId);
  }

  /**
   * The catalogue's `id ↔ key` map, read on the ADMIN pool.
   *
   * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
   *
   * 0192 REVOKEs `plans` and `plan_entitlements` from `aura_app`: they are the
   * catalogue, not a tenant's copy of it, and nothing a request can reach has
   * any business reading them. That decision is sound and it has a consequence
   * that is easy to forget — **a statement inside `withOrg` may not join
   * `plans`,** because `withOrg` runs as `aura_app`.
   *
   * Four statements in `entitlements.controller.ts` did exactly that, and every
   * one of them answered `permission denied for table plans` the first time a
   * real request hit it. The fix is not a GRANT: it is resolving the id or the
   * key HERE, on the pool that may read the table, and passing it into the
   * org-scoped statement as a parameter.
   *
   * Cached for the same TTL as a resolved plan. The catalogue changes when an
   * operator edits it, which is rare, and a stale id would have to survive a
   * plan being deleted and its id reused - which nothing does.
   */
  async planIds(): Promise<{ byKey: Map<string, string>; byId: Map<string, string> }> {
    const now = Date.now();
    if (this.planIdCache && now - this.planIdCache.at < CACHE_TTL_MS) {
      return this.planIdCache.value;
    }
    const { rows } = await this.db
      .adminPool()
      .query<{ id: string; key: string }>(`SELECT id, key FROM plans`);
    const value = {
      byKey: new Map(rows.map((r) => [r.key, r.id])),
      byId: new Map(rows.map((r) => [r.id, r.key])),
    };
    this.planIdCache = { value, at: now };
    return value;
  }

  /** One plan's id, or null when no such plan exists. */
  async planIdFor(key: string): Promise<string | null> {
    return (await this.planIds()).byKey.get(key) ?? null;
  }

  /**
   * The tenant's plan and every entitlement value it resolves to.
   *
   * An org with NO subscription row resolves to `planKey: null` and an empty
   * value map, which `hard()` and `quota()` read as unlimited. That is
   * deliberate and it is what 0192 relies on when it creates no subscriptions:
   * every tenant that predates the plan system keeps exactly the product they
   * have today. A tenant enters the plan system when an operator puts them on
   * a plan, not when this code ships.
   */
  async resolve(orgId: string): Promise<ResolvedPlan> {
    const cached = this.cache.get(orgId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.plan;

    const { rows } = await this.db.adminPool().query<{
      plan_key: string | null;
      plan_name: string | null;
      status: string | null;
      trial_plan_key: string | null;
      trial_ends_at: Date | null;
      pending_plan_key: string | null;
      current_period_end: Date | null;
      entitlement_key: string | null;
      limit_type: string | null;
      value: EntitlementValue | null;
    }>(
      `WITH sub AS (
         SELECT s.org_id, s.status, s.trial_ends_at, s.current_period_end,
                p.key  AS plan_key,  p.name AS plan_name,
                tp.key AS trial_plan_key,
                pp.key AS pending_plan_key,
                -- A trial resolves against the TRIAL plan while it is live.
                -- Expiry is checked here rather than relying on the revert
                -- sweep having run: a sweep that is late must not hand a
                -- tenant a tier they no longer have, and a comparison in the
                -- query cannot be late.
                CASE WHEN s.trial_plan_id IS NOT NULL AND s.trial_ends_at > now()
                     THEN s.trial_plan_id ELSE s.plan_id END AS effective_plan_id
           FROM org_subscriptions s
           JOIN plans p  ON p.id  = s.plan_id
           LEFT JOIN plans tp ON tp.id = s.trial_plan_id
           LEFT JOIN plans pp ON pp.id = s.pending_plan_id
          WHERE s.org_id = $1
       )
       SELECT sub.plan_key, sub.plan_name, sub.status, sub.trial_plan_key,
              sub.trial_ends_at, sub.pending_plan_key, sub.current_period_end,
              pe.entitlement_key, pe.limit_type, pe.value
         FROM sub
         LEFT JOIN plan_entitlements pe ON pe.plan_id = sub.effective_plan_id`,
      [orgId],
    );

    const head = rows[0];
    const plan: ResolvedPlan = {
      planKey: (head?.plan_key as PlanKey) ?? null,
      planName: head?.plan_name ?? null,
      status: head?.status ?? null,
      trialPlanKey:
        head?.trial_plan_key && head.trial_ends_at && head.trial_ends_at > new Date()
          ? (head.trial_plan_key as PlanKey)
          : null,
      trialEndsAt: head?.trial_ends_at ?? null,
      pendingPlanKey: (head?.pending_plan_key as PlanKey) ?? null,
      currentPeriodEnd: head?.current_period_end ?? null,
      values: new Map(),
      limitTypes: new Map(),
    };
    for (const row of rows) {
      if (!row.entitlement_key || !row.value) continue;
      plan.values.set(row.entitlement_key, row.value);
      plan.limitTypes.set(row.entitlement_key, row.limit_type ?? "hard");
    }

    this.cache.set(orgId, { plan, at: Date.now() });
    return plan;
  }

  /**
   * A `hard` entitlement, optionally at a minimum variant.
   *
   * Fails closed: an org on a plan that does not list the key is NOT entitled.
   * An org on NO plan is - see `resolve`.
   */
  async hard(orgId: string, key: EntitlementKey, minVariant?: string): Promise<EntitlementDecision> {
    const spec = entitlementSpec(key);
    const plan = await this.resolve(orgId);
    if (!plan.planKey) {
      return { allowed: true, key, limitType: spec.limitType, value: null, reason: "ok" };
    }
    const value = plan.values.get(key) as HardValue | undefined;
    if (!value?.enabled) {
      return {
        allowed: false,
        key,
        limitType: spec.limitType,
        value: value ?? null,
        reason: "not_entitled",
      };
    }
    if (minVariant && !atLeastVariant(key, value, minVariant)) {
      return {
        allowed: false,
        key,
        limitType: spec.limitType,
        value,
        reason: "variant_too_low",
      };
    }
    return { allowed: true, key, limitType: spec.limitType, value, reason: "ok" };
  }

  /** The variant a tenant holds, for a graded entitlement. `null` if absent. */
  async variant(orgId: string, key: EntitlementKey): Promise<string | null> {
    const plan = await this.resolve(orgId);
    if (!plan.planKey) {
      // No plan means no ceiling, so the richest variant the catalogue offers.
      return entitlementSpec(key).variants?.at(-1) ?? null;
    }
    const value = plan.values.get(key) as HardValue | undefined;
    return value?.enabled ? (value.variant ?? null) : null;
  }

  /**
   * Where a quota stands, without consuming any of it.
   *
   * `period` is the meter bucket: a calendar month for a volume, `'current'`
   * for a standing count. Derived here rather than passed in, so two callers
   * cannot meter the same entitlement into two different buckets.
   */
  async quota(orgId: string, key: EntitlementKey, usedOverride?: number): Promise<EntitlementDecision> {
    const spec = entitlementSpec(key);
    const plan = await this.resolve(orgId);
    const value = plan.planKey ? (plan.values.get(key) as QuotaValue | undefined) : undefined;
    const limit = plan.planKey ? (value?.limit ?? null) : null;

    const used = usedOverride ?? (await this.usedNow(orgId, key, value?.per ?? null));
    const reading = readQuota(limit, used);
    return {
      allowed: reading.state !== "blocked",
      key,
      limitType: spec.limitType,
      value: value ?? null,
      quota: reading,
      reason: reading.state === "blocked" ? "quota_exceeded" : "ok",
    };
  }

  /**
   * Add to a meter and say whether the write may proceed.
   *
   * ── WHY THE INCREMENT HAPPENS BEFORE THE DECISION ───────────────────────────
   *
   * The UPSERT returns the new total and the verdict is computed from it, in
   * one round trip. The alternative - read, decide, write - is two round trips
   * and a race: two concurrent batches both read 49,999 and both proceed.
   *
   * The consequence is that a refused write still counted toward the meter,
   * which sounds wrong and is the right trade. The §4 grace band means a
   * refusal only happens at 110% of the limit, so the over-count is inside a
   * band that was already slack; and a meter that under-counts under
   * concurrency is a limit that does not hold, which is worse than one that
   * over-counts by a few events at the ceiling.
   *
   * It also means a replayed batch does not double-count, because the caller
   * only consumes for items it actually accepted - duplicates are filtered by
   * the idempotency index before reaching here.
   */
  async consume(
    orgId: string,
    key: EntitlementKey,
    amount: number,
  ): Promise<EntitlementDecision> {
    const spec = entitlementSpec(key);
    const plan = await this.resolve(orgId);
    const value = plan.planKey ? (plan.values.get(key) as QuotaValue | undefined) : undefined;
    const limit = plan.planKey ? (value?.limit ?? null) : null;
    const period = this.periodKey(value?.per ?? null);

    const {
      rows: [row],
    } = await this.db.adminPool().query<{ used: string }>(
      `INSERT INTO usage_meters (org_id, entitlement_key, period, used)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, entitlement_key, period)
       DO UPDATE SET used = usage_meters.used + EXCLUDED.used, updated_at = now()
         RETURNING used`,
      [orgId, key, period, amount],
    );
    const used = Number(row?.used ?? amount);
    const reading = readQuota(limit, used);

    // Stamp the first crossing of each threshold, so the §9.2 banner and the
    // owner email fire once per period rather than on every tick. A separate
    // statement because it must not run on the hot path for the 99% of writes
    // that cross nothing.
    if (reading.state === "warning" || reading.state === "grace") {
      void this.stamp(orgId, key, period, "warned_at");
    } else if (reading.state === "blocked") {
      void this.stamp(orgId, key, period, "blocked_at");
    }

    return {
      allowed: reading.state !== "blocked",
      key,
      limitType: spec.limitType,
      value: value ?? null,
      quota: reading,
      reason: reading.state === "blocked" ? "quota_exceeded" : "ok",
    };
  }

  /**
   * The earliest instant a read may ask about, or `null` for no floor.
   *
   * **Fails open.** Catches its own error and answers `null`, because §4 asks
   * for exactly that: "fail closed for features, fail open for already-ingested
   * data visibility (a plan check outage must not hide a customer's own
   * dashboard)". The only thing a retention window does is limit what is
   * DISPLAYED - 0192 deletes nothing and neither does this - so the worst case
   * of failing open is a customer briefly seeing more of their own data than
   * they pay for.
   */
  async retentionFloorFor(orgId: string, now = new Date()): Promise<Date | null> {
    try {
      const plan = await this.resolve(orgId);
      if (!plan.planKey) return null;
      const value = plan.values.get("history_retention") as WindowValue | undefined;
      return retentionFloor(value ?? null, now);
    } catch (err) {
      console.error(`entitlements: retention floor for org ${orgId}:`, err);
      return null;
    }
  }

  /** The audit-log window, same fail-open rule. */
  async auditFloorFor(orgId: string, now = new Date()): Promise<Date | null> {
    try {
      const plan = await this.resolve(orgId);
      if (!plan.planKey) return null;
      return retentionFloor(
        (plan.values.get("audit_log_window") as WindowValue | undefined) ?? null,
        now,
      );
    } catch {
      return null;
    }
  }

  /**
   * Every meter, for §8.10's usage page and `GET /v1/usage`.
   *
   * Standing counts are RECOUNTED here rather than read from the meter table.
   * `active_telecallers` has to fall when somebody is archived, and a counter
   * that only goes up cannot do that - the same recompute-don't-accumulate
   * argument `telecaller-stats.ts` makes. Volumes are read from the meter,
   * because once the raw events age out there is nothing left to recount from.
   */
  async usageReport(orgId: string): Promise<{
    plan: ResolvedPlan;
    meters: { key: string; limitType: string; reading: QuotaReading; per: string | null }[];
  }> {
    const plan = await this.resolve(orgId);
    const month = this.periodKey("month");

    const { rows: counts } = await this.db.adminPool().query<{
      telecallers: string;
      logins: string;
      handsets: string;
      events_month: string | null;
      kpis: string;
    }>(
      `SELECT (SELECT count(*) FROM telecallers WHERE org_id = $1 AND status = 'active') AS telecallers,
              -- A suspended member cannot sign in, so they do not occupy a
              -- login slot. And a telecaller self-view is excluded by §4's own
              -- wording ("Dashboard logins (non-telecaller)") - charging a
              -- customer a seat for letting a rep see their own score would
              -- price them out of the one view that helps the rep.
              (SELECT count(*) FROM memberships m
                 WHERE m.org_id = $1
                   AND COALESCE(m.status, 'active') = 'active'
                   AND COALESCE(m.owner_role, '') <> 'telecaller')                     AS logins,
              (SELECT count(*) FROM devices WHERE org_id = $1 AND status = 'active')    AS handsets,
              (SELECT used FROM usage_meters
                 WHERE org_id = $1 AND entitlement_key = 'ingest_events_monthly'
                   AND period = $2)                                                    AS events_month,
              -- The KPIs live TODAY, which is the set this quota governs and
              -- the same predicate liveKpiKeys() reads (org scope only - a
              -- narrower scope overrides a target, it never adds a KPI). A
              -- closed-out set from last month does not occupy a slot.
              (SELECT count(*) FROM org_kpi_config
                 WHERE org_id = $1 AND scope_kind = 'org'
                   AND effective_from <= CURRENT_DATE
                   AND (effective_to IS NULL OR effective_to > CURRENT_DATE))          AS kpis`,
      [orgId, month],
    );
    const live = counts[0];
    const recounted: Record<string, number> = {
      active_telecallers: Number(live?.telecallers ?? 0),
      dashboard_logins: Number(live?.logins ?? 0),
      paired_handsets: Number(live?.handsets ?? 0),
      ingest_events_monthly: Number(live?.events_month ?? 0),
      selectable_kpis: Number(live?.kpis ?? 0),
    };

    const meters: {
      key: string;
      limitType: string;
      reading: QuotaReading;
      per: string | null;
    }[] = [];
    for (const [key, limitType] of plan.limitTypes) {
      if (limitType !== "quota") continue;
      // A per-minute ceiling is a RATE, not a period total, so there is no
      // "used this period" that belongs beside it - it rendered as a bar
      // frozen at "0 of 300" that could never move, which reads as a broken
      // meter rather than as a cap. The number itself is not lost: the compare
      // table on the same page lists it for every plan, which is where a cap
      // belongs. Enforcement is unaffected - that goes through `quota()`.
      if (key === "api_rate_per_min") continue;
      const value = plan.values.get(key) as QuotaValue;
      const used = recounted[key] ?? 0;
      meters.push({
        key,
        limitType,
        reading: readQuota(value.limit ?? null, used),
        per: value.per ?? null,
      });
    }
    // An org with no plan still has usage worth seeing on the page; it just has
    // no limits to compare it against.
    if (!plan.planKey) {
      for (const [key, used] of Object.entries(recounted)) {
        meters.push({ key, limitType: "quota", reading: readQuota(null, used), per: null });
      }
    }
    return { plan, meters };
  }

  /** The bucket a meter writes into. */
  private periodKey(per: string | null): string {
    if (per !== "month") return "current";
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  private async usedNow(orgId: string, key: EntitlementKey, per: string | null): Promise<number> {
    const {
      rows: [row],
    } = await this.db
      .adminPool()
      .query<{ used: string }>(
        `SELECT used FROM usage_meters
          WHERE org_id = $1 AND entitlement_key = $2 AND period = $3`,
        [orgId, key, this.periodKey(per)],
      );
    return Number(row?.used ?? 0);
  }

  /** Best effort: a threshold we failed to stamp is still a threshold crossed. */
  private async stamp(
    orgId: string,
    key: EntitlementKey,
    period: string,
    column: "warned_at" | "blocked_at",
  ): Promise<void> {
    try {
      await this.db.adminPool().query(
        `UPDATE usage_meters SET ${column} = now()
          WHERE org_id = $1 AND entitlement_key = $2 AND period = $3 AND ${column} IS NULL`,
        [orgId, key, period],
      );
    } catch {
      /* observability, not correctness */
    }
  }
}
