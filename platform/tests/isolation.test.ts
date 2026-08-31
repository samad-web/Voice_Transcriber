/**
 * THE CROSS-TENANT ISOLATION LOOP.
 *
 * `Build docs/13_ROUTE_AND_GUARD_INVENTORY.md` §1.1 enumerates 57 tenant-scoped
 * routes. `ROUTES` below is that table turned into a data structure: one entry
 * per row, carrying the row's number so the two can be diffed, and the pool it
 * queries so the routes with NO database backstop are visible at a glance.
 *
 * ── WHY EVERY ENTRY HAS BOTH DIRECTIONS ─────────────────────────────────────
 *
 * A loop that only asserts "tenant A gets 404 for tenant B's id" is trivially
 * satisfied by an API that 404s everything - a broken route, a typo'd path, a
 * guard that rejects the fixture's own credential, or a seed that never ran all
 * produce a green suite. So `positive` is mandatory wherever `negative` exists,
 * and the runner refuses to accept an entry that has one without the other.
 * `positive` is the control: it proves the same request shape, the same
 * credential and the same fixture DO work when they are aimed at their own
 * tenant, which is what makes the 404 mean "scoped" rather than "broken".
 *
 * ── WHY THE DENIAL STATUS IS ASSERTED PER ROUTE ─────────────────────────────
 *
 * "Not found" is not one behaviour on this platform, and pretending it is would
 * hide the interesting cases. Three distinct shapes occur, each asserted by name:
 *
 *   404  the common case - the handler checked and threw NotFoundException.
 *   400  `POST /v1/devices/:id/logout` and `/wipe` throw BadRequestException,
 *        not NotFoundException (devices.controller.ts:282). A test written to
 *        expect 404 there fails against correct code.
 *   2xx + an EMPTY RESULT - `GET /v1/calls/:id/notes` (empty array),
 *        `GET /v1/crm/integrations/:id/deliveries` (empty array) and
 *        `POST /v1/crm/integrations/:id/retry-dead` (`{requeued: 0}`) answer
 *        success with nothing in them. Those three never look up the parent row
 *        at all: RLS is the only thing standing between them and another
 *        tenant's data, so the `witness` check (below) is the assertion that
 *        matters, not the status.
 *
 * ── 200 IS NOT THE SUCCESS CODE ─────────────────────────────────────────────
 *
 * Nest answers 201 from a `@Post` handler unless the handler carries an explicit
 * `@HttpCode` - and `grep -rn HttpCode apps/api/src` finds none. So every POST
 * in this table succeeds with **201**, and a case that asserts a literal 200 on
 * a POST is asserting a status the API has never returned. `expectOk` (2xx) is
 * the right assertion almost everywhere; where an exact code is asserted on a
 * POST it must be 201.
 *
 * ── THE WITNESS ─────────────────────────────────────────────────────────────
 *
 * A denial that answers 404 *after* performing the write is still a breach. Every
 * mutating entry carries a `witness`: a SELECT over tenant B's row, snapshotted
 * before the negative request and compared byte-for-byte after it. This is what
 * catches an UPDATE/DELETE that reached the row and then reported nothing back.
 *
 * Requires `pnpm test:integration:up` and a built workspace (`pnpm -r build`).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./setup/migrate.js";
import {
  CONTACT_A,
  CONTACT_B,
  SHARED_USER,
  TENANT_A as A,
  TENANT_B as B,
  type Tenant,
  queryRows,
  seedTenants,
} from "./setup/tenants.js";
import {
  type ApiResponse,
  type Caller,
  asSession,
  asSessionClaiming,
  asTenant,
  call,
  messageOf,
} from "./setup/http.js";

// ---------------------------------------------------------------------------
// Request + assertion helpers
// ---------------------------------------------------------------------------

/** A v4-shaped uuid that names no organization - doc 13 §2.1 case A3. */
const GHOST_ORG = "00000000-0000-4000-8000-00000000dead";

/** The literal from tests/setup/env.ts, read back off a caller so the two
 *  cannot drift. */
const adminKey = (): string => asTenant(A).headers["x-admin-key"];

const get = (t: Tenant, path: string) => call(asTenant(t), "GET", path);
const post = (t: Tenant, path: string, body?: unknown) => call(asTenant(t), "POST", path, body);
const patch = (t: Tenant, path: string, body?: unknown) => call(asTenant(t), "PATCH", path, body);
const del = (t: Tenant, path: string) => call(asTenant(t), "DELETE", path);

function expectStatus(res: ApiResponse, status: number, why: string): void {
  expect(res.status, `${why} - expected ${status}, got ${res.status}: ${res.text}`).toBe(status);
}

function expectDenied(res: ApiResponse, status: number, message: RegExp): void {
  expectStatus(res, status, "denial");
  expect(messageOf(res), `denial message for status ${status}`).toMatch(message);
}

function expectOk(res: ApiResponse): void {
  expect(
    res.status,
    `expected the tenant's OWN resource to be reachable, got ${res.status}: ${res.text}`,
  ).toBeGreaterThanOrEqual(200);
  expect(res.status, `got ${res.status}: ${res.text}`).toBeLessThan(300);
}

/** Serialised so a jsonb/date column compares stably across two reads. */
type Witness = { sql: string; params: unknown[] };

// ---------------------------------------------------------------------------
// The route table - doc 13 §1.1, tenant-scoped rows only
// ---------------------------------------------------------------------------

interface RouteCase {
  /** Row number in doc 13 §1.1. Kept so the two tables can be diffed. */
  n: number;
  route: string;
  /**
   * Which pool the handler queries. `adminPool` means RLS is BYPASSED and the
   * application check is the ONLY thing scoping the route - doc 13 §1.3.
   */
  pool: "withOrg" | "adminPool" | "withOrg+adminPool" | "none";
  /** Set instead of negative/positive when the route cannot be looped. */
  excluded?: string;
  /** Tenant B rows that must be unchanged after `negative` has run. */
  witness?: Witness;
  /** Tenant A's credential aimed at tenant B. Asserts the denial itself. */
  negative?: () => Promise<void>;
  /** Tenant A's credential aimed at tenant A. The control. */
  positive?: () => Promise<void>;
}

