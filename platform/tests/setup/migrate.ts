/**
 * Schema setup for the test database.
 *
 * WHY THIS IS NOT `pnpm --filter @aura/db migrate`. `packages/db/migrate.js:14`
 * resolves its connection string as `process.env.DATABASE_URL ?? <dev default>`.
 * Running it means the test stack's schema is created wherever the ambient
 * environment happens to point - which on this project is a shell that may well
 * have production Supabase credentials exported, because deploying the platform
 * requires exactly that. The suite therefore never executes it. The 18 lines of
 * logic it contains are re-implemented here instead, against the connection
 * this suite validated in env.ts and cannot be redirected away from.
 *
 * The semantics are kept identical to migrate.js on purpose, because CI's `db`
 * job and production both run the real thing and a divergence here would mean
 * the suite verifies a schema nobody deploys:
 *
 *   - `migrations/*.sql`, filename order (migrate.js:24-27)
 *   - one transaction per file (migrate.js:37-40)
 *   - recorded in `schema_migrations` and skipped if already applied
 *
 * The one deliberate difference is `resetSchema()`, which has no counterpart:
 * migrate.js is an additive production tool, while a test run wants a schema it
 * fully controls. See its own comment for why DROP SCHEMA is not enough.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { DATABASE_URL, PLATFORM_ROOT } from "./env.js";

const MIGRATIONS_DIR = join(PLATFORM_ROOT, "packages", "db", "migrations");

/**
 * Drop everything and start clean.
 *
 * `DROP SCHEMA public CASCADE` does not remove the `aura_app` ROLE - roles are
 * cluster-wide, not schema-scoped - and 0001_init.sql:9-13 only creates it
 * `IF NOT EXISTS`, so a re-run is fine. What a stale role WOULD keep is its
 * grants on objects that no longer exist, which is harmless, plus its
 * membership in nothing. Left alone deliberately: dropping and recreating the
 * role would invalidate the open connections of a previous run's leaked
 * processes and produce a confusing "role does not exist" mid-suite.
 */
export async function resetSchema(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    // 0001 assumes it is the owner of a usable public schema; restore the
    // default grants a fresh database would have had.
    await client.query("GRANT ALL ON SCHEMA public TO public");
  } finally {
    await client.end();
  }
}

/** Applies every unapplied migration, in filename order. Returns how many ran. */
export async function runMigrations(): Promise<number> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    if (files.length === 0) {
      throw new Error(
        `no migrations found in ${MIGRATIONS_DIR} - the suite would silently test an empty schema`,
      );
    }

    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        // Rethrow rather than migrate.js's `process.exitCode = 1; break`: a
        // half-migrated schema must abort the run loudly, not hand the suite a
        // database that is missing the last few tables and let 57 isolation
        // assertions fail with confusing 500s.
        throw new Error(
          `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return ran;
  } finally {
    await client.end();
  }
}
