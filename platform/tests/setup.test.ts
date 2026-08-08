/**
 * Proves the integration harness itself works, against the ephemeral stack in
 * docker-compose.test.yml.
 *
 * SCOPE: this is NOT the pipeline suite 08_ROAD_TO_10 §1.3 calls for (upload →
 * ASR → extraction → lead → CRM dispatch, tenant isolation, retry/retirement).
 * That suite does not exist. What exists is `tests/setup/env.ts` and
 * `tests/setup/migrate.ts`, and until this file was added neither had ever been
 * executed — including `env.ts`, the module whose entire job is to refuse to
 * point the destructive suite at production or at the developer's dev stack.
 * An unexercised safety check is a comment.
 *
 * So: this file exercises the safety guards (they must REJECT, which is the
 * failure mode that matters) and runs the migrations end to end. Everything the
 * eventual pipeline suite needs — a schema, a validated connection, `childEnv()`
 * — is what is verified here.
 *
 * Requires `pnpm test:integration:up` first.
 */
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { CallStatus, CrmSyncStatus } from "../packages/shared/src/enums.js";
import {
  API_BASE,
  DATABASE_URL,
  RABBITMQ_URL,
  S3_BUCKET,
  S3_ENDPOINT,
  TEST_MINIO_PORT,
  TEST_PG_PORT,
  TEST_RABBIT_PORT,
  assertDisposable,
  assertNotDevStack,
  childEnv,
} from "./setup/env.js";
import { resetSchema, runMigrations } from "./setup/migrate.js";

describe("env.ts — the safety file", () => {
  it("refuses a non-loopback host", () => {
    expect(() =>
      assertDisposable(
        "TEST_DATABASE_URL",
        "postgresql://u:p@db.abcdefg.supabase.co:5432/postgres",
      ),
    ).toThrow(/not loopback/);
  });

  it("refuses an unparseable url rather than falling back to a default", () => {
    expect(() => assertDisposable("TEST_DATABASE_URL", "postgres://:")).toThrow();
  });

  it("accepts loopback in every form", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(
        assertDisposable("X", `postgresql://u:p@${host}:${TEST_PG_PORT}/callintel`),
      ).toBeInstanceOf(URL);
    }
  });

  // The check a plain localhost test would miss, and the one that protects a
  // developer's in-progress data.
  it.each([
    [5432, "a native PostgreSQL install", TEST_PG_PORT],
    [5433, "the DEV stack's postgres", TEST_PG_PORT],
    [5672, "the DEV stack's rabbitmq", TEST_RABBIT_PORT],
    [9000, "the DEV stack's minio", TEST_MINIO_PORT],
    [4000, "the DEV api", 54000],
  ])("refuses port %i (%s)", (port, _why, expected) => {
    expect(() => assertNotDevStack("X", new URL(`http://127.0.0.1:${port}`), expected)).toThrow(
      /REFUSING TO RUN/,
    );
  });

  it("refuses a loopback port that is merely wrong, not just dangerous", () => {
    expect(() => assertNotDevStack("X", new URL("http://127.0.0.1:6001"), TEST_PG_PORT)).toThrow(
      /publishes 55432/,
    );
  });

  it("the module's own exported urls point at the test stack", () => {
    assertNotDevStack("DATABASE_URL", new URL(DATABASE_URL), TEST_PG_PORT);
    assertNotDevStack("RABBITMQ_URL", new URL(RABBITMQ_URL), TEST_RABBIT_PORT);
    assertNotDevStack("S3_ENDPOINT", new URL(S3_ENDPOINT), TEST_MINIO_PORT);
    expect(S3_BUCKET).toBe("aura-recordings-test");
    expect(API_BASE).toBe("http://127.0.0.1:54000/v1");
  });
});

describe("childEnv() — what a spawned api/worker would inherit", () => {
  const env = childEnv();

  it("does not leak the parent's DATABASE_URL", () => {
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
  });

  // The dangerous half of the @nestjs/config behaviour env.ts documents: any
  // variable left unset here is taken from platform/.env, which on a developer
  // machine holds real provider keys.
  it("explicitly blanks every real provider key", () => {
    for (const key of ["GEMINI_API_KEY", "SARVAM_API_KEY", "ANALYZE_PROVIDER"]) {
      expect(key in env, `${key} must be set, not absent`).toBe(true);
      expect(env[key]).toBe("");
    }
    expect(env.ASR_STUB).toBe("1");
    expect(env.ANALYZE_STUB).toBe("1");
  });

  it("never claims to be production", () => {
    expect(env.NODE_ENV).toBe("test");
  });
});

describe("migrate.ts — against the ephemeral stack", () => {
  // The schema is deliberately left behind after the run — a follow-up suite,
  // or a human debugging a red run, wants it. The stack is tmpfs-only, so
  // `pnpm test:integration:down` is the reset.
  it("applies every migration to a clean schema", async () => {
    await resetSchema();
    const applied = await runMigrations();
    const onDisk = (await import("node:fs"))
      .readdirSync("packages/db/migrations")
      .filter((f) => f.endsWith(".sql"));
    expect(applied).toBe(onDisk.length);
  });

  it("is idempotent — a second run applies nothing", async () => {
    expect(await runMigrations()).toBe(0);
  });

  // The invariant packages/db/verify-rls.js enforces in CI, asserted here too
  // because this is the only place it runs on a developer's machine.
  it("leaves every org_id table with FORCE RLS and a policy", async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{
        relname: string;
        relforcerowsecurity: boolean;
        pols: number;
      }>(
        `SELECT c.relname, c.relforcerowsecurity,
                (SELECT count(*)::int FROM pg_policies p
                  WHERE p.tablename = c.relname AND p.schemaname = 'public') AS pols
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN information_schema.columns col
             ON col.table_name = c.relname
            AND col.table_schema = 'public'
            AND col.column_name = 'org_id'
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          ORDER BY c.relname`,
      );
      expect(rows.length).toBeGreaterThan(0);
      const gaps = rows.filter((r) => !r.relforcerowsecurity || r.pols === 0);
      expect(gaps.map((g) => g.relname)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  /**
   * The defect class that made `packages/shared/src/enums.ts` dangerous: it
   * drifted from two live CHECK constraints, so a fixture built from the zod
   * enum produced a test that passed while the code wrote a value the database
   * rejected. Reading the constraint out of a real schema is the only check
   * that cannot drift — a unit test comparing the enum to a hand-written list
   * is just the same assumption written twice.
   */
  it.each([
    ["calls", "status", CallStatus],
    // The outbox is still the table named crm_sync_log — 0008 repurposed it in
    // place rather than renaming it (0008_crm_outbox.sql:50). Naming it
    // `crm_dispatch_outbox` here silently matches nothing.
    ["crm_sync_log", "status", CrmSyncStatus],
  ])("%s.%s CHECK matches the zod enum exactly", async (table, column, schema) => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      // The leading paren matters: without it `%status = ANY%` also matches
      // calls_consent_status_check, and the assertion compares the wrong list.
      const { rows } = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = to_regclass($1) AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%(' || $2 || ' = ANY%'`,
        [table, column],
      );
      expect(rows.length, `no CHECK on ${table}.${column}`).toBe(1);
      const inDb = [...rows[0].def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
      expect(inDb).toEqual([...schema.options].sort());
    } finally {
      await client.end();
    }
  });
});
