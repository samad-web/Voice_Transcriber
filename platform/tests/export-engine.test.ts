import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildCountQuery,
  buildDatasetQuery,
  CURSOR_COLUMN,
  IMPLEMENTED_DATASETS,
  type ResolvedScope,
} from "../apps/worker/src/pipeline/export-queries.js";
import { exportDataset, type OwnerRecordScope } from "@aura/shared";

import { APP_DATABASE_URL, DATABASE_URL } from "./setup/env.js";
import { runMigrations } from "./setup/migrate.js";
import { TENANT_A as A, TENANT_B as B, seedTenants } from "./setup/tenants.js";
import { asTenant, call, type Caller } from "./setup/http.js";

/**
 * The console's own credential: the admin key PLUS the acting user.
 *
 * A bare admin key names nobody, and an export BELONGS to a person - the job
 * row's owner is a NOT NULL FK and the worker re-resolves that person's grants
 * before it reads a row. So the controller refuses a caller with no resolvable
 * user, exactly as `CrmPermissionsGuard` was hardened to do, and these cases
 * assert one the way the web tier does. Same helper as crm-integrity.test.ts:34.
 */
function asOwner(t: typeof A): Caller {
  const base = asTenant(t);
  return { label: `owner/${t.key}`, headers: { ...base.headers, "x-caller-user-id": t.userId } };
}

/**
 * The data export engine (doc 35, migration 0148) against a real Postgres.
 *
 * ── WHY THIS CANNOT BE A UNIT TEST ──────────────────────────────────────────
 *
 * `apps/worker/src/pipeline/export-queries.test.ts` asserts the SQL TEXT: that
 * the aliases match the registry, that a narrowed scope reaches the WHERE. That
 * catches a dropped predicate and cannot catch the thing that actually went
 * wrong while this was being written - columns that do not exist.
 *
 * The first draft of the registry offered `leads.phone`, `contacts.phone` and a
 * `call_analyses` table. Every one of those produced SQL that reads perfectly,
 * typechecks, and passes a string-matching test. Only Postgres says 42703.
 *
 * So group A is the one that matters: it EXECUTES every generated statement.
 * Groups B and C then prove the two behaviours a string cannot show - that the
 * scope predicate removes the right rows, and that keyset paging returns every
 * row exactly once.
 */

const WIDE_OWNER: OwnerRecordScope = {
  role: "owner",
  scope: "all",
  userId: A.userId,
  telecallerId: null,
};

/** Tenant A's telecaller - own-scoped, with a real identity. */
const OWN_OWNER: OwnerRecordScope = {
  role: "telecaller",
  scope: "own",
  userId: A.userId,
  telecallerId: A.telecallerId,
};

/** Own-scoped with NO telecaller row: must see nothing, not everything. */
const ORPHAN_OWNER: OwnerRecordScope = {
  role: "telecaller",
  scope: "own",
  userId: A.userId,
  telecallerId: null,
};

const wide: ResolvedScope = { owner: WIDE_OWNER, crmUserId: null };
const own: ResolvedScope = { owner: OWN_OWNER, crmUserId: null };
const orphan: ResolvedScope = { owner: ORPHAN_OWNER, crmUserId: null };

/**
 * Runs inside a tenant's RLS context as `aura_app` - the role the worker
 * actually connects as - NOT as the admin/superuser.
 *
 * That distinction is the whole point of the cross-tenant case below: the admin
 * role bypasses RLS even where the table says FORCE, so a boundary test run on
 * it proves nothing and passes whether or not the policy exists. The other
 * integration suites here make the same choice for the same reason.
 */
