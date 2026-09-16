import { describe, expect, it } from "vitest";

import {
  canPairDevices,
  canRevokeDevices,
  OWNER_ROLE_ADMINS,
  OWNER_ROLE_DESCRIPTIONS,
  OWNER_ROLE_LABELS,
  OWNER_ROLE_RECORD_SCOPE,
  OwnerRole,
  isWorkspaceAdminRole,
  ownerRoleRecordScope,
  ownerRoleSeesAllRecords,
  resolveOwnerRole,
} from "./roles";

/**
 * The owner-console persona resolver.
 *
 * This is about to become an authorization input (OwnerRoleGuard, migration
 * 0018), so its behaviour on unexpected input is a security property, not a
 * detail. Everything below pins what the code does TODAY - including the
 * fail-open default, which roles.ts:12-19 documents as deliberate. It is pinned
 * rather than "fixed" here because changing it is a product decision about who
 * loses access, not a test's call to make.
 */

describe("resolveOwnerRole", () => {
  it("returns each of the five legal personas unchanged", () => {
    // The legal set is memberships.owner_role's CHECK constraint, widened by
    // migration 0079: NULL | owner | manager | telecaller | sales | marketing.
    expect(resolveOwnerRole("owner")).toBe("owner");
    expect(resolveOwnerRole("manager")).toBe("manager");
    expect(resolveOwnerRole("telecaller")).toBe("telecaller");
    expect(resolveOwnerRole("sales")).toBe("sales");
    expect(resolveOwnerRole("marketing")).toBe("marketing");
  });

  it("covers every value the OwnerRole enum declares", () => {
    // Guards against a persona being added to the enum without anyone deciding
    // how resolveOwnerRole should treat it - a new value must at minimum
    // round-trip through this function.
    for (const role of OwnerRole.options) {
      expect(resolveOwnerRole(role)).toBe(role);
    }
  });

  it("resolves NULL to owner - the fail-OPEN default, deliberate per roles.ts:12-19", () => {
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
   * RESTRICTED persona must degrade to the persona meant - never escalate.
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
    // Normalising made "   " indistinguishable from "" - both are absent, and
    // absent has always meant owner.
    expect(resolveOwnerRole("   ")).toBe("owner");
  });
});

/**
 * The persona -> record-scope table (migration 0079).
 *
 * This is read by BOTH tiers - the API builds a SQL predicate from it, the web
 * tier picks a dashboard composition from it - so the cost of the two
 * disagreeing is a page that renders a number the API will not back. One table,
 * asserted here, is what keeps them in step.
 */
describe("OWNER_ROLE_RECORD_SCOPE", () => {
  it("answers for every persona the enum declares", () => {
    // The guard against adding a persona and forgetting to decide whose
    // records it reads. `undefined` from this lookup would flow into
    // `ownerRoleSeesAllRecords` as falsy and silently produce the MOST
    // restrictive answer for a persona nobody scoped - a lockout with no error.
    for (const role of OwnerRole.options) {
      expect([role, OWNER_ROLE_RECORD_SCOPE[role]]).toEqual([
        role,
        expect.stringMatching(/^(all|own)$/),
      ]);
    }
  });

  it("narrows exactly telecaller and sales", () => {
    expect(ownerRoleRecordScope("telecaller")).toBe("own");
    expect(ownerRoleRecordScope("sales")).toBe("own");
  });

  it("leaves marketing unrestricted BY SCOPE, deliberately", () => {
    // The row that looks wrong at a glance and is not. Nothing is assigned to
    // a marketer, so `own` would mean an empty console by construction; the
    // marketing persona is restricted by OBJECT instead (no transcripts, no
    // invoices, no customer inbox), which nav.ts and the API guards enforce.
    expect(ownerRoleRecordScope("marketing")).toBe("all");
    expect(ownerRoleSeesAllRecords("marketing")).toBe(true);
  });

  it("agrees with itself - the helper and the table never diverge", () => {
    for (const role of OwnerRole.options) {
      expect([role, ownerRoleSeesAllRecords(role)]).toEqual([
        role,
        OWNER_ROLE_RECORD_SCOPE[role] === "all",
      ]);
    }
  });
});

