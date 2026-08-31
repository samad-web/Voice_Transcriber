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
import { API_SCOPES } from "../packages/shared/src/api-scopes.js";
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

  /**
   * The same drift class, for the API-key scope vocabulary (0076).
   *
   * `api_keys_scopes_known` and `API_SCOPES` are two statements of one closed
   * set, and this is the security-critical instance of the problem: if the
   * array in the migration ever gains a value the zod enum lacks, a key could
   * be minted holding a scope no route requires and no reviewer reading
   * api-scopes.ts would ever see it.
   *
   * Written separately from the `it.each` above because that block matches
   * `column = ANY(...)` constraints and this one is an array-containment
   * (`scopes <@ ARRAY[...]`) — a different constraint shape, same failure mode.
   */
  it("api_keys.scopes CHECK matches API_SCOPES exactly", async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'api_keys'::regclass AND conname = 'api_keys_scopes_known'`,
      );
      expect(rows.length, "api_keys_scopes_known constraint is missing").toBe(1);
      const inDb = [...rows[0].def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
      expect(inDb).toEqual([...API_SCOPES].sort());
    } finally {
      await client.end();
    }
  });
});

/**
 * seed_default_board (migration 0075) — the ONE implementation of "this org has
 * a board", called by three places that must not be allowed to diverge:
 * 0075's own backfill, `seedBoardDefaults` in the admin dashboard's tenant
 * provisioning (apps/api/src/modules/admin/admin.controller.ts), and the dev
 * seed. A CRM created from the admin dashboard tomorrow has to come up
 * identical to one that predates the migration; the only way to guarantee that
 * is for all three to run the same code, and the only way to know they still
 * do is to test the function itself.
 *
 * Each test runs inside a transaction it rolls back, so the ephemeral stack's
 * schema is left exactly as the migration tests above left it.
 */
describe("seed_default_board — every provisioned tenant gets the same board", () => {
  const ORG = "0000dead-0000-4000-8000-00000000b0a5";

  async function withRollback<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, name, enabled_modules) VALUES ($1, 'Seed Probe', ARRAY['aura'])`,
        [ORG],
      );
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  }

  it("gives a brand-new org a complete board from nothing", async () => {
    await withRollback(async (client) => {
      const {
        rows: [{ seed_default_board: boardId }],
      } = await client.query<{ seed_default_board: string }>(
        `SELECT seed_default_board($1)`,
        [ORG],
      );
      expect(boardId).toBeTruthy();

      const {
        rows: [shape],
      } = await client.query<{
        cols: number;
        fallback: number;
        mappings: number;
        template: number;
        pipelines: number;
        binds_default_pipeline: boolean;
      }>(
        `SELECT (SELECT count(*)::int FROM board_columns WHERE board_id = $1) AS cols,
                (SELECT count(*)::int FROM board_columns WHERE board_id = $1 AND is_fallback) AS fallback,
                (SELECT count(*)::int FROM board_column_stages WHERE board_id = $1) AS mappings,
                (SELECT jsonb_array_length(template) FROM boards WHERE id = $1) AS template,
                (SELECT count(*)::int FROM deal_pipelines WHERE org_id = $2) AS pipelines,
                (SELECT b.pipeline_id = p.id FROM boards b
                   JOIN deal_pipelines p ON p.org_id = $2 AND p.is_default
                  WHERE b.id = $1) AS binds_default_pipeline`,
        [boardId, ORG],
      );

      // 6 lifecycle columns + the fallback; the fallback is deliberately NOT in
      // board_column_stages, so mappings is 6 stages x 2 models.
      expect(shape.cols).toBe(7);
      expect(shape.fallback).toBe(1);
      expect(shape.mappings).toBe(12);
      expect(shape.template).toBe(7);
      // A board needs a pipeline (NOT NULL), so the function creates one when
      // the org has none — and binds to it rather than to a second one.
      expect(shape.pipelines).toBe(1);
      expect(shape.binds_default_pipeline).toBe(true);
    });
  });

  it("is idempotent — a second call returns the same board and writes nothing", async () => {
    await withRollback(async (client) => {
      const first = await client.query<{ seed_default_board: string }>(
        `SELECT seed_default_board($1)`,
        [ORG],
      );
      const second = await client.query<{ seed_default_board: string }>(
        `SELECT seed_default_board($1)`,
        [ORG],
      );
      expect(second.rows[0].seed_default_board).toBe(first.rows[0].seed_default_board);

      const {
        rows: [after],
      } = await client.query<{ boards: number; cols: number }>(
        `SELECT (SELECT count(*)::int FROM boards WHERE org_id = $1) AS boards,
                (SELECT count(*)::int FROM board_columns c
                   JOIN boards b ON b.id = c.board_id WHERE b.org_id = $1) AS cols`,
        [ORG],
      );
      expect(after.boards).toBe(1);
      expect(after.cols).toBe(7);
    });
  });

  /**
   * The regression this pins: seedCrmDefaults used to INSERT a 'Sales Pipeline'
   * with is_default = true unconditionally. Once seed_default_board also
   * find-or-creates one, enabling the CRM module on an org would leave TWO
   * default pipelines — and "exactly one default per org" is app-enforced only
   * (0034 says so), so nothing in the database would have caught it.
   */
  it("enabling CRM after provisioning does not create a second default pipeline", async () => {
    await withRollback(async (client) => {
      await client.query(`SELECT seed_default_board($1)`, [ORG]);

      // seedCrmDefaults' pipeline insert, verbatim.
      await client.query(
        `INSERT INTO deal_pipelines (org_id, name, stages, is_default)
         SELECT $1, 'Sales Pipeline', $2::jsonb, true
          WHERE NOT EXISTS (
            SELECT 1 FROM deal_pipelines p WHERE p.org_id = $1 AND p.status = 'active')`,
        [ORG, JSON.stringify([])],
      );

      const {
        rows: [{ defaults, total }],
      } = await client.query<{ defaults: number; total: number }>(
        `SELECT count(*) FILTER (WHERE is_default)::int AS defaults,
                count(*)::int AS total
           FROM deal_pipelines WHERE org_id = $1`,
        [ORG],
      );
      expect(defaults).toBe(1);
      expect(total).toBe(1);
    });
  });
});
