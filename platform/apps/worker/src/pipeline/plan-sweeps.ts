import { getAdminPool } from "@aura/db";
import { PLAN_MODULES, type PlanKey } from "@aura/shared";

/**
 * Trials that have run out, and downgrades that were scheduled
 * (`Build docs/no-crm-api-dashboard-build-plan.md` §9.5, §9.6).
 *
 * ── NOTHING HERE DELETES DATA ───────────────────────────────────────────────
 *
 * A trial ending and a downgrade landing both do exactly two things: move
 * `plan_id` and reconcile `enabled_modules`. No fact, no snapshot, no event
 * and no configuration is removed. §9.6 and §17 both require it, and the
 * retention window is a read-time floor rather than a reaper for the same
 * reason - a customer who stops paying for twelve months of history has not
 * asked us to destroy it, and an upgrade must bring it straight back.
 *
 * ── WHY THE REVERT IS A SWEEP AND NOT ONLY A QUERY PREDICATE ────────────────
 *
 * `EntitlementsService.resolve` already compares `trial_ends_at > now()`, so an
 * expired trial stops granting anything the moment it expires even if this
 * sweep never runs. That is the safety net, and it is the important half.
 *
 * This sweep is the HOUSEKEEPING half: it clears the columns, puts `status`
 * back to `active`, and - the part a predicate cannot do - narrows
 * `enabled_modules` back to the paid plan's set. Without it, a tenant who
 * trialled Platform would keep `crm` in `enabled_modules` forever, and
 * `CrmPermissionsGuard` reads that column rather than the subscription.
 */

/** A trial that has expired reverts to the plan underneath it. */
export async function revertExpiredTrials(): Promise<number> {
  const pool = getAdminPool();
  const { rows } = await pool.query<{ org_id: string; plan_key: string; trial_plan_key: string }>(
    `SELECT s.org_id, p.key AS plan_key, tp.key AS trial_plan_key
       FROM org_subscriptions s
       JOIN plans p  ON p.id  = s.plan_id
       JOIN plans tp ON tp.id = s.trial_plan_id
      WHERE s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= now()`,
  );
  if (rows.length === 0) return 0;

  for (const row of rows) {
    try {
      await applyPlanModules(row.org_id, row.plan_key as PlanKey);
      await pool.query(
        `UPDATE org_subscriptions
            SET trial_plan_id = NULL, trial_ends_at = NULL,
                status = 'active', updated_at = now()
          WHERE org_id = $1`,
        [row.org_id],
      );
      await pool.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
              VALUES ($1, 'system', $1, 'plan.trial_reverted', 'organization', $1, $2::jsonb)`,
        [row.org_id, JSON.stringify({ from: row.trial_plan_key, to: row.plan_key })],
      );
      console.log(
        `plan sweep: org ${row.org_id} trial of ${row.trial_plan_key} ended, back on ${row.plan_key}`,
      );
    } catch (err) {
      console.error(`plan sweep: reverting trial for org ${row.org_id}:`, err);
    }
  }
  return rows.length;
}

/**
 * A downgrade accepted earlier takes effect at the end of the billing period.
 *
 * §9.6: "Downgrade takes effect at the end of the billing period". The owner
 * saw a preview of what would be locked and acknowledged it; this is where it
 * happens. Over-limit resources are NOT removed - §9.6 says they are flagged
 * for the owner to choose within a grace period, and the quota behaviour in
 * §4 is explicit that a count at its ceiling blocks ADDING and never removes
 * what exists. So after this runs, a tenant may legitimately be over their new
 * telecaller limit, and the usage page says so.
 */
export async function applyPendingDowngrades(): Promise<number> {
  const pool = getAdminPool();
  const { rows } = await pool.query<{
    org_id: string;
    from_key: string;
    to_key: string;
    to_id: string;
  }>(
    `SELECT s.org_id, cur.key AS from_key, pend.key AS to_key, pend.id AS to_id
       FROM org_subscriptions s
       JOIN plans cur  ON cur.id  = s.plan_id
       JOIN plans pend ON pend.id = s.pending_plan_id
      WHERE s.pending_plan_id IS NOT NULL
        AND s.current_period_end IS NOT NULL
        AND s.current_period_end <= now()`,
  );
  if (rows.length === 0) return 0;

  for (const row of rows) {
    try {
      await applyPlanModules(row.org_id, row.to_key as PlanKey);
      await pool.query(
        `UPDATE org_subscriptions
            SET plan_id = $2, pending_plan_id = NULL, status = 'active', updated_at = now()
          WHERE org_id = $1`,
        [row.org_id, row.to_id],
      );
      await pool.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
              VALUES ($1, 'system', $1, 'plan.downgrade_applied', 'organization', $1, $2::jsonb)`,
        [row.org_id, JSON.stringify({ from: row.from_key, to: row.to_key })],
      );
    } catch (err) {
      console.error(`plan sweep: applying downgrade for org ${row.org_id}:`, err);
    }
  }
  return rows.length;
}

/**
 * Reconcile `enabled_modules` to a plan's set.
 *
 * `aura` and `wasi` are preserved unconditionally, exactly as the operator's
 * apply path does: every tenant has an instance and a workspace, and Wasi is
 * configured by hand on the Wasi side with no plan aware of it. A sweep that
 * unpaired a client's WhatsApp number at 3am because their trial ended would
 * be a very bad morning.
 */
async function applyPlanModules(orgId: string, planKey: PlanKey): Promise<void> {
  const modules = PLAN_MODULES[planKey];
  if (!modules) throw new Error(`no module set for plan ${planKey}`);
  await getAdminPool().query(
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

export function startPlanSweep(): NodeJS.Timeout {
  // Hourly. A trial's own expiry is already enforced at read time by
  // `EntitlementsService`, so this sweep's latency decides only how quickly
  // the module list catches up - and an hour of a trialled module lingering
  // costs nothing, because every route that matters reads the entitlement.
  const interval = Number(process.env.PLAN_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000);
  return setInterval(() => {
    void revertExpiredTrials().catch((err) => console.error("plan sweep (trials):", err));
    void applyPendingDowngrades().catch((err) => console.error("plan sweep (downgrades):", err));
  }, interval);
}