const bMembership: Witness = {
  sql: `SELECT role, recordings_listen, recordings_export
          FROM memberships WHERE org_id = $1 AND user_id = $2`,
  params: [B.orgId, SHARED_USER.id],
};
const bCall: Witness = {
  sql: `SELECT status, pipeline_attempts, next_attempt_at FROM calls WHERE id = $1`,
  params: [B.callId],
};
const bDevice: Witness = {
  sql: `SELECT status, telecaller_name FROM devices WHERE id = $1`,
  params: [B.deviceId],
};
const bIntegration: Witness = {
  sql: `SELECT label, endpoint, status, max_attempts FROM crm_integrations WHERE id = $1`,
  params: [B.crmIntegrationId],
};
const bSyncRow: Witness = {
  sql: `SELECT status, attempts, error FROM crm_sync_log WHERE id = $1`,
  params: [B.crmSyncId],
};
const bLead: Witness = {
  sql: `SELECT title, stage, status, value_num FROM leads WHERE id = $1`,
  params: [B.leadId],
};
const bOrg: Witness = {
  sql: `SELECT name, consent_policy, retention_days, store_full_number, transcription_enabled
          FROM organizations WHERE id = $1`,
  params: [B.orgId],
};
const bInstance: Witness = {
  sql: `SELECT (SELECT count(*)::int FROM instances WHERE id = $1) AS instances,
               (SELECT count(*)::int FROM enrollment_tokens WHERE instance_id = $1) AS keys,
               (SELECT count(*)::int FROM devices WHERE instance_id = $1) AS devices`,
  params: [B.instanceId],
};
const bApiKey: Witness = {
  sql: `SELECT count(*)::int AS n FROM api_keys WHERE id = $1`,
  params: [B.apiKeyId],
};
const bAgent: Witness = {
  sql: `SELECT version, is_active FROM agents WHERE id = $1 ORDER BY version`,
  params: [B.agentId],
};
const bNotes: Witness = {
  sql: `SELECT count(*)::int AS n FROM call_notes WHERE call_id = $1`,
  params: [B.callId],
};
const bOwnerMembership: Witness = {
  sql: `SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND user_id = $2`,
  params: [B.orgId, B.userId],
};

