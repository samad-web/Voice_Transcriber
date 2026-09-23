import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

/**
 * Re-exported so callers can type a helper that takes the client
 * `withOrgContext` hands them, without depending on `pg` directly - the apps
 * talk to Postgres only through this package.
 */
export type { PoolClient } from "pg";

export * from "./secrets";
export * from "./oauth-apps";
export * from "./ssrf-guard";
export * from "./lead-routing";
export * from "./crm-projection";
export * from "./lead-stage-history";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

/**
 * One TLS rule for every pool (mirrored in packages/db/ssl.js for the plain
 * node scripts). Managed Postgres - Supabase included - refuses plaintext,
 * while the local docker instance has no certificate, so the host decides.
 * Supabase's chain is not in Node's default store; set DB_SSL_CA to a PEM path
 * for full verification.
 */
function sslFor(connectionString: string) {
  if (process.env.DB_SSL === "0") return undefined;
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
  if (process.env.DB_SSL !== "1" && LOCAL_HOSTS.has(host)) return undefined;
  if (process.env.DB_SSL_CA) {
    return { ca: readFileSync(process.env.DB_SSL_CA, "utf8"), rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

let pool: Pool | undefined;

/**
 * Runtime pool - connects as the NON-superuser `aura_app` role so Postgres
 * RLS is actually enforced (superusers and table owners bypass it, which is
 * the classic and expensive mistake - design doc §2).
 */
export function getPool(): Pool {
  if (!pool) {
    const connectionString =
      process.env.APP_DATABASE_URL ??
      "postgresql://aura_app:aura_app_password@localhost:5433/callintel";
    pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10), ssl: sslFor(connectionString) });
  }
  return pool;
}

/**
 * The canonical UUID shape, anchored. Hex and dashes only - nothing that
 * survives this test can carry SQL syntax, which is what makes the batched
 * preamble in `withOrgContext` safe to build by interpolation.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sets the transaction's TimeZone to the org's reporting zone (see
 * withOrgContext). `$1` is the org id - bound on the slow path, replaced by a
 * UUID_RE-checked literal on the fast one. Exported for the test that pins it.
 */
export const ORG_TIME_ZONE_SQL = `SELECT set_config('TimeZone',
  COALESCE((SELECT reporting_timezone FROM organizations WHERE id = $1::uuid), 'Asia/Kolkata'), true)`;

/**
 * Run `fn` inside a transaction with `app.org_id` set transaction-locally.
 * Every tenant-scoped query MUST go through this - RLS policies filter on
 * current_setting('app.org_id') and default-deny when it is unset.
 *
 * WHY THE PREAMBLE IS ONE STATEMENT, NOT TWO: this wrapper is on the path of
 * every tenant-scoped request in the platform, and `BEGIN` followed by
 * `set_config` used to be two separate awaits - two full network round trips
 * to Postgres before a single byte of the caller's own work was sent. The
 * database is in AWS Seoul and the app runs in Mumbai, so each of those costs
 * ~125ms; the pair was a fixed ~250ms tax on every request, entirely overhead.
 *
 * node-postgres does not pipeline - it writes a query, waits for its result,
 * then writes the next - so the only way to spend one round trip instead of
 * two is to send both statements in a single message. That means the simple
 * query protocol, which does not accept bind parameters, so the org id has to
 * be interpolated. `UUID_RE` above is what makes that safe: the value is
 * checked against an anchored hex-and-dashes pattern first, and anything that
 * is not literally a UUID never reaches the string.
 *
 * A non-UUID org id falls back to the original parameterised two-trip path
 * rather than throwing. Nothing in the platform passes one today, but a
 * caller that did would keep working correctly and merely stay slow - the
 * failure mode of a performance change should never be a broken request.
 *
 * ── THE TRANSACTION RUNS ON THE WORKSPACE'S CLOCK (Build docs/30) ──────────
 *
 * The preamble also sets `TimeZone` to the org's `reporting_timezone`, in the
 * SAME message - so it costs no round trip. Every tenant-scoped statement then
 * reads time the way the people using it do: `current_date`, `ts::date`,
 * `date_trunc('day', ts)`, `to_char(ts, ...)` and a `$1::date` compared with a
 * timestamptz all mean the org's midnight, not UTC's. Before this, each of
 * those quietly filed 00:00-05:29 IST under the previous day, and fixing them
 * one call site at a time would have left the next one to be found.
 *
 * What it does NOT change: stored values (timestamptz is an instant), values
 * node-postgres returns (it parses the offset), explicit `AT TIME ZONE x`
 * conversions, or cross-org work outside this wrapper. Anything that must
 * stay on the platform's UTC month (billing, the ASR budget) says 'UTC'
 * explicitly - `date_trunc('month', now(), 'UTC')` - rather than relying on
 * the session default.
 *
 * Read inline from `organizations` (0090) rather than via org_reporting_tz()
 * (0132) so an API deployed ahead of its migration still boots. The zone was
 * validated against pg_timezone_names when it was written (0090's trigger).
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    // third arg `true` = transaction-scoped; resets automatically on COMMIT/ROLLBACK.
    // The zone statement runs AFTER app.org_id is set, so RLS lets it read the org row.
    if (UUID_RE.test(orgId)) {
      await client.query(
        `BEGIN; SELECT set_config('app.org_id', '${orgId}', true); ${ORG_TIME_ZONE_SQL.replace("$1", `'${orgId}'`)}`,
      );
    } else {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      await client.query(ORG_TIME_ZONE_SQL, [orgId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

let adminPool: Pool | undefined;

/**
 * Admin/owner pool - bypasses RLS. Use ONLY for flows that legitimately run
 * before an org context exists (device enrollment token lookup, bootstrap).
 * Everything tenant-scoped goes through withOrgContext().
 */
export function getAdminPool(): Pool {
  if (!adminPool) {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://aura:aura_dev_password@localhost:5433/callintel";
    adminPool = new Pool({ connectionString, max: Number(process.env.DB_ADMIN_POOL_MAX ?? 3), ssl: sslFor(connectionString) });
  }
  return adminPool;
}

export async function closeAllPools(): Promise<void> {
  await pool?.end();
  pool = undefined;
  await adminPool?.end();
  adminPool = undefined;
}
