import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

/**
 * The funnel's Postgres connection. SERVER ONLY.
 *
 * ── Why this is not `import "server-only"` ──────────────────────────────────
 * The `server-only` package is not installed in this workspace, and adding a
 * dependency is the integration agent's step, not this one's. The guard below is
 * the same idea enforced at runtime: if this module is ever pulled into a client
 * bundle the app breaks immediately and loudly, rather than shipping a
 * connection string to a browser. Adding `server-only` to package.json and
 * importing it here is a one-line follow-up that turns this into a BUILD error,
 * which is strictly better - do it.
 *
 * ── Why its own connection string ────────────────────────────────────────────
 * `FUNNEL_DATABASE_URL` connects as `aura_marketing` (migration 0020): USAGE on
 * the `marketing` schema and nothing else in the database. It must NEVER fall
 * back to DATABASE_URL (the migration owner) or APP_DATABASE_URL (`aura_app`,
 * which reaches every tenant table in `public` and whose isolation depends on
 * the caller setting `app.org_id` on every transaction - a discipline that
 * belongs to apps/api and apps/worker and has no business existing in a
 * marketing site).
 *
 * A fallback would mean a public, unauthenticated form holding credentials to
 * live customer data. There is no fallback, deliberately, and this file is the
 * only place that reads the variable.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/funnel/db is server-only and must never be imported by a Client Component");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

/**
 * TLS decided by host, mirroring packages/db/ssl.js exactly.
 *
 * Copied rather than imported: `@aura/db` is a CommonJS package that pulls the
 * whole tenant data layer, and this app has no dependency on it and should not
 * acquire one. Twelve lines duplicated is a smaller cost than a marketing server
 * that can `require` the tenant pool. If ssl.js changes, change this too.
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

/**
 * Is the funnel wired up?
 *
 * Read at request time, never at module scope, so an unset variable does not
 * break `next build` - every content page on this site is statically rendered
 * and none of them touch this module.
 *
 * When this is false the form renders a visible "not configured yet" notice
 * instead of a form that 500s on submit. That is the same posture lib/site.ts
 * already takes for `NEXT_PUBLIC_WHATSAPP_NUMBER`: a broken control that LOOKS
 * fine is worse than one that says so.
 */
export function funnelConfigured(): boolean {
  return Boolean(process.env.FUNNEL_DATABASE_URL);
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.FUNNEL_DATABASE_URL;
  if (!url) {
    throw new Error(
      "FUNNEL_DATABASE_URL is not set. Call funnelConfigured() before reaching the database.",
    );
  }
  pool = new Pool({
    connectionString: url,
    ssl: sslFor(url),
    // Small on purpose. This is a marketing site: a handful of form submissions
    // an hour against a database that is also serving the product. A generous
    // pool here would be a self-inflicted connection-limit incident on the
    // instance that runs the console.
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // Nothing the funnel does is worth holding a connection for longer than a
    // page load. A hung statement here would otherwise pin one of four slots.
    statement_timeout: 5_000,
  });
  // A pool that emits 'error' with no listener takes the process down - and this
  // process serves the whole marketing site, including nine static pages that
  // have nothing to do with the funnel.
  pool.on("error", (err) => {
    console.error("[funnel] idle client error", err.message);
  });
  return pool;
}

/**
 * Run a function against one checked-out client inside a transaction.
 *
 * The dedupe path is read-then-write and must be atomic: two submissions from
 * the same person arriving together would otherwise both find "no existing row"
 * and both INSERT, and one of them would hit `funnel_phone_uniq`. See
 * ./repository.ts, which handles that collision explicitly rather than relying
 * on this alone.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already gone; the transaction is aborted either way.
      // Swallowing here keeps the ORIGINAL error as the one that propagates,
      // which is the one that says what actually failed.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** A single statement outside a transaction. Used by the rate limiter. */
export async function query<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const result = await getPool().query(text, params);
  return result.rows as R[];
}