describe("the persona display strings", () => {
  it("labels and describes every persona", () => {
    // A missing entry renders as `undefined` in a dropdown - which is how a
    // role ships that nobody can tell apart from the one above it.
    for (const role of OwnerRole.options) {
      expect([role, OWNER_ROLE_LABELS[role]?.length > 0]).toEqual([role, true]);
      expect([role, OWNER_ROLE_DESCRIPTIONS[role]?.length > 0]).toEqual([role, true]);
    }
  });

  it("gives each persona a distinct label", () => {
    const labels = OwnerRole.options.map((r) => OWNER_ROLE_LABELS[r]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("isWorkspaceAdminRole", () => {
  it("is owner and manager, and nobody else", () => {
    // Who may open the Team page and read the roster. Assigning a persona is
    // narrower still - owner alone - and that lives on the route, not here.
    expect(isWorkspaceAdminRole("owner")).toBe(true);
    expect(isWorkspaceAdminRole("manager")).toBe(true);
    for (const role of ["telecaller", "sales", "marketing"] as const) {
      expect([role, isWorkspaceAdminRole(role)]).toEqual([role, false]);
    }
  });

  it("matches the exported list it is built from", () => {
    for (const role of OwnerRole.options) {
      expect([role, isWorkspaceAdminRole(role)]).toEqual([role, OWNER_ROLE_ADMINS.includes(role)]);
    }
  });
});

/**
 * The hazard migration 0079's header warns about, written down as a test.
 *
 * `resolveOwnerRole` is fail-OPEN on a string it does not recognise, so a build
 * that predates a persona resolves that persona to `owner`. That is only
 * reachable when new DATA meets OLD CODE - the window a rolling deploy opens -
 * and the mitigation is deploy order, not code. Pinned here so the next person
 * to add a persona meets the constraint before they meet the incident.
 */
describe("adding a persona (the deploy-order constraint)", () => {
  it("resolves a persona this build does not know to the WIDEST role", () => {
    expect(resolveOwnerRole("procurement")).toBe("owner");
  });

  it("is why code ships before personas are assigned - see migration 0079", () => {
    // Stated as an assertion rather than a comment so it appears in the run:
    // every value the CURRENT enum declares round-trips, which is what makes
    // step 1 of 0079's deploy order sufficient.
    for (const role of OwnerRole.options) {
      expect([role, resolveOwnerRole(role)]).toEqual([role, role]);
    }
  });
});

describe("device pairing capability (migration 0107)", () => {
  it("always allows an owner, whatever the stored flag says", () => {
    // Storing the owner's own permission would create a state - owner with the
    // flag off - in which a tenant has nobody who can pair a handset and no way
    // to fix it from inside their own console.
    expect(canPairDevices("owner", false)).toBe(true);
    expect(canPairDevices("owner", true)).toBe(true);
  });

  it("allows nobody else without an explicit grant", () => {
    // There is deliberately no persona that carries this implicitly: "all
    // managers may pair" was never the requirement.
    for (const role of ["manager", "telecaller", "sales", "marketing"] as const) {
      expect(canPairDevices(role, false)).toBe(false);
    }
  });

  it("allows anyone the owner has granted it to, including a telecaller", () => {
    for (const role of ["manager", "telecaller", "sales", "marketing"] as const) {
      expect(canPairDevices(role, true)).toBe(true);
    }
  });

  it("treats a non-boolean grant as no grant", () => {
    // The flag arrives from a database row; anything that is not exactly true
    // must not widen access.
    expect(canPairDevices("telecaller", undefined as unknown as boolean)).toBe(false);
    expect(canPairDevices("telecaller", null as unknown as boolean)).toBe(false);
  });

  it("keeps revoking with owner and manager, and does not delegate it", () => {
    // Pairing adds a device the owner can see and remove; revoking pulls a
    // working phone out of a shift. Only the reversible half travels.
    expect(canRevokeDevices("owner")).toBe(true);
    expect(canRevokeDevices("manager")).toBe(true);
    expect(canRevokeDevices("telecaller")).toBe(false);
    expect(canRevokeDevices("sales")).toBe(false);
    expect(canRevokeDevices("marketing")).toBe(false);
  });
});
