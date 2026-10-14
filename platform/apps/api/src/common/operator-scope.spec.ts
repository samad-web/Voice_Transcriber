import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  describeScope,
  isRootOperator,
  operatorOrgScope,
  operatorPrincipalFrom,
  operatorScopeSql,
  rootOperatorEmail,
  scopeForRequest,
} from "./operator-scope";

/**
 * THE INVENTORY, AUTOMATED (doc 49 P13b).
 *
 * ── WHY A SCANNER AND NOT A CHECKLIST ───────────────────────────────────────
 *
 * Doc 49 is explicit about the failure mode: "Miss one and it leaks the whole
 * fleet. This is the same shape as the five holes the partner RLS wall had in
 * doc 39, and it will behave the same way: the sites you remember are fine and
 * the twenty-first is the problem. Budget for a grep-driven inventory, not for
 * intuition."
 *
 * A grep done once is a grep that was right once. This is the same grep, run on
 * every push, so a cross-tenant client read added next month either carries the
 * scope or names itself here with a reason.
 *
 * ── WHAT "SCOPED" MEANS FOR THIS TEST ───────────────────────────────────────
 *
 * The file mentions `operatorScopeSql` or `scopeForRequest`. That is a weaker
 * check than proving the predicate reaches the right query - which needs a
 * database and belongs in the integration suite - and it is the check that
 * catches the thing actually worth catching: a route added with no thought
 * given to scope at all.
 */

const API_SRC = (() => {
  let dir = resolve(__dirname);
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(dir, "modules")) && existsSync(join(dir, "common"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find apps/api/src above ${__dirname}`);
})();

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/**
 * Cross-tenant reads that legitimately do NOT scope by who onboarded the
 * client, each with the reason. Adding to this list is a reviewed edit, which
 * is the point - the same shape `verify-rls.js`'s non-tenant allowlist uses.
 */
const NOT_CLIENT_SCOPED: Record<string, string> = {
  "modules/auth/auth.controller.ts":
    "signing in happens before anybody is an operator; there is no scope to apply",
  "modules/account/auth-events.controller.ts":
    "a PERSON's own sign-in history, bound to their own auth_user_id - not a client read",
  "modules/admin/operators.controller.ts":
    "the operator roster itself. Knowing who else administers the platform is not a " +
    "privilege, and 0089 states that a list nobody can see is a list nobody audits",
  "modules/admin/operator-invites.controller.ts":
    "inviting an operator is root-gated already and concerns no client",
  "modules/owner/auth-invites.controller.ts":
    "a tenant inviting its own people, resolved from that tenant's context",
  "modules/partners/portal.controller.ts":
    "the partner portal is partner-scoped by doc 39's RLS wall, a different axis entirely",
  "modules/partners/portal-invites.controller.ts": "same - partner scope, not operator scope",
  "modules/leads/leads.controller.ts":
    "the MARKETING funnel's own leads - prospects who have not become tenants, so there " +
    "is no onboarding operator to scope by",
  "modules/leads/slots.controller.ts": "marketing funnel booking slots; platform-level, no client",
  "modules/leads/funnel-criteria.controller.ts": "marketing funnel configuration; no client",
  "modules/leads/message-templates.controller.ts": "marketing funnel templates; no client",
  "modules/leads/whatsapp-check.controller.ts": "a number lookup for the funnel; no client",
  "modules/entitlements/plan-admin.controller.ts":
    "the plan CATALOGUE is platform data - one row for Growth, shared by every tenant. " +
    "The per-tenant assignment route takes an explicit orgId and is covered by " +
    "TenantGuard",
  "modules/billing/platform-billing-admin.controller.ts":
    "NOT YET SCOPED, and listed rather than silently passing. This is the revenue read " +
    "P13c builds on; it is scoped as part of that work, and until then a superadmin " +
    "sees the platform's billing. Tracked in DEPLOYMENT.md §13",
};

describe("every cross-tenant client read is scoped, or says why not", () => {
  const files = sources(API_SRC);

  it("finds the API surface at all", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no @CrossTenant route reads clients without the scope or an entry here", () => {
    const problems: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("@CrossTenant")) continue;

      const rel = file.slice(API_SRC.length + 1).replace(/\\/g, "/");
      // The two files that DEFINE the decorator and the principal are not routes.
      if (rel === "common/tenant.guard.ts" || rel === "common/auth-principal.ts") continue;
      if (rel in NOT_CLIENT_SCOPED) continue;
      if (rel.endsWith(".module.ts")) continue;

      const scoped =
        text.includes("operatorScopeSql") || text.includes("scopeForRequest");
      if (!scoped) {
        problems.push(
          `${rel} has @CrossTenant routes and does not mention the operator scope.\n` +
            "    Either apply operatorScopeSql, or add it to NOT_CLIENT_SCOPED with a reason.",
        );
      }
    }
    // Jest's `expect` takes ONE argument - vitest's second message argument
    // does not compile here. So the detail goes into the asserted VALUE: a
    // failure must print WHICH file is unscoped, not just "1 != 0".
    expect(problems.join("\n")).toBe("");
  });

  it("NOT_CLIENT_SCOPED names only files that exist and are cross-tenant", () => {
    // A stale exemption is an exemption that silently covers the next real one.
    const problems: string[] = [];
    for (const rel of Object.keys(NOT_CLIENT_SCOPED)) {
      const full = join(API_SRC, rel);
      if (!existsSync(full)) {
        problems.push(`${rel} is exempted but does not exist`);
        continue;
      }
      if (!readFileSync(full, "utf8").includes("@CrossTenant")) {
        problems.push(`${rel} is exempted but has no @CrossTenant route - remove the entry`);
      }
    }
    // Jest's `expect` takes ONE argument - vitest's second message argument
    // does not compile here. So the detail goes into the asserted VALUE: a
    // failure must print WHICH file is unscoped, not just "1 != 0".
    expect(problems.join("\n")).toBe("");
  });

  it("every exemption carries a reason somebody can argue with", () => {
    for (const [rel, reason] of Object.entries(NOT_CLIENT_SCOPED)) {
      const short = reason.length > 30 ? "" : `${rel}'s reason is too short to be a reason`;
      expect(short).toBe("");
    }
  });
});

