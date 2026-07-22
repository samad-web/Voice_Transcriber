import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

/**
 * One TLS rule for every pool (mirrored in packages/db/ssl.js for the plain
 * node scripts). Managed Postgres — Supabase included — refuses plaintext,
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
 * Runtime pool — connects as the NON-superuser `aura_app` role so Postgres
 * RLS is actually enforced (superusers and table owners bypass it, which is
 * the classic and expensive mistake — design doc §2).
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
 * Run `fn` inside a transaction with `app.org_id` set transaction-locally.
 * Every tenant-scoped query MUST go through this — RLS policies filter on
 * current_setting('app.org_id') and default-deny when it is unset.
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // third arg `true` = transaction-scoped; resets automatically on COMMIT/ROLLBACK
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
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
 * Admin/owner pool — bypasses RLS. Use ONLY for flows that legitimately run
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