const ROUTES: RouteCase[] = [
  // ── auth / api keys ──────────────────────────────────────────────────────
  {
    n: 6,
    route: "POST /v1/apikeys",
    pool: "withOrg",
    negative: async () => {
      // No id in the path: the isolation claim is that what A creates lands in
      // A and is invisible to B. `api_keys` is one of the routes doc 13 §1.4
      // names as having zero defence in depth - the INSERT names org_id, but
      // nothing re-checks it on read.
      const created = await post(A, "/apikeys", { name: "made-by-a" });
      expectOk(created);
      const seenByB = await get(B, "/apikeys");
      expectOk(seenByB);
      expect(seenByB.body.keys.map((k: any) => k.id)).not.toContain(created.body.id);
    },
    positive: async () => {
      const created = await post(A, "/apikeys", { name: "made-by-a" });
      expectOk(created);
      expect(created.body.key).toMatch(/^cik_live_/);
      const seenByA = await get(A, "/apikeys");
      expect(seenByA.body.keys.map((k: any) => k.id)).toContain(created.body.id);
    },
  },
  {
    n: 7,
    route: "GET /v1/apikeys",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/apikeys");
      expectOk(res);
      expect(res.body.keys.map((k: any) => k.id)).not.toContain(B.apiKeyId);
    },
    positive: async () => {
      const res = await get(A, "/apikeys");
      expect(res.body.keys.map((k: any) => k.id)).toContain(A.apiKeyId);
    },
  },
  {
    n: 8,
    route: "DELETE /v1/apikeys/:id",
    pool: "withOrg",
    witness: bApiKey,
    negative: async () => {
      expectDenied(await del(A, `/apikeys/${B.apiKeyId}`), 404, /api key not found/);
    },
    positive: async () => {
      expectOk(await del(A, `/apikeys/${A.apiKeyId}`));
      expect(await queryRows(bApiKey.sql, [A.apiKeyId])).toEqual([{ n: 0 }]);
    },
  },

  // ── agents ───────────────────────────────────────────────────────────────
  {
    n: 12,
    route: "POST /v1/agents",
    pool: "withOrg",
    witness: { sql: `SELECT count(*)::int AS n FROM agents WHERE org_id = $1`, params: [B.orgId] },
    negative: async () => {
      // The workspace id is the tenant-owned reference here, and the handler
      // checks it under RLS before the INSERT (agents.controller.ts:49-50).
      expectDenied(
        await post(A, "/agents", {
          workspaceId: B.workspaceId,
          name: "stolen",
          systemPrompt: "x",
          fieldSchema: { fields: [] },
        }),
        404,
        /workspace not found in this org/,
      );
    },
    positive: async () => {
      expectOk(
        await post(A, "/agents", {
          workspaceId: A.workspaceId,
          name: "mine",
          systemPrompt: "x",
          fieldSchema: { fields: [] },
        }),
      );
    },
  },
  {
    n: 13,
    route: "POST /v1/agents/:id/versions",
    pool: "withOrg",
    witness: bAgent,
    negative: async () => {
      expectDenied(
        await post(A, `/agents/${B.agentId}/versions`, {
          systemPrompt: "x",
          fieldSchema: { fields: [] },
        }),
        404,
        /agent not found/,
      );
    },
    positive: async () => {
      const res = await post(A, `/agents/${A.agentId}/versions`, {
        systemPrompt: "v2",
        fieldSchema: { fields: [] },
      });
      expectOk(res);
      expect(res.body.version).toBe(2);
    },
  },
  {
    n: 14,
    route: "POST /v1/agents/:id/activate",
    pool: "withOrg",
    witness: bAgent,
    negative: async () => {
      expectDenied(
        await post(A, `/agents/${B.agentId}/activate`, { version: 1 }),
        404,
        /agent version not found/,
      );
    },
    positive: async () => {
      const res = await post(A, `/agents/${A.agentId}/activate`, { version: 1 });
      expectOk(res);
      expect(res.body.is_active).toBe(true);
    },
  },
  {
    n: 15,
    route: "GET /v1/agents",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/agents");
      expectOk(res);
      expect(res.body.agents.map((a: any) => a.id)).not.toContain(B.agentId);
    },
    positive: async () => {
      expect((await get(A, "/agents")).body.agents.map((a: any) => a.id)).toContain(A.agentId);
    },
  },
  {
    n: 16,
    route: "POST /v1/agents/:id/test",
    pool: "withOrg",
    negative: async () => {
      // Two independent references in one handler, so both are aimed at B.
      expectDenied(
        await post(A, `/agents/${B.agentId}/test`, { callId: A.callId }),
        404,
        /agent not found/,
      );
      expectDenied(
        await post(A, `/agents/${A.agentId}/test`, { callId: B.callId }),
        404,
        /no transcript for that call/,
      );
    },
    positive: async () => {
      // ANALYZE_STUB=1 (childEnv) makes this deterministic and offline -
      // `analyzeTranscript` short-circuits at packages/llm/src/index.ts:199.
      expectOk(await post(A, `/agents/${A.agentId}/test`, { callId: A.callId }));
    },
  },

  // ── analytics / search / billing ─────────────────────────────────────────
  {
    n: 17,
    route: "GET /v1/analytics/overview",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/analytics/overview");
      expectOk(res);
      // Both tenants hold exactly one call and one device. A total of 2 would
      // be the aggregate leaking across the boundary - the failure mode a
      // per-row id check cannot see.
      expect(res.body.calls.total).toBe(1);
      expect(res.body.devices.total).toBe(1);
    },
    positive: async () => {
      const res = await get(A, "/analytics/overview");
      expect(res.body.calls.complete).toBe(1);
    },
  },
  {
    n: 19,
    route: "GET /v1/search",
    pool: "withOrg",
    negative: async () => {
      // A term that exists ONLY in tenant B's transcript. Searching for a word
      // absent from both corpora would return [] for the wrong reason.
      const res = await get(A, `/search?q=${B.marker}`);
      expectOk(res);
      expect(res.body.results).toEqual([]);
    },
    positive: async () => {
      const res = await get(A, `/search?q=${A.marker}`);
      expectOk(res);
      expect(res.body.results.map((r: any) => r.callId)).toEqual([A.callId]);
    },
  },
  {
    n: 20,
    route: "GET /v1/usage",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/usage");
      expectOk(res);
      expect(res.body.metrics.devices).toBe(1);
      expect(res.body.metrics.apiKeys).toBe(1);
    },
    positive: async () => {
      expect((await get(A, "/usage")).body.metrics.calls).toBe(1);
    },
  },
  {
    n: 21,
    route: "GET /v1/billing/invoices",
    pool: "none",
    // doc 13 §1.5: passes TenantGuard but never touches a tenant table - it
    // returns the literal `{invoices: []}` (billing.controller.ts:65). Looping
    // it would assert "A's response differs from B's" against two identical
    // constants and fail for a reason that has nothing to do with tenancy.
    excluded:
      "returns a constant `{invoices: []}` - no tenant data exists for A and B to differ on",
  },

  // ── calls ────────────────────────────────────────────────────────────────
  {
    n: 24,
    route: "GET /v1/calls",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/calls");
      expectOk(res);
      expect(res.body.calls.map((c: any) => c.id)).not.toContain(B.callId);
      // `total` is a separate COUNT query with the same predicate - a scoping
      // bug in one and not the other is exactly what "showing 1 of 2" looks like.
      expect(res.body.total).toBe(1);
    },
    positive: async () => {
      const res = await get(A, "/calls");
      expect(res.body.calls.map((c: any) => c.id)).toEqual([A.callId]);
    },
  },
  {
    n: 25,
    route: "GET /v1/calls/:id",
    pool: "withOrg",
    // Named in the brief: apps/web's calls/actions.ts was a load-bearing tenant
    // bug here once already.
    negative: async () => {
      expectDenied(await get(A, `/calls/${B.callId}`), 404, /call not found/);
    },
    positive: async () => {
      const res = await get(A, `/calls/${A.callId}`);
      expectOk(res);
      expect(res.body.call.id).toBe(A.callId);
      // The drawer's three child reads are scoped by the same context; if any
      // of them were not, A's drawer would show B's transcript.
      expect(res.body.transcript.text).toContain(A.marker);
      expect(res.body.aiOutput).not.toBeNull();
    },
  },
  {
    n: 26,
    route: "GET /v1/calls/:id/audio",
    pool: "withOrg",
    negative: async () => {
      expectDenied(await get(A, `/calls/${B.callId}/audio`), 404, /no recording for this call/);
    },
    positive: async () => {
      const res = await get(A, `/calls/${A.callId}/audio`);
      expectOk(res);
      // The presigned URL must name A's own key - a leak here hands out a URL
      // that works, which no status code would reveal.
      expect(res.body.url).toContain(`org/${A.orgId}/calls/${A.callId}.m4a`);
      expect(res.body.url).not.toContain(B.orgId);
    },
  },
  {
    n: 27,
    route: "POST /v1/calls/:id/reprocess",
    pool: "withOrg",
    witness: bCall,
    negative: async () => {
      expectDenied(await post(A, `/calls/${B.callId}/reprocess`), 404, /call not found/);
    },
    positive: async () => {
      const res = await post(A, `/calls/${A.callId}/reprocess`);
      expectOk(res);
      expect(res.body.status).toBe("UPLOADED");
    },
  },
  {
    n: 28,
    route: "POST /v1/calls/reprocess-backlog",
    pool: "withOrg",
    witness: bCall,
    negative: async () => {
      // No id in the path - the tenant scope is entirely implicit, which is
      // what makes a bulk UPDATE the worst place for it to be wrong. One
      // request would rewind BOTH tenants' backlogs if it were.
      const res = await post(A, "/calls/reprocess-backlog", { statuses: ["COMPLETE"] });
      expectOk(res);
      expect(res.body.requeued).toBe(1);
    },
    positive: async () => {
      // Asserted, not ignored: the rewind and the audit row share one
      // transaction (calls.controller.ts:521), so when that INSERT bound orgId
      // to a uuid column and a text column through ONE placeholder, Postgres
      // aborted the statement, the rewind rolled back with it, and the endpoint
      // answered 500. Reading only the call status afterwards reported "did not
      // move" and hid the 500 that caused it.
      expectOk(await post(A, "/calls/reprocess-backlog", { statuses: ["COMPLETE"] }));
      // The rewind is SYNCHRONOUS - the DB flip is the source of truth and the
      // queue is only a wake-up (calls.controller.ts:528), exactly as the
      // single-call path works, and global.ts does not even start the worker.
      // So this is a straight read, not a poll.
      expect(await queryRows(`SELECT status FROM calls WHERE id = $1`, [A.callId])).toEqual([
        { status: "UPLOADED" },
      ]);
      // The statement that used to throw, pinned directly.
      expect(
        await queryRows(
          // Two bindings of the same value on purpose: org_id is uuid and
          // target_id is text, and one placeholder for both is the very bug
          // this case exists to catch.
          `SELECT count(*)::int AS n FROM audit_log
            WHERE org_id = $1 AND action = 'call.reprocess_backlog' AND target_id = $2`,
          [A.orgId, A.orgId],
        ),
      ).toEqual([{ n: 1 }]);
    },
  },
  {
    n: 29,
    route: "GET /v1/calls/:id/notes",
    pool: "withOrg",
    negative: async () => {
      // EMPTY RESULT, not 404. notes.controller.ts:34 selects straight from
      // call_notes without ever looking up the parent call, so RLS on
      // call_notes is the only thing scoping it - there is no application
      // check here to fall back on.
      const res = await get(A, `/calls/${B.callId}/notes`);
      expectStatus(res, 200, "foreign call's notes");
      expect(res.body.notes).toEqual([]);
    },
    positive: async () => {
      const res = await get(A, `/calls/${A.callId}/notes`);
      expectOk(res);
      expect(res.body.notes.map((n: any) => n.id)).toEqual([A.noteId]);
    },
  },
  {
    n: 30,
    route: "POST /v1/calls/:id/notes",
    pool: "withOrg",
    witness: bNotes,
    negative: async () => {
      expectDenied(
        await post(A, `/calls/${B.callId}/notes`, { body: "written by A" }),
        404,
        /call not found/,
      );
    },
    positive: async () => {
      expectOk(await post(A, `/calls/${A.callId}/notes`, { body: "written by A" }));
    },
  },

  // ── crm ──────────────────────────────────────────────────────────────────
  {
    n: 31,
    route: "GET /v1/crm/providers",
    pool: "none",
    // doc 13 §1.5. The catalogue is a static export from @aura/shared
    // (crm.controller.ts:135); identical for every tenant by construction.
    excluded: "serves the static @aura/shared catalogue - identical for every tenant",
  },
  {
    n: 32,
    route: "POST /v1/crm/integrations",
    pool: "withOrg",
    witness: {
      sql: `SELECT count(*)::int AS n FROM crm_integrations WHERE org_id = $1`,
      params: [B.orgId],
    },
    negative: async () => {
      expectDenied(
        await post(A, "/crm/integrations", {
          workspaceId: B.workspaceId,
          provider: "generic_webhook",
          config: { hookUrl: "http://127.0.0.1:1/stolen" },
        }),
        404,
        /workspace not found in this org/,
      );
    },
    positive: async () => {
      expectOk(
        await post(A, "/crm/integrations", {
          workspaceId: A.workspaceId,
          provider: "generic_webhook",
          config: { hookUrl: "http://127.0.0.1:1/mine" },
        }),
      );
    },
  },
  {
    n: 33,
    route: "POST /v1/crm/integrations/custom",
    pool: "withOrg",
    witness: {
      sql: `SELECT count(*)::int AS n FROM crm_integrations WHERE org_id = $1`,
      params: [B.orgId],
    },
    negative: async () => {
      expectDenied(
        await post(A, "/crm/integrations/custom", {
          workspaceId: B.workspaceId,
          webhookUrl: "http://127.0.0.1:1/stolen",
        }),
        404,
        /workspace not found in this org/,
      );
    },
    positive: async () => {
      expectOk(
        await post(A, "/crm/integrations/custom", {
          workspaceId: A.workspaceId,
          webhookUrl: "http://127.0.0.1:1/mine",
        }),
      );
    },
  },
  {
    n: 34,
    route: "GET /v1/crm/integrations",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/crm/integrations");
      expectOk(res);
      expect(res.body.integrations.map((i: any) => i.id)).not.toContain(B.crmIntegrationId);
      // The three per-row counters are correlated subqueries over crm_sync_log
      // with no org predicate of their own - if RLS were off they would count
      // both tenants' deliveries into A's row.
      expect(res.body.integrations[0].dead).toBe(1);
    },
    positive: async () => {
      const res = await get(A, "/crm/integrations");
      expect(res.body.integrations.map((i: any) => i.id)).toEqual([A.crmIntegrationId]);
    },
  },
  {
    n: 35,
    route: "PATCH /v1/crm/integrations/:id",
    pool: "withOrg",
    witness: bIntegration,
    negative: async () => {
      expectDenied(
        await patch(A, `/crm/integrations/${B.crmIntegrationId}`, { label: "renamed by A" }),
        404,
        /crm integration not found in this org/,
      );
    },
    positive: async () => {
      const res = await patch(A, `/crm/integrations/${A.crmIntegrationId}`, {
        label: "renamed by A",
      });
      expectOk(res);
      expect(res.body.label).toBe("renamed by A");
    },
  },
  {
    n: 36,
    route: "DELETE /v1/crm/integrations/:id",
    pool: "withOrg",
    witness: bIntegration,
    negative: async () => {
      expectDenied(
        await del(A, `/crm/integrations/${B.crmIntegrationId}`),
        404,
        /crm integration not found in this org/,
      );
    },
    positive: async () => {
      expectOk(await del(A, `/crm/integrations/${A.crmIntegrationId}`));
    },
  },
  {
    n: 37,
    route: "POST /v1/crm/integrations/:id/test",
    pool: "withOrg",
    negative: async () => {
      expectDenied(
        await post(A, `/crm/integrations/${B.crmIntegrationId}/test`, { dryRun: true }),
        404,
        /crm integration not found in this org/,
      );
    },
    positive: async () => {
      // dryRun so nothing is dialled: crm-test.service.ts:208 returns before
      // the fetch. The fixture endpoint is unroutable precisely so a regression
      // out of the dry-run branch fails instantly instead of hanging 20s.
      const res = await post(A, `/crm/integrations/${A.crmIntegrationId}/test`, { dryRun: true });
      expectOk(res);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.sampleCallId).toBe(A.callId);
    },
  },
  {
    n: 38,
    route: "GET /v1/crm/integrations/:id/deliveries",
    pool: "withOrg",
    negative: async () => {
      // EMPTY RESULT, not 404: crm.controller.ts:435 filters on integration_id
      // alone and never verifies the integration belongs to this org. RLS on
      // crm_sync_log is the entire control.
      const res = await get(A, `/crm/integrations/${B.crmIntegrationId}/deliveries`);
      expectStatus(res, 200, "foreign integration's deliveries");
      expect(res.body.deliveries).toEqual([]);
    },
    positive: async () => {
      const res = await get(A, `/crm/integrations/${A.crmIntegrationId}/deliveries`);
      expectOk(res);
      expect(res.body.deliveries.map((d: any) => d.id)).toEqual([A.crmSyncId]);
    },
  },
  {
    n: 39,
    route: "POST /v1/crm/deliveries/:id/retry",
    pool: "withOrg",
    witness: bSyncRow,
    negative: async () => {
      expectDenied(
        await post(A, `/crm/deliveries/${B.crmSyncId}/retry`),
        404,
        /delivery not found in this org/,
      );
    },
    positive: async () => {
      const res = await post(A, `/crm/deliveries/${A.crmSyncId}/retry`);
      expectOk(res);
      expect(res.body.delivery.status).toBe("pending");
    },
  },
  {
    n: 40,
    route: "POST /v1/crm/integrations/:id/retry-dead",
    pool: "withOrg",
    witness: bSyncRow,
    negative: async () => {
      // EMPTY RESULT, not 404 - a bulk UPDATE keyed on integration_id with no
      // org check (crm.controller.ts:489). The status says nothing; the witness
      // is the assertion.
      //
      // 201, not 200: `retryDead` is a bare `@Post` with no `@HttpCode`
      // (crm.controller.ts:482), so Nest's POST default applies. The 200 that
      // stood here asserted a code this route has never returned.
      const res = await post(A, `/crm/integrations/${B.crmIntegrationId}/retry-dead`);
      expectStatus(res, 201, "retry-dead on a foreign integration");
      expect(res.body.requeued).toBe(0);
    },
    positive: async () => {
      const res = await post(A, `/crm/integrations/${A.crmIntegrationId}/retry-dead`);
      expectOk(res);
      expect(res.body.requeued).toBe(1);
    },
  },

  // ── devices ──────────────────────────────────────────────────────────────
  {
    n: 45,
    route: "POST /v1/devices/:id/logout",
    pool: "withOrg",
    witness: bDevice,
    negative: async () => {
      // 400, NOT 404 - devices.controller.ts:282 throws BadRequestException.
      expectDenied(await post(A, `/devices/${B.deviceId}/logout`), 400, /device not found in this org/);
    },
    positive: async () => {
      const res = await post(A, `/devices/${A.deviceId}/logout`);
      expectOk(res);
      expect(res.body.status).toBe("logged_out");
    },
  },
  {
    n: 46,
    route: "POST /v1/devices/:id/wipe",
    pool: "withOrg",
    witness: bDevice,
    negative: async () => {
      expectDenied(await post(A, `/devices/${B.deviceId}/wipe`), 400, /device not found in this org/);
    },
    positive: async () => {
      const res = await post(A, `/devices/${A.deviceId}/wipe`);
      expectOk(res);
      expect(res.body.status).toBe("wiped");
    },
  },
  {
    n: 47,
    route: "GET /v1/devices",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/devices");
      expectOk(res);
      expect(res.body.devices.map((d: any) => d.id)).not.toContain(B.deviceId);
    },
    positive: async () => {
      expect((await get(A, "/devices")).body.devices.map((d: any) => d.id)).toEqual([A.deviceId]);
    },
  },

  // ── instances ────────────────────────────────────────────────────────────
  {
    n: 51,
    route: "POST /v1/instances",
    pool: "withOrg",
    witness: bInstance,
    negative: async () => {
      expectDenied(
        await post(A, "/instances", { workspaceId: B.workspaceId, name: "stolen" }),
        404,
        /workspace not found in this org/,
      );
    },
    positive: async () => {
      const res = await post(A, "/instances", { workspaceId: A.workspaceId, name: "mine" });
      expectOk(res);
      expect(res.body.enrollment.adminKey).toBeTruthy();
    },
  },
  {
    n: 52,
    route: "GET /v1/instances",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/instances");
      expectOk(res);
      expect(res.body.instances.map((i: any) => i.id)).not.toContain(B.instanceId);
    },
    positive: async () => {
      expect((await get(A, "/instances")).body.instances.map((i: any) => i.id)).toEqual([
        A.instanceId,
      ]);
    },
  },
  {
    n: 53,
    route: "GET /v1/instances/:id",
    pool: "withOrg",
    negative: async () => {
      expectDenied(await get(A, `/instances/${B.instanceId}`), 404, /instance not found in this org/);
    },
    positive: async () => {
      const res = await get(A, `/instances/${A.instanceId}`);
      expectOk(res);
      expect(res.body.instance.id).toBe(A.instanceId);
      // The detail page's two child lists are separate queries keyed on
      // instance_id with no org predicate - both must be scoped by RLS.
      expect(res.body.devices.map((d: any) => d.id)).toEqual([A.deviceId]);
    },
  },
  {
    n: 54,
    route: "DELETE /v1/instances/:id",
    pool: "withOrg",
    witness: bInstance,
    negative: async () => {
      // ?purgeCalls=true is the destructive form. Aiming the destructive form
      // at B is the assertion that matters: the safe form would be refused by
      // the call-count guard rather than by tenancy.
      expectDenied(
        await del(A, `/instances/${B.instanceId}?purgeCalls=true`),
        404,
        /instance not found in this org/,
      );
    },
    positive: async () => {
      // A's instance has one call, so the plain DELETE is a 409 by design
      // (instances.controller.ts:199) - that refusal already proves the row was
      // found in A's org, and purgeCalls=true then completes it.
      expectStatus(await del(A, `/instances/${A.instanceId}`), 409, "instance still has calls");
      expectOk(await del(A, `/instances/${A.instanceId}?purgeCalls=true`));
    },
  },
  {
    n: 55,
    route: "POST /v1/instances/:id/keys",
    pool: "withOrg",
    witness: bInstance,
    negative: async () => {
      expectDenied(
        await post(A, `/instances/${B.instanceId}/keys`, {}),
        404,
        /instance not found in this org/,
      );
    },
    positive: async () => {
      const res = await post(A, `/instances/${A.instanceId}/keys`, {});
      expectOk(res);
      expect(res.body.adminKey).toBeTruthy();
    },
  },

  // ── leads ────────────────────────────────────────────────────────────────
  {
    n: 56,
    route: "GET /v1/leads",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/leads");
      expectOk(res);
      expect(res.body.leads.map((l: any) => l.id)).not.toContain(B.leadId);
      expect(res.body.total).toBe(1);
    },
    positive: async () => {
      expect((await get(A, "/leads")).body.leads.map((l: any) => l.id)).toEqual([A.leadId]);
    },
  },
  {
    n: 57,
    route: "GET /v1/leads/board",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/leads/board");
      expectOk(res);
      const all = res.body.columns.flatMap((c: any) => c.leads.map((l: any) => l.id));
      expect(all).not.toContain(B.leadId);
      // The counters are window functions over the same scan; a leak shows up
      // as a column count of 2 even when the visible cards look right.
      const newColumn = res.body.columns.find((c: any) => c.key === "new");
      expect(newColumn.count).toBe(1);
    },
    positive: async () => {
      const res = await get(A, "/leads/board");
      const all = res.body.columns.flatMap((c: any) => c.leads.map((l: any) => l.id));
      expect(all).toEqual([A.leadId]);
    },
  },
  {
    n: 58,
    route: "GET /v1/leads/:id",
    pool: "withOrg",
    negative: async () => {
      expectDenied(await get(A, `/leads/${B.leadId}`), 404, /lead not found/);
    },
    positive: async () => {
      const res = await get(A, `/leads/${A.leadId}`);
      expectOk(res);
      expect(res.body.lead.id).toBe(A.leadId);
      // The call history is matched on the contact hash with no org predicate
      // (leads.controller.ts:207) - B's calls must not appear even though B's
      // contact hash is a different number entirely.
      expect(res.body.calls.map((c: any) => c.id)).toEqual([A.callId]);
    },
  },
  {
    n: 59,
    route: "PATCH /v1/leads/:id",
    pool: "withOrg",
    witness: bLead,
    negative: async () => {
      expectDenied(
        await patch(A, `/leads/${B.leadId}`, { stage: "qualified" }),
        404,
        /lead not found/,
      );
    },
    positive: async () => {
      const res = await patch(A, `/leads/${A.leadId}`, { stage: "won" });
      expectOk(res);
      expect(res.body.lead.stage).toBe("won");
      // statusForStage derives it from the tenant's own lead_stages.
      expect(res.body.lead.status).toBe("won");
    },
  },

  // ── owner console ────────────────────────────────────────────────────────
  {
    n: 60,
    route: "GET /v1/owner/overview",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/owner/overview");
      expectOk(res);
      expect(res.body.org.id).toBe(A.orgId);
      expect(res.body.recent.map((l: any) => l.title)).not.toContain("Lead B");
    },
    positive: async () => {
      const res = await get(A, "/owner/overview");
      expect(res.body.recent.map((l: any) => l.title)).toContain("Lead A");
    },
  },
  {
    n: 61,
    route: "PATCH /v1/owner/telecallers/:deviceId",
    pool: "withOrg",
    witness: bDevice,
    negative: async () => {
      // No x-caller-owner-role header is sent, and that is deliberate: doc 13
      // §2.4 O4 - an admin-key caller that omits it passes every
      // @RequireOwnerRole. This test is about tenancy, and it must not be able
      // to pass because the persona guard rejected it for an unrelated reason.
      expectDenied(
        await patch(A, `/owner/telecallers/${B.deviceId}`, { name: "renamed by A" }),
        404,
        /device not found in this org/,
      );
    },
    positive: async () => {
      const res = await patch(A, `/owner/telecallers/${A.deviceId}`, { name: "renamed by A" });
      expectOk(res);
      expect(res.body.device.telecaller_name).toBe("renamed by A");
    },
  },
  {
    n: 62,
    route: "GET /v1/owners",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/owners");
      expectOk(res);
      expect(res.body.owners.map((o: any) => o.email)).not.toContain(B.userEmail);
    },
    positive: async () => {
      expect((await get(A, "/owners")).body.owners.map((o: any) => o.email)).toContain(A.userEmail);
    },
  },
  {
    n: 63,
    route: "POST /v1/owners",
    pool: "withOrg+adminPool",
    // The handler's first act is `SupabaseAdminService.createUser`
    // (owners.controller.ts:115), and childEnv() blanks SUPABASE_URL and
    // SUPABASE_SERVICE_ROLE_KEY so no provisioning call can succeed. Giving the
    // harness real Supabase credentials to exercise one route would put a live
    // identity provider inside a destructive test suite, which is exactly what
    // tests/setup/env.ts exists to make impossible. Its tenancy is covered
    // transitively: every row it writes is written through the same withOrg
    // context asserted on routes 62/64/65.
    excluded:
      "provisions a Supabase Auth user; childEnv() blanks SUPABASE_* by design and must keep doing so",
  },
  {
    n: 64,
    route: "POST /v1/owners/:userId/password",
    pool: "withOrg",
    negative: async () => {
      expectDenied(
        await post(A, `/owners/${B.userId}/password`),
        404,
        /owner not found in this instance/,
      );
    },
    positive: async () => {
      // 409, and that IS the positive result. The membership lookup succeeded -
      // which is the reachability claim - and the handler then refused on a
      // different ground: the fixture owner has no sso_subject, so there is no
      // console login to reset (owners.controller.ts:210). Anything that
      // reached Supabase from a test would be a defect in the harness.
      const res = await post(A, `/owners/${A.userId}/password`);
      expectStatus(res, 409, "own owner without a console login");
      expect(messageOf(res)).toMatch(/no console login to reset/);
    },
  },
  {
    n: 65,
    route: "DELETE /v1/owners/:userId",
    pool: "withOrg+adminPool",
    witness: bOwnerMembership,
    negative: async () => {
      // The one route that deliberately mixes pools: after the RLS-scoped
      // delete it asks `adminPool()` - RLS OFF - whether this human holds a
      // membership anywhere else (owners.controller.ts:287). The witness is
      // what proves the RLS-scoped half stayed scoped.
      expectDenied(await del(A, `/owners/${B.userId}`), 404, /owner not found in this instance/);
    },
    positive: async () => {
      const res = await del(A, `/owners/${A.userId}`);
      expectOk(res);
      expect(res.body.revoked).toBe(true);
      // No sso_subject on the fixture owner, so the Supabase branch is never
      // entered - see the tenants.ts comment on why that is deliberate.
      expect(res.body.loginDeleted).toBe(false);
    },
  },

  // ── compliance ───────────────────────────────────────────────────────────
  {
    n: 66,
    route: "POST /v1/erasure-requests",
    pool: "withOrg",
    witness: bCall,
    negative: async () => {
      // 404 - and the status code is load-bearing here in a way it is nowhere
      // else in this table.
      //
      // This case previously asserted `200 {status: "COMPLETED", purged: []}`,
      // which is what the handler really did: every statement is an unqualified
      // DELETE keyed on call_id, and the receipt was minted unconditionally at
      // the end. No data leaked - RLS scoped the DELETEs - but tenant A walked
      // away with an HMAC-signed (JWT_SECRET), hashed attestation that tenant
      // B's call had been erased, for a call it cannot see and that was never
      // touched. Report 12 §3.6: a receipt that overstates what was deleted is
      // worse than one that admits a gap. A signed artefact must not be issuable
      // on a path that resolved nothing, so the lookup now gates the cascade
      // (erasure.controller.ts:76).
      expectDenied(
        await post(A, "/erasure-requests", { callId: B.callId }),
        404,
        /call not found in this org/,
      );
      // The half a status code cannot assert: no receipt was written to A's
      // ledger either. A 404 that still recorded `erasure.complete` would leave
      // the same false attestation behind, just out of the response body.
      expect(
        await queryRows(
          `SELECT count(*)::int AS n FROM audit_log
            WHERE action = 'erasure.complete' AND target_id = $1`,
          [B.callId],
        ),
      ).toEqual([{ n: 0 }]);
    },
    positive: async () => {
      const res = await post(A, "/erasure-requests", { callId: A.callId });
      expectOk(res);
      expect(res.body.purged).toContain("call_row");
      expect(res.body.purged).toContain("transcript_rows");
    },
  },

  // ── members ──────────────────────────────────────────────────────────────
  {
    n: 67,
    route: "GET /v1/members",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/members");
      expectOk(res);
      expect(res.body.members.map((m: any) => m.email)).not.toContain(B.userEmail);
      // The shared human IS a member of both - they must appear exactly once,
      // with A's row, not twice.
      const shared = res.body.members.filter((m: any) => m.email === SHARED_USER.email);
      expect(shared).toHaveLength(1);
      expect(shared[0].scopeId).toBe(A.orgId);
    },
    positive: async () => {
      expect((await get(A, "/members")).body.members.map((m: any) => m.email)).toContain(
        A.userEmail,
      );
    },
  },
  {
    n: 68,
    route: "POST /v1/members",
    pool: "withOrg",
    witness: {
      sql: `SELECT count(*)::int AS n FROM memberships WHERE org_id = $1`,
      params: [B.orgId],
    },
    negative: async () => {
      expectDenied(
        await post(A, "/members", {
          email: "newcomer@aura.test",
          role: "viewer",
          workspaceId: B.workspaceId,
        }),
        404,
        /workspace not found in this org/,
      );
    },
    positive: async () => {
      const res = await post(A, "/members", { email: "newcomer@aura.test", role: "viewer" });
      expectOk(res);
      expect(res.body.scopeId).toBe(A.orgId);
    },
  },
  {
    n: 69,
    route: "PATCH /v1/members/:userId",
    pool: "withOrg",
    witness: bMembership,
    // doc 13 §1.4 calls this "the single highest-value cross-tenant test in the
    // suite", and it is the only one whose subject genuinely spans tenants: the
    // same `user_id` is the same human in every org they belong to, and
    // `users` has no org_id and no RLS at all.
    negative: async () => {
      // (a) The shared human, edited under A. This SUCCEEDS - and must leave
      //     B's row for the same person byte-identical. The `witness` above is
      //     the assertion; a leak here is a 200 with no error anywhere.
      const shared = await patch(A, `/members/${SHARED_USER.id}`, { role: "workspace_admin" });
      expectOk(shared);
      expect(shared.body.memberships).toHaveLength(1);
      expect(shared.body.memberships[0].scopeId).toBe(A.orgId);

      // (b) A human who belongs only to B, edited under A.
      expectDenied(
        await patch(A, `/members/${B.userId}`, { role: "viewer" }),
        404,
        /member not found in this org/,
      );
    },
    positive: async () => {
      const res = await patch(A, `/members/${SHARED_USER.id}`, { role: "workspace_admin" });
      expectOk(res);
      expect(
        await queryRows(`SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2`, [
          A.orgId,
          SHARED_USER.id,
        ]),
      ).toEqual([{ role: "workspace_admin" }]);
    },
  },
  {
    n: 70,
    route: "DELETE /v1/members/:userId",
    pool: "withOrg",
    witness: bMembership,
    negative: async () => {
      // Same shape as 69: removing the shared human from A must not remove
      // them from B, and a B-only human must not be removable from A at all.
      const shared = await del(A, `/members/${SHARED_USER.id}`);
      expectOk(shared);
      expect(shared.body.deleted).toBe(1);

      expectDenied(await del(A, `/members/${B.userId}`), 404, /member not found in this org/);
    },
    positive: async () => {
      expectOk(await del(A, `/members/${SHARED_USER.id}`));
      expect(
        await queryRows(`SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND user_id = $2`, [
          A.orgId,
          SHARED_USER.id,
        ]),
      ).toEqual([{ n: 0 }]);
    },
  },

  // ── org ──────────────────────────────────────────────────────────────────
  {
    n: 71,
    route: "GET /v1/org",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/org");
      expectOk(res);
      expect(res.body.id).not.toBe(B.orgId);
      expect(res.body.name).not.toBe(B.orgName);
    },
    positive: async () => {
      const res = await get(A, "/org");
      expect(res.body.id).toBe(A.orgId);
      expect(res.body.name).toBe(A.orgName);
    },
  },
  {
    n: 72,
    route: "PATCH /v1/org/policy",
    pool: "withOrg",
    witness: bOrg,
    negative: async () => {
      // No id in the path at all - the org is entirely implicit, and the
      // handler ends with an unqualified `UPDATE instances SET config_version =
      // config_version + 1 WHERE org_id = $1` (tenancy.controller.ts:119).
      // A policy change that reached B would silently re-configure another
      // tenant's whole handset fleet.
      const res = await patch(A, "/org/policy", { retentionDays: 30, consentPolicy: "none" });
      expectOk(res);
      expect(res.body.retention_days).toBe(30);
    },
    positive: async () => {
      await patch(A, "/org/policy", { retentionDays: 30 });
      expect(
        await queryRows(`SELECT retention_days FROM organizations WHERE id = $1`, [A.orgId]),
      ).toEqual([{ retention_days: 30 }]);
    },
  },
  {
    n: 73,
    route: "GET /v1/org/audit",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/org/audit");
      expectOk(res);
      expect(res.body.entries.map((e: any) => e.action)).not.toContain("fixture.b");
    },
    positive: async () => {
      expect((await get(A, "/org/audit")).body.entries.map((e: any) => e.action)).toContain(
        "fixture.a",
      );
    },
  },

  // ── workspaces ───────────────────────────────────────────────────────────
  {
    n: 74,
    route: "GET /v1/workspaces",
    pool: "withOrg",
    negative: async () => {
      const res = await get(A, "/workspaces");
      expectOk(res);
      expect(res.body.workspaces.map((w: any) => w.id)).not.toContain(B.workspaceId);
    },
    positive: async () => {
      expect((await get(A, "/workspaces")).body.workspaces.map((w: any) => w.id)).toEqual([
        A.workspaceId,
      ]);
    },
  },
  {
    n: 75,
    route: "POST /v1/workspaces",
    pool: "withOrg",
    witness: {
      sql: `SELECT count(*)::int AS n FROM workspaces WHERE org_id = $1`,
      params: [B.orgId],
    },
    negative: async () => {
      const created = await post(A, "/workspaces", { name: "made-by-a" });
      expectOk(created);
      const seenByB = await get(B, "/workspaces");
      expect(seenByB.body.workspaces.map((w: any) => w.id)).not.toContain(created.body.id);
    },
    positive: async () => {
      const created = await post(A, "/workspaces", { name: "made-by-a" });
      expectOk(created);
      const seenByA = await get(A, "/workspaces");
      expect(seenByA.body.workspaces.map((w: any) => w.id)).toContain(created.body.id);
    },
  },
];

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Idempotent, and cheap when the schema is already current. It is here so
  // this file does not depend on having run after globalSetup and before
  // setup.test.ts, which drops and rebuilds the schema inside a test of its own.
  await runMigrations();
}, 120_000);

