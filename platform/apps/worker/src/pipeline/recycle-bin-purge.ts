import { getAdminPool } from "@aura/db";
import { RECYCLE_BIN, RECYCLE_BIN_RESOURCES, RECYCLE_BIN_RETENTION_DAYS } from "@aura/shared";

/**
 * Empty the recycle bin (migration 0108).
 *
 * A row soft-deleted more than `RECYCLE_BIN_RETENTION_DAYS` ago is deleted for
 * real, and only then do its children cascade away as they always did. That
 * cascade is the point: this is the one place the destruction 0108 deferred
 * actually happens, and it happens after the tenant has had a month to change
 * their mind.
 *
 * ── SET-BASED AND CROSS-TENANT, LIKE THE OTHER SWEEPS ─────────────────────
 *
 * One DELETE per table across every org on the admin pool, the same shape the
 * outreach and automation sweeps use. Looping orgs would be N round trips to
 * do what the database does in one, and there is no per-tenant decision to make
 * here: the retention window is a platform constant, not a tenant setting.
 *
 * ── WHY THE LIST COMES FROM THE SHARED CATALOGUE ──────────────────────────
 *
 * Hard-coding the seven tables here is the failure this file is written to
 * avoid. A table added to the API's catalogue but not to a private list in the
 * worker would be soft-deleted forever: invisible in the console, never purged,
 * accumulating. Iterating `RECYCLE_BIN_RESOURCES` means the two cannot drift,
 * and the shared test asserts the catalogue covers every enum member.
 *
 * ── ORDER DOES NOT MATTER, AND THAT IS WORTH SAYING ───────────────────────
 *
 * None of the seven tables references another, so there is no parent to purge
 * before a child and no foreign key that could make one DELETE fail because
 * another has not run yet. If that ever stops being true, this loop needs an
 * order and the migration that broke it should say so.
 */
export async function purgeRecycleBin(): Promise<number> {
  const pool = getAdminPool();
  let purged = 0;

  for (const resource of RECYCLE_BIN_RESOURCES) {
    const { table } = RECYCLE_BIN[resource];
    // `make_interval` rather than string concatenation: the constant is a
    // number in TypeScript and stays one all the way into the plan.
    const { rowCount } = await pool.query(
      `DELETE FROM ${table}
        WHERE deleted_at IS NOT NULL
          AND deleted_at < now() - make_interval(days => $1)`,
      [RECYCLE_BIN_RETENTION_DAYS],
    );
    if (rowCount) {
      purged += rowCount;
      console.log(`recycle bin: purged ${rowCount} ${table} row(s)`);
    }
  }

  return purged;
}

/**
 * Six hours.
 *
 * The retention window is 30 days, so the exact minute a row leaves is not
 * something anybody observes or depends on, and a tighter tick would only be
 * seven DELETEs against partial indexes that are almost always empty. Six hours
 * keeps a purge within a quarter-day of its due time and costs four sweeps a
 * day.
 */
export function startRecycleBinPurge(): NodeJS.Timeout {
  const interval = Number(process.env.RECYCLE_BIN_PURGE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  return setInterval(() => {
    void purgeRecycleBin().catch((err) => console.error("recycle bin purge:", err));
  }, interval);
}
