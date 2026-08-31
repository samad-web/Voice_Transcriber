import { describe, expect, it } from "vitest";
import { API_SCOPES, ApiScope, effectiveScopes, hasScope } from "./api-scopes";

describe("api scopes", () => {
  it("is a closed set with no delete, no send, and no recording access", () => {
    // Asserted as an exact list rather than a spot-check: the security property
    // of this module is what is ABSENT from it, and absence is only testable
    // against the whole set. A future `messages:send` or `recordings:read`
    // added without thought fails here first.
    expect([...API_SCOPES].sort()).toEqual([
      "contacts:read",
      "contacts:write",
      "deals:read",
      "deals:write",
      "leads:read",
      "leads:write",
      "mcp",
      "projects:read",
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
    // code that predates it — it must be able to do nothing at all.
    expect(hasScope([], "leads:read")).toBe(false);
    expect(hasScope(["leads:*"], "leads:read")).toBe(false);
    expect(hasScope(["*"], "leads:read")).toBe(false);
    expect(hasScope(["admin"], "leads:write")).toBe(false);
  });

  it("does not invent a :read for a scope that has no object half", () => {
    // `effectiveScopes` splits on ":" — a bare token must not produce
    // "undefined:read" or, worse, be treated as a wildcard.
    expect([...effectiveScopes(["mcp"])]).toEqual(["mcp"]);
  });

  it("parses only known scopes", () => {
    expect(ApiScope.safeParse("leads:write").success).toBe(true);
    expect(ApiScope.safeParse("recordings:read").success).toBe(false);
    expect(ApiScope.safeParse("messages:send").success).toBe(false);
  });
});
