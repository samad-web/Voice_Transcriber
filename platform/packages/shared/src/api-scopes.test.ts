import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_SCOPES, ApiScope, effectiveScopes, hasScope } from "./api-scopes";

describe("api scopes", () => {
  it("is a closed set with no delete, no send, and no recording access", () => {
    // Asserted as an exact list rather than a spot-check: the security property
    // of this module is what is ABSENT from it, and absence is only testable
    // against the whole set. A future `messages:send` or `recordings:read`
    // added without thought fails here first.
    expect([...API_SCOPES].sort()).toEqual([
      "attendance:read",
      "attendance:write",
      "calls:read",
      "calls:write",
      "contacts:read",
      "contacts:write",
      "conversions:read",
      "conversions:write",
      "deals:read",
      "deals:write",
      "events:read",
      "kpi:read",
      "leads:read",
      "leads:write",
      "mcp",
      "payments:read",
      "payments:write",
      "projects:read",
      "quality:read",
      "quality:write",
      "targets:read",
      "targets:write",
      "teams:read",
      "teams:write",
      "telecallers:read",
      "telecallers:write",
      "usage:read",
    ]);
    expect(API_SCOPES.filter((s) => s.endsWith(":delete"))).toEqual([]);
    expect(API_SCOPES.filter((s) => s.includes("send"))).toEqual([]);
    expect(API_SCOPES.filter((s) => s.startsWith("recordings") || s.startsWith("transcripts"))).toEqual([]);
  });

  it("treats :write as implying its own :read", () => {
    expect(hasScope(["leads:write"], "leads:read")).toBe(true);
    expect(hasScope(["contacts:write"], "contacts:read")).toBe(true);
  });

  it("does NOT let :write on one object imply anything about another", () => {
    // The failure that would matter: an ingest key with `leads:write` being
    // able to enumerate the tenant's contact book.
    expect(hasScope(["leads:write"], "contacts:read")).toBe(false);
    expect(hasScope(["leads:write"], "deals:read")).toBe(false);
    expect(hasScope(["leads:write"], "projects:read")).toBe(false);
  });

  it("does NOT let :read imply :write", () => {
    expect(hasScope(["leads:read"], "leads:write")).toBe(false);
    expect(hasScope(["deals:read"], "deals:write")).toBe(false);
  });

  it("keeps `mcp` independent of every data scope", () => {
    // Being allowed to speak MCP grants no data, and holding data scopes does
    // not let a backend key be driven by a model. Both directions matter.
    expect(hasScope(["mcp"], "leads:read")).toBe(false);
    expect(hasScope(["leads:write", "contacts:write", "deals:write"], "mcp")).toBe(false);
    expect(hasScope(["mcp", "leads:write"], "mcp")).toBe(true);
  });

  it("grants nothing for an empty or unrecognised scope list", () => {
    // 0076 defaults `scopes` to '{}', so this is the state of any key minted by
    // code that predates it - it must be able to do nothing at all.
    expect(hasScope([], "leads:read")).toBe(false);
    expect(hasScope(["leads:*"], "leads:read")).toBe(false);
    expect(hasScope(["*"], "leads:read")).toBe(false);
    expect(hasScope(["admin"], "leads:write")).toBe(false);
  });

  it("does not invent a :read for a scope that has no object half", () => {
    // `effectiveScopes` splits on ":" - a bare token must not produce
    // "undefined:read" or, worse, be treated as a wildcard.
    expect([...effectiveScopes(["mcp"])]).toEqual(["mcp"]);
  });

  it("parses only known scopes", () => {
    expect(ApiScope.safeParse("leads:write").success).toBe(true);
    expect(ApiScope.safeParse("recordings:read").success).toBe(false);
    expect(ApiScope.safeParse("messages:send").success).toBe(false);
  });

  it("does not let an ingestion scope imply anything on the CRM surface", () => {
    // The whole reason the ingest scopes are a separate set rather than a
    // widening of the CRM ones. A dialer integration pushing call volumes must
    // not be one `effectiveScopes` quirk away from the tenant's contact book.
    const dialer = ["calls:write", "telecallers:write", "conversions:write"];
    for (const crm of ["leads:read", "contacts:read", "deals:read", "projects:read", "mcp"] as const) {
      expect([crm, hasScope(dialer, crm)]).toEqual([crm, false]);
    }
    // And the reverse: a CRM key holds nothing on the insights surface.
    const crmKey = ["leads:write", "contacts:write", "deals:write"];
    for (const ingest of ["calls:write", "kpi:read", "usage:read", "events:read"] as const) {
      expect([ingest, hasScope(crmKey, ingest)]).toEqual([ingest, false]);
    }
  });

  it("keeps the read-only surfaces unreachable by implication", () => {
    // `kpi:read`, `usage:read` and `events:read` have no `:write` counterpart
    // on purpose, so nothing can grant them except granting them. If somebody
    // ever adds `kpi:write`, this test is what tells them it also hands every
    // ingest key the leaderboard.
    for (const scope of ["kpi", "usage", "events"] as const) {
      expect(API_SCOPES.filter((s) => s === `${scope}:write`)).toEqual([]);
    }
  });

  it("matches the set migration 0193 will accept", () => {
    // A key whose scope passes zod and fails `api_keys_scopes_known` is a 500
    // on the key-creation screen. The CHECK cannot import this file, so the
    // two are compared here - the same drift check org-features.test.ts runs
    // against 0093's hardcoded feature/module pairs.
    // First candidate that exists: vitest runs with this package as its root,
    // and an ad-hoc run from the repo root is also normal. `import.meta` is
    // not available - this package compiles to CommonJS.
    const name = "0193_insights_ingestion.sql";
    const path = [
      resolve(process.cwd(), "../db/migrations", name),
      resolve(process.cwd(), "packages/db/migrations", name),
      resolve(process.cwd(), "../../packages/db/migrations", name),
    ].find((p) => existsSync(p));
    if (!path) throw new Error(`cannot find ${name} from ${process.cwd()}`);
    const sql = readFileSync(path, "utf8");
    const body = sql.slice(
      sql.indexOf("ADD CONSTRAINT api_keys_scopes_known"),
      sql.indexOf("]::text[]);"),
    );
    const inCheck = [...body.matchAll(/'([a-z_]+(?::[a-z]+)?)'/g)].map((m) => m[1]);
    expect([...new Set(inCheck)].sort()).toEqual([...API_SCOPES].sort());
  });
});