describe("operatorOrgScope", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is OFF by default, and that is deliberate", () => {
    // The backfill leaves every existing tenant unattributed, so switching the
    // filter on before anybody has attributed them makes four live clients
    // vanish from every superadmin's console at once - and a console that
    // suddenly shows nothing is indistinguishable from an outage.
    delete process.env.OPERATOR_SCOPE_ENABLED;
    expect(operatorOrgScope({ email: "someone@example.com", isRoot: false })).toEqual({
      kind: "all",
    });
  });

  it("gives the root everything", () => {
    process.env.OPERATOR_SCOPE_ENABLED = "1";
    expect(operatorOrgScope({ email: "max@example.com", isRoot: true })).toEqual({ kind: "all" });
  });

  it("gives a superadmin their own book", () => {
    process.env.OPERATOR_SCOPE_ENABLED = "1";
    expect(operatorOrgScope({ email: "Asha@Example.com", isRoot: false })).toEqual({
      kind: "onboarded_by",
      email: "asha@example.com",
    });
  });

  it("gives an UNIDENTIFIED caller NOTHING, not everything", () => {
    // The failure mode of a missing identity must be an empty screen somebody
    // reports, not the fleet. A script holding the admin key, a route that
    // forgot to forward x-operator-email, a header that failed to parse - all
    // of them land here.
    process.env.OPERATOR_SCOPE_ENABLED = "1";
    expect(operatorOrgScope({ email: null, isRoot: false })).toEqual({ kind: "none" });
  });
});