// Every case re-seeds. The DELETE and PATCH cases consume the very rows the
// next case asserts on, and a shared fixture would make the suite's result
// depend on its execution order - the failure mode that is hardest to read and
// easiest to "fix" by deleting the assertion that noticed.
beforeEach(async () => {
  await seedTenants();
});

describe("the fixture contract itself", () => {
  // Doc 13 §5.7 trap 3. These three literals are what the doc says
  // sha256(digits) is; deriving them and then pinning them is what keeps the
  // fixture honest in both directions - a changed derivation fails here rather
  // than silently producing a self-consistent but wrong fixture.
  it("derives the number fragments exactly as calls.controller.ts:155-158 does", () => {
    expect(CONTACT_A.hash).toBe(
      "92b5072176e723878b5e06ff3ca61898e4eb74e8c46642a0f2db800b17364ab0",
    );
    expect(CONTACT_A.prefix).toBe("91987");
    expect(CONTACT_A.last3).toBe("210");
    expect(CONTACT_B.hash).toBe(
      "a5f2bd9ec98f32171407e05521bebb865c7b3ef6be94fddafec455f7836e3bea",
    );
    expect(CONTACT_B.prefix).toBe("91981");
    expect(CONTACT_B.last3).toBe("678");
  });

  it("seeds two tenants that are genuinely independent", async () => {
    const orgs = await queryRows<{ id: string }>(
      `SELECT id FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[A.orgId, B.orgId]],
    );
    expect(orgs).toHaveLength(2);
    // Nothing in tenant A may reference tenant B. A fixture with a shared
    // workspace or device would make half the loop untestable and the other
    // half a false pass.
    const crossed = await queryRows(
      `SELECT 'call' AS kind FROM calls  WHERE org_id = $1 AND workspace_id = $2
       UNION ALL
       SELECT 'device'      FROM devices WHERE org_id = $1 AND instance_id  = $3`,
      [A.orgId, B.workspaceId, B.instanceId],
    );
    expect(crossed).toEqual([]);
  });

  it("covers every tenant-scoped route in doc 13 §1.1 exactly once", () => {
    // The 57 tenant-scoped rows, copied from doc 13 §1.1's Class column.
    const EXPECTED = [
      6, 7, 8, 12, 13, 14, 15, 16, 17, 19, 20, 21, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
      36, 37, 38, 39, 40, 45, 46, 47, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65,
      66, 67, 68, 69, 70, 71, 72, 73, 74, 75,
    ];
    expect(EXPECTED).toHaveLength(57);
    expect(ROUTES.map((r) => r.n).sort((x, y) => x - y)).toEqual(EXPECTED);
  });

  it("never has a negative case without its positive control", () => {
    // The check that makes a vacuous suite impossible to land. A route with a
    // 404 assertion and no reachability assertion is indistinguishable from a
    // route that is simply broken.
    const lopsided = ROUTES.filter(
      (r) => !r.excluded && Boolean(r.negative) !== Boolean(r.positive),
    );
    expect(lopsided.map((r) => r.route)).toEqual([]);
    const silent = ROUTES.filter((r) => !r.excluded && !r.negative);
    expect(silent.map((r) => r.route)).toEqual([]);
  });
});

describe.each(ROUTES)("#$n $route", (rc) => {
  if (rc.excluded) {
    // Deliberately a passing, named test and not an `it.skip`: doc 13 §1.5 is
    // explicit that these must be excluded WITH a reason and not left to
    // silently pass. A reader scanning the output sees the exclusion and why.
    it(`is excluded from the loop - ${rc.excluded}`, () => {
      expect(rc.excluded).toBeTruthy();
    });
    return;
  }

  it("denies tenant A's credential access to tenant B's resource", async () => {
    const before = rc.witness ? await queryRows(rc.witness.sql, rc.witness.params) : null;
    await rc.negative!();
    if (rc.witness) {
      const after = await queryRows(rc.witness.sql, rc.witness.params);
      // The assertion a status code cannot make: a handler that performs the
      // write and THEN reports "not found" is still a breach.
      expect(after, "tenant B's rows changed while tenant A was refused").toEqual(before);
    }
  });

  it("lets tenant A's credential reach tenant A's own resource", async () => {
    await rc.positive!();
  });
});

// ---------------------------------------------------------------------------
// Session pinning - the credential that CANNOT be aimed at another tenant
// ---------------------------------------------------------------------------

describe("session pinning (doc 13 §2.1 A9/A10, §2.2 T6)", () => {
  /**
   * `AdminKeyGuard:114` overwrites `x-org-id` with the session's own org before
   * TenantGuard ever reads it. This is the mechanism Stage 2.4 depends on - the
   * plan's highest-risk item is the web tier giving up its root key, and what it
   * gives it up FOR is this path. If a session could be steered by a header, the
   * replacement credential would be strictly worse than the one it replaces.
   */
  const pinnedRoutes: Array<[string, (c: Caller) => Promise<ApiResponse>, (r: ApiResponse) => void]> =
    [
      [
        "GET /v1/org",
        (c) => call(c, "GET", "/org"),
        (r) => {
          expect(r.body.id).toBe(A.orgId);
          expect(r.body.name).toBe(A.orgName);
        },
      ],
      [
        "GET /v1/calls",
        (c) => call(c, "GET", "/calls"),
        (r) => expect(r.body.calls.map((x: any) => x.id)).toEqual([A.callId]),
      ],
      [
        "GET /v1/leads",
        (c) => call(c, "GET", "/leads"),
        (r) => expect(r.body.leads.map((x: any) => x.id)).toEqual([A.leadId]),
      ],
      [
        "GET /v1/devices",
        (c) => call(c, "GET", "/devices"),
        (r) => expect(r.body.devices.map((x: any) => x.id)).toEqual([A.deviceId]),
      ],
    ];

  it.each(pinnedRoutes)(
    "%s - a tenant-A session sending x-org-id: <tenant B> still gets tenant A",
    async (_label, request, assertIsA) => {
      const plain = await request(asSession(A));
      expectOk(plain);
      assertIsA(plain);

      const claiming = await request(asSessionClaiming(A, B));
      expectOk(claiming);
      // Same answer, not an error: the header is ignored, not rejected. A 4xx
      // here would also be "safe", but it is not what the code does, and
      // pinning the wrong behaviour is how a future refactor gets waved through.
      assertIsA(claiming);
      expect(claiming.body).toEqual(plain.body);
    },
  );

  it("a tenant-A session cannot fetch tenant B's call by id even with B's org header", async () => {
    expectDenied(
      await call(asSessionClaiming(A, B), "GET", `/calls/${B.callId}`),
      404,
      /call not found/,
    );
    expectOk(await call(asSessionClaiming(A, B), "GET", `/calls/${A.callId}`));
  });

  it("the admin key IS steerable by x-org-id - which is why the loop above exists", async () => {
    // Not a defect; it is the documented contract of a cross-tenant credential
    // (AdminKeyGuard's header comment). Pinned here because it is the premise
    // the whole isolation loop rests on: if this stopped being true, every
    // negative case above would start passing for the wrong reason.
    const asA = await get(A, "/org");
    const asB = await get(B, "/org");
    expect(asA.body.id).toBe(A.orgId);
    expect(asB.body.id).toBe(B.orgId);
  });

  it("an admin key naming an org that does not exist is a 404, not an empty read", async () => {
    // doc 13 §2.1 A3. Without this check a typo'd org id reads as "this tenant
    // has no data" rather than "wrong id" - the failure that looks like data
    // loss to a customer.
    const res = await call(
      { label: "admin-key/ghost", headers: { "x-admin-key": adminKey(), "x-org-id": GHOST_ORG } },
      "GET",
      "/calls",
    );
    expectDenied(res, 404, /no organization with id/);
  });

  it("an admin key with no org header at all is a 400 from TenantGuard", async () => {
    // doc 13 §2.2 T4. The guard leaves principal.orgId as "" and TenantGuard
    // refuses rather than letting withOrg("") run unscoped.
    const res = await call(
      { label: "admin-key/no-org", headers: { "x-admin-key": adminKey() } },
      "GET",
      "/calls",
    );
    expectDenied(res, 400, /x-org-id header \(uuid\) required/);
  });
});