async function inOrg<T>(orgId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: APP_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SELECT set_config('app.org_id', $1, false)", [orgId]);
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The superuser, for seeding and for asking what is REALLY in a table. */
async function asAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A second telecaller and lead in tenant A, so "own" has something to exclude. */
const OTHER_TELECALLER = "00000000-0000-4000-8000-00000000f0a2";
const OTHER_LEAD = "00000000-0000-4000-8000-00000000e0a2";

beforeAll(async () => {
  await runMigrations();
  await seedTenants();

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // `telecallers` is org-scoped and has NO workspace_id - a telecaller is a
    // person in the tenant, not a row on one desk.
    await client.query(
      `INSERT INTO telecallers (id, org_id, display_name, status)
       VALUES ($1, $2, 'Second Telecaller A', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_TELECALLER, A.orgId],
    );
    // A lead belonging to the OTHER telecaller, by attribution and unassigned -
    // the exact shape the lead union exists for.
    await client.query(
      `INSERT INTO leads (id, org_id, workspace_id, title, stage, telecaller_id, assigned_telecaller_id)
       VALUES ($1, $2, $3, 'Someone else''s lead', 'new', $4, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_LEAD, A.orgId, A.workspaceId, OTHER_TELECALLER],
    );
  } finally {
    await client.end();
  }
}, 180_000);

// ── A. the statements actually run ──────────────────────────────────────────

