import { describe, expect, it } from "vitest";

import { OwnerRole, resolveOwnerRole } from "./roles";

/**
 * The owner-console persona resolver.
 *
 * This is about to become an authorization input (OwnerRoleGuard, migration
 * 0018), so its behaviour on unexpected input is a security property, not a
 * detail. Everything below pins what the code does TODAY — including the
 * fail-open default, which roles.ts:12-19 documents as deliberate. It is pinned
 * rather than "fixed" here because changing it is a product decision about who
 * loses access, not a test's call to make.
 */

describe("resolveOwnerRole", () => {
  it("returns each of the three legal personas unchanged", () => {
    // The legal set is memberships.owner_role's CHECK constraint (0018):
    // NULL | owner | manager | telecaller.
    expect(resolveOwnerRole("owner")).toBe("owner");
    expect(resolveOwnerRole("manager")).toBe("manager");
    expect(resolveOwnerRole("telecaller")).toBe("telecaller");
  });

  it("covers every value the OwnerRole enum declares", () => {
    // Guards against a persona being added to the enum without anyone deciding
    // how resolveOwnerRole should treat it — a new value must at minimum
    // round-trip through this function.
    for (const role of OwnerRole.options) {
      expect(resolveOwnerRole(role)).toBe(role);
    }
  });

  it("resolves NULL to owner — the fail-OPEN default, deliberate per roles.ts:12-19", () => {
    // NULL owner_role means "a membership that predates personas", and 0018
    // backfilled those to owner. Documented as deliberate: adding a persona must
    // only ever narrow access, never silently remove it from an existing login.
    // The consequence is that the default is the MOST permissive persona, so any
    // future code path that resolves a role it failed to load gets full access.
    expect(resolveOwnerRole(null)).toBe("owner");
    expect(resolveOwnerRole(undefined)).toBe("owner");
  });

  it("resolves an unrecognised string to owner rather than rejecting it", () => {
    // memberships.role values (0001) are a DIFFERENT vocabulary and must never
    // be passed here; if one is, it silently resolves to full owner access.
    expect(resolveOwnerRole("admin")).toBe("owner");
    expect(resolveOwnerRole("org_admin")).toBe("owner");
    expect(resolveOwnerRole("viewer")).toBe("owner");
    expect(resolveOwnerRole("")).toBe("owner");
  });

  it("resolves non-string input to owner rather than throwing", () => {
    // The value arrives from pg as `unknown`; a numeric or object column value
    // must not crash a console page render.
    expect(resolveOwnerRole(0 as unknown as string)).toBe("owner");
    expect(resolveOwnerRole({} as unknown as string)).toBe("owner");
    expect(resolveOwnerRole([] as unknown as string)).toBe("owner");
  });

  /**
   * The fallback is the most permissive persona, so a case variant of a
   * RESTRICTED persona must degrade to the persona meant — never escalate.
   * Fixed by normalising (trim + lower-case) before the parse; the null default
   * above is unchanged, because owner IS the safe answer for "no persona".
   */
  it("does not escalate a case variant of a restricted persona to owner", () => {
    expect(resolveOwnerRole("Telecaller")).toBe("telecaller");
    expect(resolveOwnerRole("TELECALLER")).toBe("telecaller");
    expect(resolveOwnerRole(" manager ")).toBe("manager");
    expect(resolveOwnerRole("MANAGER")).toBe("manager");
    expect(resolveOwnerRole(" telecaller ")).toBe("telecaller");
    expect(resolveOwnerRole("\tOwner\n")).toBe("owner");
  });

  it("still resolves a whitespace-only value the fail-open way, not by throwing", () => {
    // Normalising made "   " indistinguishable from "" — both are absent, and
    // absent has always meant owner.
    expect(resolveOwnerRole("   ")).toBe("owner");
  });
});