describe("the root comes from the environment, never a table", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("matches the configured address, case- and space-insensitively", () => {
    process.env.PLATFORM_ROOT_OPERATOR_EMAIL = " Max@Example.com ";
    expect(rootOperatorEmail()).toBe("max@example.com");
    expect(isRootOperator("max@example.com")).toBe(true);
    expect(isRootOperator("MAX@EXAMPLE.COM")).toBe(true);
    expect(isRootOperator("someone@example.com")).toBe(false);
  });

  it("makes NOBODY root when unset", () => {
    // 0089's own argument: a root stored in the database could be deleted by
    // anything that reaches the table and replaced with an attacker's address.
    // Unset means nobody is root - never everybody.
    delete process.env.PLATFORM_ROOT_OPERATOR_EMAIL;
    expect(isRootOperator("max@example.com")).toBe(false);
    expect(isRootOperator(null)).toBe(false);
    expect(isRootOperator("")).toBe(false);
  });
});

describe("operatorScopeSql", () => {
  it("returns a complete boolean expression for every scope", () => {
    // So a caller can AND it in unconditionally without thinking about the
    // "all" case - and thinking about it is exactly what produces the
    // twenty-first unfiltered read.
    expect(operatorScopeSql({ kind: "all" }, "o.id", 1)).toEqual({ sql: "TRUE", params: [] });
    expect(operatorScopeSql({ kind: "none" }, "o.id", 1)).toEqual({ sql: "FALSE", params: [] });
  });

  it("filters on the attribution column, with the parameter the caller asked for", () => {
    const gate = operatorScopeSql({ kind: "onboarded_by", email: "asha@example.com" }, "c.org_id", 7);
    expect(gate.sql).toContain("onboarded_by_operator = $7");
    expect(gate.sql).toContain("scope_o.id = c.org_id");
    expect(gate.params).toEqual(["asha@example.com"]);
  });

  it("never interpolates the email", () => {
    // The ONE thing that must not happen here: the address comes from a header.
    const gate = operatorScopeSql(
      { kind: "onboarded_by", email: "'; DROP TABLE organizations; --" },
      "o.id",
      1,
    );
    expect(gate.sql).not.toContain("DROP");
    expect(gate.params[0]).toContain("DROP");
  });
});

describe("scopeForRequest", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reads the operator from the principal, lower-cased", () => {
    process.env.OPERATOR_SCOPE_ENABLED = "1";
    process.env.PLATFORM_ROOT_OPERATOR_EMAIL = "max@example.com";
    expect(scopeForRequest({ principal: { operatorEmail: "Asha@Example.com" } })).toEqual({
      kind: "onboarded_by",
      email: "asha@example.com",
    });
    expect(scopeForRequest({ principal: { operatorEmail: "max@example.com" } })).toEqual({
      kind: "all",
    });
    expect(scopeForRequest({ principal: null })).toEqual({ kind: "none" });
  });

  it("builds a principal whose isRoot is never taken from the caller", () => {
    process.env.PLATFORM_ROOT_OPERATOR_EMAIL = "max@example.com";
    // The header names WHO is asking; whether that person is root is decided
    // here, against the environment. A caller cannot assert it.
    expect(operatorPrincipalFrom({ principal: { operatorEmail: "asha@example.com" } })).toEqual({
      email: "asha@example.com",
      isRoot: false,
    });
  });
});

describe("describeScope", () => {
  it("says 'your clients', never 'only you can see this'", () => {
    // The honest caption. This is a console-tier filter, not a containment of
    // a hostile superadmin: every operator can reach ADMIN_API_KEY, which is
    // cross-tenant by design. Claiming exclusivity would be a false promise.
    const note = describeScope({ kind: "onboarded_by", email: "a@b.com" }) ?? "";
    expect(note).toMatch(/your clients/i);
    expect(note.toLowerCase()).not.toContain("only you");
    expect(note.toLowerCase()).not.toContain("private");
  });

  it("says nothing at all for the root - an unfiltered screen needs no caption", () => {
    expect(describeScope({ kind: "all" })).toBeNull();
  });
});