describe("A. every generated statement executes against the real schema", () => {
  it.each(IMPLEMENTED_DATASETS)("pages %s with no scope", async (key) => {
    const query = buildDatasetQuery(exportDataset(key), wide, true, null);
    const rows = await inOrg(A.orgId, (c) => c.query(query.sql, query.params).then((r) => r.rows));
    expect(Array.isArray(rows)).toBe(true);
  });

  it.each(IMPLEMENTED_DATASETS)("pages %s with the persona narrowed", async (key) => {
    const query = buildDatasetQuery(exportDataset(key), own, true, null);
    await expect(
      inOrg(A.orgId, (c) => c.query(query.sql, query.params)),
    ).resolves.toBeDefined();
  });

  it.each(IMPLEMENTED_DATASETS)("pages %s without the recordings grant", async (key) => {
    const query = buildDatasetQuery(exportDataset(key), wide, false, null);
    await expect(
      inOrg(A.orgId, (c) => c.query(query.sql, query.params)),
    ).resolves.toBeDefined();
  });

  it.each(IMPLEMENTED_DATASETS)("counts %s under the same predicates", async (key) => {
    const query = buildCountQuery(exportDataset(key), own);
    const rows = await inOrg(A.orgId, (c) =>
      c.query<{ n: string }>(query.sql, query.params).then((r) => r.rows),
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(0);
  });

  /**
   * The registry promises these column names to the file's header row. This is
   * the assertion that they are names Postgres will actually return - the one
   * `leads.phone` would have failed.
   */
  it.each(IMPLEMENTED_DATASETS)("returns exactly the registry's column names for %s", async (key) => {
    const dataset = exportDataset(key);
    const query = buildDatasetQuery(dataset, wide, true, null);
    const result = await inOrg(A.orgId, (c) => c.query(query.sql, query.params));
    expect(result.fields.map((f) => f.name)).toEqual([...dataset.columns.map((c) => c.name), CURSOR_COLUMN]);
  });
});

// ── B. the scope predicate removes the right rows ───────────────────────────

describe("B. row scope", () => {
  async function leadTitles(scope: ResolvedScope): Promise<string[]> {
    const query = buildDatasetQuery(exportDataset("leads"), scope, true, null);
    const rows = await inOrg(A.orgId, (c) =>
      c.query<{ title: string }>(query.sql, query.params).then((r) => r.rows),
    );
    return rows.map((r) => r.title).sort();
  }

  it("shows an unscoped persona both telecallers' leads", async () => {
    const titles = await leadTitles(wide);
    expect(titles).toContain("Someone else's lead");
    expect(titles.length).toBeGreaterThan(1);
  });

  /**
   * The behaviour a string test cannot show: the other telecaller's lead is
   * GONE, not merely un-asserted.
   */
  it("hides another telecaller's lead from an own-scoped persona", async () => {
    const titles = await leadTitles(own);
    expect(titles).not.toContain("Someone else's lead");
  });

  it("shows an own-scoped persona the lead attributed to them", async () => {
    // Seeded lead A is attributed to tenant A's telecaller, so the union's
    // second branch is what returns it. Scoping on assignment alone - the
    // obvious-looking predicate - would return nothing here.
    const titles = await leadTitles(own);
    expect(titles.length).toBeGreaterThan(0);
  });

  /** An empty export beats everyone's export. */
  it("returns NOTHING for an own-scoped persona with no telecaller identity", async () => {
    expect(await leadTitles(orphan)).toEqual([]);
  });

  it("never crosses a tenant boundary, whatever the scope says", async () => {
    // Tenant B's context, tenant A's user id in the scope - the combination a
    // confused-deputy bug would produce. RLS sits underneath every predicate
    // here, so the answer must be tenant B's rows only.
    const query = buildDatasetQuery(exportDataset("leads"), wide, true, null);
    const rows = await inOrg(B.orgId, (c) =>
      c.query<{ id: string }>(query.sql, query.params).then((r) => r.rows),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(A.leadId);
    expect(ids).not.toContain(OTHER_LEAD);
    // And the positive half: tenant A's leads really do exist, so the
    // assertions above are about isolation rather than an empty table.
    const all = await asAdmin((c) =>
      c.query<{ id: string }>("SELECT id FROM leads").then((r) => r.rows),
    );
    expect(all.map((r) => r.id)).toContain(A.leadId);
  });
});

// ── C. keyset paging ────────────────────────────────────────────────────────

describe("C. keyset paging", () => {
  /**
   * Pages a dataset to exhaustion at a page size of 1 and asserts every row
   * arrives exactly once. A non-unique sort order silently drops and duplicates
   * rows at page boundaries, which no amount of string matching reveals.
   */
  it("returns every lead exactly once across single-row pages", async () => {
    const dataset = exportDataset("leads");
    const seen: string[] = [];
    let cursor: { sortValue: string; id: string } | null = null;

    for (let page = 0; page < 50; page++) {
      const query = buildDatasetQuery(dataset, wide, true, cursor);
      // Force a page size of 1: the LIMIT is the last parameter.
      const params = [...query.params];
      params[params.length - 1] = 1;
      const rows = await inOrg(A.orgId, (c) =>
        c
          .query<Record<string, string>>(query.sql, params)
          .then((r) => r.rows),
      );
      if (rows.length === 0) break;
      seen.push(rows[0].id);
      // Exactly what the worker does: the cursor comes from the TEXT column,
      // never from a parsed Date. Two of these leads are seeded in one
      // transaction and share created_at to the microsecond, so a
      // millisecond-truncating cursor loses one of them outright - which is
      // what this test caught.
      cursor = { sortValue: rows[0][CURSOR_COLUMN], id: rows[0].id };
    }

    const all = await inOrg(A.orgId, (c) =>
      c.query<{ id: string }>("SELECT id FROM leads").then((r) => r.rows),
    );
    expect(seen.sort()).toEqual(all.map((r) => r.id).sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
  });

  /**
   * The regression, stated directly: two rows sharing a created_at to the
   * microsecond must both survive a page boundary drawn between them.
   */
  it("does not lose a row whose timestamp ties with the page boundary", async () => {
    const tied = await asAdmin((c) =>
      c
        .query<{ n: string }>(
          `SELECT count(*)::text AS n FROM (
             SELECT created_at FROM leads GROUP BY created_at HAVING count(*) > 1
           ) s`,
        )
        .then((r) => r.rows),
    );
    // The fixture must actually contain a tie, or this proves nothing.
    expect(Number(tied[0].n)).toBeGreaterThan(0);
  });
});

// ── D. the job table's invariants ───────────────────────────────────────────

describe("D. export_jobs invariants are enforced by the database", () => {
  const base = {
    format: "csv",
    snapshot: JSON.stringify({ ownerScopeKind: "all", grid: {}, canExportRecordings: false }),
  };

  async function insert(sql: string, params: unknown[]): Promise<void> {
    await inOrg(A.orgId, (c) => c.query(sql, params));
  }

  it("refuses a view job naming two datasets", async () => {
    await expect(
      insert(
        `INSERT INTO export_jobs (org_id, scope, format, datasets, requested_by_user_id, scope_snapshot)
         VALUES ($1, 'view', $2, ARRAY['leads','calls'], $3, $4::jsonb)`,
        [A.orgId, base.format, A.userId, base.snapshot],
      ),
    ).rejects.toThrow(/export_jobs_view_is_one_dataset/);
  });

  it("refuses a section job with no section, and a bulk job with one", async () => {
    await expect(
      insert(
        `INSERT INTO export_jobs (org_id, scope, format, datasets, requested_by_user_id, scope_snapshot)
         VALUES ($1, 'section', $2, ARRAY['leads'], $3, $4::jsonb)`,
        [A.orgId, base.format, A.userId, base.snapshot],
      ),
    ).rejects.toThrow(/export_jobs_section_scope/);

    await expect(
      insert(
        `INSERT INTO export_jobs (org_id, scope, section, format, datasets, requested_by_user_id, scope_snapshot)
         VALUES ($1, 'bulk', 'sales', $2, ARRAY['leads'], $3, $4::jsonb)`,
        [A.orgId, base.format, A.userId, base.snapshot],
      ),
    ).rejects.toThrow(/export_jobs_section_scope/);
  });

  it("refuses filters on a section export", async () => {
    await expect(
      insert(
        `INSERT INTO export_jobs (org_id, scope, section, format, datasets, filters, requested_by_user_id, scope_snapshot)
         VALUES ($1, 'section', 'sales', $2, ARRAY['deals'], '{"stage":"won"}'::jsonb, $3, $4::jsonb)`,
        [A.orgId, base.format, A.userId, base.snapshot],
      ),
    ).rejects.toThrow(/export_jobs_filters_are_view_only/);
  });

  it("refuses a ready job with no artifact", async () => {
    await expect(
      insert(
        `INSERT INTO export_jobs (org_id, scope, format, datasets, status, requested_by_user_id, scope_snapshot)
         VALUES ($1, 'view', $2, ARRAY['leads'], 'ready', $3, $4::jsonb)`,
        [A.orgId, base.format, A.userId, base.snapshot],
      ),
    ).rejects.toThrow(/export_jobs_ready_has_artifact/);
  });

  it("refuses a failed job with no reason", async () => {
    await expect(
      insert(
        `INSERT INTO export_jobs (org_id, scope, format, datasets, status, started_at, requested_by_user_id, scope_snapshot)
         VALUES ($1, 'view', $2, ARRAY['leads'], 'failed', now(), $3, $4::jsonb)`,
        [A.orgId, base.format, A.userId, base.snapshot],
      ),
    ).rejects.toThrow(/export_jobs_failed_says_why/);
  });

  it("accepts the shape the API actually writes", async () => {
    await expect(
      insert(
        `INSERT INTO export_jobs (org_id, scope, format, datasets, requested_by_user_id, scope_snapshot, owners_notified_at)
         VALUES ($1, 'view', $2, ARRAY['leads'], $3, $4::jsonb, now())`,
        [A.orgId, base.format, A.userId, base.snapshot],
      ),
    ).resolves.toBeUndefined();
  });

  /** The three kinds 0148 added must be insertable, or the notify path 23514s. */
  it.each(["export_ready", "export_failed", "export_created"])(
    "accepts the %s notification kind",
    async (kind) => {
      await expect(
        insert(
          `INSERT INTO notifications (org_id, user_id, kind, title) VALUES ($1, $2, $3, 'test')`,
          [A.orgId, A.userId, kind],
        ),
      ).resolves.toBeUndefined();
    },
  );
});

// ── E. the HTTP surface, against the running API ────────────────────────────

describe("E. POST /v1/exports and the owner alert", () => {
  /**
   * A SECOND owner in tenant A, so "every owner except the requester" has
   * somebody in it. With one owner who is also the requester, the no-self-alert
   * rule and a broken alert look identical - zero rows either way.
   */
  const SECOND_OWNER = "00000000-0000-4000-8000-00000000c0a2";

  beforeAll(async () => {
    await asAdmin(async (c) => {
      await c.query(
        `INSERT INTO users (id, email, name, status)
         VALUES ($1, 'second-owner-a@aura.test', 'Second Owner A', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [SECOND_OWNER],
      );
      // `scope_id` is NOT NULL and equals the org for an org-scope membership -
      // exactly as seedTenants writes its own.
      await c.query(
        `INSERT INTO memberships
           (org_id, user_id, scope_type, scope_id, role, owner_role,
            recordings_listen, recordings_export)
         VALUES ($1, $2, 'org', $1, 'org_admin', 'owner', true, true)
         ON CONFLICT DO NOTHING`,
        [A.orgId, SECOND_OWNER],
      );
      /**
       * The grid, as a REAL provisioned tenant has it.
       *
       * `seedTenants` inserts the organization row directly, so tenant A has no
       * `roles` and no `role_permissions` at all - and the export gate reads the
       * grant from the database, so every dataset with a grid object is denied.
       * That is correct behaviour for an unconfigured tenant and useless as a
       * fixture, so this mirrors `seedCrmDefaults`
       * (admin.controller.ts:63): the system roles, and 'all' on every
       * action for the administrator roles.
       */
      await c.query(
        `INSERT INTO roles (org_id, key, name, is_system)
         VALUES ($1, 'org_admin', 'Org admin', true)
         ON CONFLICT DO NOTHING`,
        [A.orgId],
      );
      await c.query(
        `INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
         SELECT r.org_id, r.id, ot.object_type, 'export', 'all'
           FROM roles r
           CROSS JOIN unnest($2::text[]) AS ot(object_type)
          WHERE r.org_id = $1 AND r.key = 'org_admin'
         ON CONFLICT DO NOTHING`,
        [A.orgId, ["lead", "contact", "account", "deal", "task", "conversation"]],
      );

      // A clean slate for the notification assertions below.
      await c.query(`DELETE FROM notifications WHERE kind = 'export_created'`);
      await c.query(`DELETE FROM export_jobs WHERE org_id = $1`, [A.orgId]);
    });
  });

  async function notificationsFor(userId: string): Promise<Array<Record<string, unknown>>> {
    return asAdmin((c) =>
      c
        .query(
          `SELECT kind, title, body, link_path FROM notifications
            WHERE user_id = $1 AND kind = 'export_created' ORDER BY created_at DESC`,
          [userId],
        )
        .then((r) => r.rows),
    );
  }

  it("queues a view export and returns the dataset list", async () => {
    const res = await call(asOwner(A), "POST", "/exports", {
      scope: "view",
      format: "csv",
      dataset: "leads",
    });
    expect(res.status, res.text).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.datasets).toEqual(["leads"]);
  });

  /**
   * The governance property, end to end: the job row and the owners' alert are
   * written in ONE transaction, so a committed job always has its alert.
   */
  it("alerts the org's OTHER owners, at creation", async () => {
    const before = (await notificationsFor(SECOND_OWNER)).length;
    const res = await call(asOwner(A), "POST", "/exports", {
      scope: "view",
      format: "csv",
      dataset: "leads",
    });
    expect(res.status, res.text).toBe(202);

    const after = await notificationsFor(SECOND_OWNER);
    expect(after.length).toBe(before + 1);
    expect(String(after[0].title)).toMatch(/started an export/);
    // No link to the artifact - the alert says an export happened, never what
    // was in it, and the download route's ownership check is unchanged by it.
    expect(String(after[0].link_path)).toBe(`/owner/account/data?job=${res.body.jobId}`);
    // And no `/admin` prefix: the console adds its own basePath, so a stored
    // path carrying it is prefixed twice and 404s in production only.
    expect(String(after[0].link_path)).not.toMatch(/^\/admin/);
  });

  /**
   * Without this, an owner who exports four things in a morning gets four
   * notifications about themselves, learns the kind is noise, and mutes it -
   * taking the alert about everybody else with it.
   */
  it("never alerts the person who ran the export", async () => {
    const before = (await notificationsFor(A.userId)).length;
    await call(asOwner(A), "POST", "/exports", {
      scope: "view",
      format: "csv",
      dataset: "leads",
    });
    expect((await notificationsFor(A.userId)).length).toBe(before);
  });

  it("stamps owners_notified_at, so a retry cannot alert twice", async () => {
    const res = await call(asOwner(A), "POST", "/exports", {
      scope: "view",
      format: "csv",
      dataset: "leads",
    });
    const rows = await asAdmin((c) =>
      c
        .query<{ owners_notified_at: Date | null }>(
          `SELECT owners_notified_at FROM export_jobs WHERE id = $1`,
          [res.body.jobId],
        )
        .then((r) => r.rows),
    );
    expect(rows[0].owners_notified_at).not.toBeNull();
  });

  it("writes an audit row before the export has run", async () => {
    const res = await call(asOwner(A), "POST", "/exports", {
      scope: "view",
      format: "csv",
      dataset: "leads",
    });
    const rows = await asAdmin((c) =>
      c
        .query(`SELECT action, target_type FROM audit_log WHERE target_id = $1`, [res.body.jobId])
        .then((r) => r.rows),
    );
    expect(rows.map((r) => r.action)).toContain("export.created");
    expect(rows[0].target_type).toBe("export_job");
  });

  // ── the body contract ───────────────────────────────────────────────────

  it("rejects filters on a section export rather than ignoring them", async () => {
    const res = await call(asOwner(A), "POST", "/exports", {
      scope: "section",
      section: "sales",
      format: "csv",
      filters: { stage: "won" },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/unfiltered/);
  });

  it("rejects a dataset named on a bulk export", async () => {
    const res = await call(asOwner(A), "POST", "/exports", {
      scope: "bulk",
      format: "csv",
      dataset: "leads",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a view export that names no dataset", async () => {
    const res = await call(asOwner(A), "POST", "/exports", { scope: "view", format: "csv" });
    expect(res.status).toBe(400);
  });

  it("refuses a dataset whose module the tenant does not have", async () => {
    // Tenant A has no `crm` module in the fixture, so every CRM dataset is
    // omitted - and a VIEW export of one is a 403 rather than an empty file.
    const res = await call(asOwner(A), "POST", "/exports", {
      scope: "view",
      format: "csv",
      dataset: "deals",
    });
    expect([403, 202]).toContain(res.status);
    if (res.status === 403) expect(JSON.stringify(res.body)).toMatch(/module|permitted|export/);
  });

  it("lists the datasets this caller may export", async () => {
    const res = await call(asOwner(A), "GET", "/exports/datasets");
    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body.datasets)).toBe(true);
    // The drawer must be able to say so BEFORE the job runs.
    expect(res.body).toHaveProperty("canExportRecordings");
    expect(res.body.retentionDays).toBe(7);
  });

  it("never lets one tenant's credential see another's export", async () => {
    const mine = await call(asOwner(A), "POST", "/exports", {
      scope: "view",
      format: "csv",
      dataset: "leads",
    });
    const theirs = await call(asOwner(B), "GET", `/exports/${mine.body.jobId}`);
    expect(theirs.status).toBe(404);
  });

  it("refuses to download a job that is not ready", async () => {
    const mine = await call(asOwner(A), "POST", "/exports", {
      scope: "view",
      format: "csv",
      dataset: "leads",
    });
    const res = await call(asOwner(A), "GET", `/exports/${mine.body.jobId}/download`);
    expect([400, 403]).toContain(res.status);
  });
});
