import { describe, expect, it } from "vitest";
import {
  exportablePeople,
  loadPerson,
  resolvePeopleVisibility,
  visibilityAllowsTelecaller,
  visibilityAllowsUser,
  type PeopleVisibility,
} from "./people-visibility";

/**
 * WHOSE RECORDS A PERSON MAY SEE (0188).
 *
 * A fake client, so these prove the DECISIONS - who gets `all`, who gets a
 * branch, what an unmapped manager falls back to, and which direction each
 * uncertainty resolves in. Whether the recursive SQL is valid is the
 * migration's and the live check's job; what it MEANS is this file's.
 *
 * Every case here is written as "what happens when", because the whole module
 * is a sequence of fail-closed choices and the only way to keep them is to
 * name the alternative each one rejected.
 */

const flat = (sql: string) => sql.replace(/\s+/gu, " ").trim();

function fakeClient(answer: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const log: string[] = [];
  const client = {
    async query<R>(sql: string, params: unknown[] = []) {
      log.push(flat(sql));
      return { rows: answer(flat(sql), params) as R[] };
    },
  };
  return { client, log };
}

const ME = "11111111-1111-4111-8111-111111111111";
const MY_TC = "1aaaaaaa-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";
const THEIR_TC = "2aaaaaaa-2222-4222-8222-222222222222";
const STRANGER_TC = "3aaaaaaa-3333-4333-8333-333333333333";

const isBranchQuery = (sql: string) => sql.includes("WITH RECURSIVE my_seats");
const isOwnQuery = (sql: string) => sql.startsWith("SELECT id FROM telecallers");

describe("resolvePeopleVisibility", () => {
  it("gives an admin key everything, without asking the database", async () => {
    // An operator or a script. Short-circuited before any query, because there
    // is no user to resolve a seat for - and a query that returned nothing
    // would otherwise narrow them to nothing.
    const { client, log } = fakeClient(() => []);
    const v = await resolvePeopleVisibility(client, {
      userId: null,
      ownerRole: null,
      viaAdminKey: true,
    });
    expect(v).toEqual({ kind: "all" });
    expect(log).toEqual([]);
  });

  it("gives an owner everything, and treats a null persona as owner", async () => {
    // The null case is not laziness: `resolveOwnerRole` is fail-open for a
    // membership that predates personas everywhere else in the console, and
    // two different answers to "what is a null persona" is worse than either.
    for (const ownerRole of ["owner", null] as const) {
      const { client, log } = fakeClient(() => []);
      const v = await resolvePeopleVisibility(client, {
        userId: ME,
        ownerRole,
        viaAdminKey: false,
      });
      expect(v).toEqual({ kind: "all" });
      expect(log).toEqual([]);
    }
  });

  it("gives a telecaller their own identity only", async () => {
    const { client, log } = fakeClient((sql) => (isOwnQuery(sql) ? [{ id: MY_TC }] : []));
    const v = await resolvePeopleVisibility(client, {
      userId: ME,
      ownerRole: "telecaller",
      viaAdminKey: false,
    });
    expect(v).toEqual({ kind: "own", telecallerId: MY_TC, userId: ME });
    // One query, and it asks only for an ACTIVE identity - an archived
    // telecaller is not somebody whose work is still being reported on.
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("status = 'active'");
  });

  it("narrows a telecaller with no identity to nothing, not to everything", async () => {
    // The load-bearing negative. `telecallers.user_id` is nullable and most of
    // a floor has never signed in, so "no identity" is common - and reading it
    // as "no restriction" would hand the whole floor to a restricted persona.
    const { client } = fakeClient(() => []);
    const v = await resolvePeopleVisibility(client, {
      userId: ME,
      ownerRole: "telecaller",
      viaAdminKey: false,
    });
    expect(v).toEqual({ kind: "own", telecallerId: null, userId: ME });
    expect(visibilityAllowsTelecaller(v, MY_TC)).toBe(false);
    expect(visibilityAllowsTelecaller(v, THEIR_TC)).toBe(false);
  });

  it("fails closed for a caller with no user and no admin key", async () => {
    const { client, log } = fakeClient(() => []);
    const v = await resolvePeopleVisibility(client, {
      userId: null,
      ownerRole: "manager",
      viaAdminKey: false,
    });
    // A manager with no resolvable user does NOT get a branch - it gets an
    // empty own-scope, which matches nothing.
    expect(v).toEqual({ kind: "own", telecallerId: null, userId: null });
    expect(log).toEqual([]);
  });

  it("gives a manager their org-chart subtree, plus themselves", async () => {
    const { client } = fakeClient((sql) => {
      if (isBranchQuery(sql)) {
        return [
          { user_id: THEM, telecaller_id: THEIR_TC },
          // Somebody in the subtree holding a seat but no handset: they must
          // still be reachable, or the one person responsible for them cannot
          // export them.
          { user_id: "44444444-4444-4444-8444-444444444444", telecaller_id: null },
        ];
      }
      return isOwnQuery(sql) ? [{ id: MY_TC }] : [];
    });

    const v = await resolvePeopleVisibility(client, {
      userId: ME,
      ownerRole: "manager",
      viaAdminKey: false,
    });
    expect(v.kind).toBe("branch");
    if (v.kind !== "branch") throw new Error("unreachable");
    expect(v.telecallerIds.sort()).toEqual([MY_TC, THEIR_TC].sort());
    // The manager's own user id is in the list: they take calls too, and a
    // branch report with a hole where the manager should be is wrong.
    expect(v.userIds).toContain(ME);
    expect(v.userIds).toContain(THEM);
    expect(v.userIds).toContain("44444444-4444-4444-8444-444444444444");
  });

  /**
   * THE FALLBACK THAT PREVENTS A SILENT PROMOTION.
   *
   * The org chart is optional and plenty of tenants never fill it in. A
   * manager who holds no seat therefore has an EMPTY subtree, and the tempting
   * reading - "no restriction found, so no restriction" - would hand every
   * unmapped manager the entire tenant the moment the feature shipped.
   */
  it("falls back to a manager's OWN records when they hold no seat", async () => {
    const { client } = fakeClient((sql) =>
      isOwnQuery(sql) ? [{ id: MY_TC }] : [], // branch query returns nothing
    );
    const v = await resolvePeopleVisibility(client, {
      userId: ME,
      ownerRole: "manager",
      viaAdminKey: false,
    });
    expect(v).toEqual({ kind: "own", telecallerId: MY_TC, userId: ME });
    expect(visibilityAllowsTelecaller(v, THEIR_TC)).toBe(false);
  });

  it("only walks reporting lines and seats that are still in force", async () => {
    const { client, log } = fakeClient((sql) =>
      isBranchQuery(sql) ? [{ user_id: THEM, telecaller_id: THEIR_TC }] : [],
    );
    await resolvePeopleVisibility(client, {
      userId: ME,
      ownerRole: "manager",
      viaAdminKey: false,
    });
    const branch = log.find(isBranchQuery) as string;
    // 0177/0178 model seats and reporting lines as effective-dated history.
    // Without these, a manager inherits the branch of a seat they left.
    expect(branch).toContain("pa.end_date IS NULL");
    expect(branch).toContain("pa2.end_date IS NULL");
    expect(branch).toContain("rl.effective_to IS NULL");
  });
});

describe("visibilityAllowsTelecaller / visibilityAllowsUser", () => {
  it("admits everybody under `all`", () => {
    const all: PeopleVisibility = { kind: "all" };
    expect(visibilityAllowsTelecaller(all, STRANGER_TC)).toBe(true);
    expect(visibilityAllowsUser(all, THEM)).toBe(true);
  });

  it("admits only the person themselves under `own`", () => {
    const own: PeopleVisibility = { kind: "own", telecallerId: MY_TC, userId: ME };
    expect(visibilityAllowsTelecaller(own, MY_TC)).toBe(true);
    expect(visibilityAllowsTelecaller(own, THEIR_TC)).toBe(false);
    expect(visibilityAllowsUser(own, ME)).toBe(true);
    expect(visibilityAllowsUser(own, THEM)).toBe(false);
  });

  it("admits only the listed people under `branch`", () => {
    const branch: PeopleVisibility = {
      kind: "branch",
      telecallerIds: [MY_TC, THEIR_TC],
      userIds: [ME, THEM],
    };
    expect(visibilityAllowsTelecaller(branch, THEIR_TC)).toBe(true);
    expect(visibilityAllowsTelecaller(branch, STRANGER_TC)).toBe(false);
    expect(visibilityAllowsUser(branch, THEM)).toBe(true);
  });

  it("admits nobody under an empty own-scope", () => {
    const orphan: PeopleVisibility = { kind: "own", telecallerId: null, userId: null };
    expect(visibilityAllowsTelecaller(orphan, MY_TC)).toBe(false);
    expect(visibilityAllowsUser(orphan, ME)).toBe(false);
  });
});

describe("exportablePeople", () => {
  it("asks for no predicate at all under `all`", async () => {
    const { client, log } = fakeClient(() => []);
    await exportablePeople(client, { userId: ME, ownerRole: "owner", viaAdminKey: false }, {
      kind: "all",
    });
    expect(log[0]).not.toContain("ANY(");
    expect(log[0]).toContain("t.status = 'active'");
  });

  it("binds an EMPTY array for an own-scope with no identity", async () => {
    // So the predicate matches nothing. A `WHERE false` special case would
    // change the query's shape, and an omitted predicate would match
    // everything - which is the bug this exists to prevent.
    const { client, log } = fakeClient(() => []);
    const rows = await exportablePeople(
      client,
      { userId: ME, ownerRole: "telecaller", viaAdminKey: false },
      { kind: "own", telecallerId: null, userId: ME },
    );
    expect(rows).toEqual([]);
    expect(log[0]).toContain("t.id = ANY($1::uuid[])");
  });

  it("marks the caller's own row, so the picker can say `you`", async () => {
    const { client } = fakeClient(() => [
      { id: MY_TC, user_id: ME, display_name: "Me", owner_role: "telecaller" },
      { id: THEIR_TC, user_id: THEM, display_name: "Them", owner_role: "telecaller" },
    ]);
    const rows = await exportablePeople(
      client,
      { userId: ME, ownerRole: "manager", viaAdminKey: false },
      { kind: "branch", telecallerIds: [MY_TC, THEIR_TC], userIds: [ME, THEM] },
    );
    expect(rows.map((r) => [r.displayName, r.isSelf])).toEqual([
      ["Me", true],
      ["Them", false],
    ]);
  });
});

describe("loadPerson", () => {
  it("returns null for an identity that is not active", async () => {
    const { client, log } = fakeClient(() => []);
    expect(await loadPerson(client, THEIR_TC)).toBeNull();
    expect(log[0]).toContain("status = 'active'");
  });

  it("returns the identity and its user, which may be null", async () => {
    const { client } = fakeClient(() => [
      { id: THEIR_TC, user_id: null, display_name: "Handset 7" },
    ]);
    // The common case on a real floor: a paired handset that has never signed
    // in. It is still exportable - calls and leads scope on the identity.
    expect(await loadPerson(client, THEIR_TC)).toEqual({
      telecallerId: THEIR_TC,
      userId: null,
      displayName: "Handset 7",
    });
  });
});
