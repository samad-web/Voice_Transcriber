/**
 * The owner-console persona's row-level scope (migration 0079).
 *
 * WHAT THIS SUITE IS FOR. `ownerScopeFilter` and its two renderings build SQL
 * text, and generated SQL is invisible to the typechecker: a predicate naming
 * the wrong column, or naming the right one and never being applied, compiles
 * cleanly and leaks silently. So the column each object scopes on is pinned
 * here by name, the way crm-scope.spec.ts pins its own.
 *
 * The most important assertions are the negative ones - that an unresolvable
 * identity produces a predicate matching NOTHING rather than one matching
 * everything. That is the difference between a persona seeing an empty list
 * and a persona seeing the whole floor, and it is one `??` away either way.
 */
import {
  OWNER_UNSCOPED,
  type OwnerRecordScope,
  ownerScopeAnd,
  ownerScopeClause,
  ownerScopeFilter,
  ownerScopeLiteral,
  scopeForRole,
} from "./owner-scope";

const TELECALLER = "11111111-2222-3333-4444-555555555555";
const USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOTHING = "00000000-0000-0000-0000-000000000000";

const own = (over: Partial<OwnerRecordScope> = {}): OwnerRecordScope => ({
  role: "telecaller",
  scope: "own",
  userId: USER,
  telecallerId: TELECALLER,
  ...over,
});

describe("scopeForRole", () => {
  it("narrows exactly the two personas that work their own records", () => {
    expect(scopeForRole("telecaller")).toBe("own");
    expect(scopeForRole("sales")).toBe("own");
  });

  it("leaves owner, manager and marketing reading everything", () => {
    // Marketing is the row worth stating: it is unrestricted by SCOPE and
    // restricted by OBJECT instead (no transcripts, no invoices, no inbox).
    // A marketer has nothing assigned to them, so `own` would mean `nothing`.
    expect(scopeForRole("owner")).toBe("all");
    expect(scopeForRole("manager")).toBe("all");
    expect(scopeForRole("marketing")).toBe("all");
  });
});

describe("ownerScopeFilter", () => {
  it("returns null for an unscoped persona, so the query is untouched", () => {
    // Not "returns a predicate that is always true" - null, so an owner's
    // query is byte-for-byte the query it was before personas existed.
    for (const object of ["lead", "call", "deal", "task", "telecaller_stats"] as const) {
      expect([object, ownerScopeFilter(object, OWNER_UNSCOPED)]).toEqual([object, null]);
    }
  });

  it("scopes the productivity rollup on the telecaller identity", () => {
    // Migration 0090. A telecaller opening the productivity page must see their
    // own row and nobody else's - the same defect shape as
    // 13_ROUTE_AND_GUARD_INVENTORY.md finding 3, one table over.
    expect(ownerScopeFilter("telecaller_stats", own(), "s")?.sql).toBe("s.telecaller_id = $?");
  });

  it("scopes a lead on assignment OR attribution, and binds one value to both", () => {
    // THE ASSERTION THIS FILE EXISTS FOR. The worker writes `telecaller_id`
    // and never `assigned_telecaller_id` (apps/worker/src/pipeline/leads.ts),
    // so a lead created from a phone call is unassigned. Scoping on assignment
    // alone would show a telecaller NOTHING - not an under-count, an empty
    // console - for exactly the leads they generated themselves.
    const filter = ownerScopeFilter("lead", own(), "l");
    expect(filter?.sql).toBe(
      "(l.assigned_telecaller_id = $? OR (l.assigned_telecaller_id IS NULL AND l.telecaller_id = $?))",
    );
    // Two placeholders, ONE value - every caller substitutes exactly one
    // parameter no matter which branch the object took.
    expect(filter?.value).toBe(TELECALLER);
  });

  it("scopes a deal on assignment ALONE - no attribution fallback", () => {
    // The deliberate asymmetry with leads: nothing creates a deal from a call,
    // so an unassigned deal belongs to the shared queue rather than to whoever
    // happened to source it.
    const filter = ownerScopeFilter("deal", own(), "d");
    expect(filter?.sql).toBe("d.assigned_telecaller_id = $?");
    expect(filter?.sql).not.toContain("IS NULL");
  });

  it("scopes a call on the write-once telecaller snapshot", () => {
    // 0068's column. There is no assignment concept for a recording and there
    // should not be - who spoke on a call is a fact, not an allocation.
    expect(ownerScopeFilter("call", own(), "c")?.sql).toBe("c.telecaller_id = $?");
  });

  it("scopes a task on the USER, either end of it - matching crm-scope", () => {
    // Tasks are the one object BOTH scope systems own. If they disagreed on
    // the column, the same task would show on the dashboard and vanish from
    // /v1/tasks. crm-scope.ts uses assignee-or-creator; so does this.
    const filter = ownerScopeFilter("task", own(), "t");
    expect(filter?.sql).toBe("(t.assignee_user_id = $? OR t.created_by = $?)");
    expect(filter?.value).toBe(USER);
  });

  it("omits the alias prefix when there is no alias", () => {
    expect(ownerScopeFilter("call", own())?.sql).toBe("telecaller_id = $?");
  });

  describe("an own-scoped persona with no identity", () => {
    it("matches nothing rather than everything", () => {
      // The failure that matters. A telecaller persona not bound to a
      // `telecallers` row has no phone-side records; the safe reading is an
      // empty list, never the whole org's.
      const filter = ownerScopeFilter("lead", own({ telecallerId: null }));
      expect(filter).not.toBeNull();
      expect(filter?.value).toBe(NOTHING);
    });

    it("does the same for a task with no resolvable user", () => {
      expect(ownerScopeFilter("task", own({ userId: null }))?.value).toBe(NOTHING);
    });

    it("still returns a predicate, so the query shape does not change", () => {
      // Not `WHERE false` and not null: a real parameter keeps the bind count
      // and the plan identical regardless of who is asking.
      const bound = ownerScopeFilter("lead", own());
      const unbound = ownerScopeFilter("lead", own({ telecallerId: null }));
      expect(unbound?.sql).toBe(bound?.sql);
    });
  });
});

describe("ownerScopeClause", () => {
  it("renders every placeholder to the same parameter index", () => {
    expect(ownerScopeClause("lead", own(), 3, "l")).toBe(
      "(l.assigned_telecaller_id = $3 OR (l.assigned_telecaller_id IS NULL AND l.telecaller_id = $3))",
    );
  });

  it("is null for an unscoped persona", () => {
    expect(ownerScopeClause("lead", OWNER_UNSCOPED, 2, "l")).toBeNull();
  });
});

describe("ownerScopeLiteral", () => {
  it("inlines the id as a cast uuid literal", () => {
    // For the dashboard's multi-statement batch, which takes no bind
    // parameters at all (owner.controller.ts explains the latency reason).
    expect(ownerScopeLiteral("call", own(), "c")).toBe(`c.telecaller_id = '${TELECALLER}'::uuid`);
  });

  it("refuses to interpolate anything that is not a bare uuid", () => {
    // THE INJECTION GUARD. The value is read from the database and never from
    // a request, so this should be unreachable - but a function that writes
    // SQL text by string substitution must not depend on its caller for that,
    // and the failure mode has to be a lockout rather than a leak.
    const hostile = own({ telecallerId: "' OR 1=1 --" as string });
    const sql = ownerScopeLiteral("call", hostile, "c");
    expect(sql).toBe(`c.telecaller_id = '${NOTHING}'::uuid`);
    expect(sql).not.toContain("1=1");
  });

  it("quotes exactly once - no nested or unbalanced quotes reach the statement", () => {
    const sql = ownerScopeLiteral("call", own(), "c") ?? "";
    expect((sql.match(/'/g) ?? []).length).toBe(2);
  });
});

describe("ownerScopeAnd", () => {
  it("is the empty string for an unscoped persona, so nothing is appended", () => {
    // The form the dashboard's statements splice in directly. Empty means an
    // owner's SQL is unchanged, character for character.
    expect(ownerScopeAnd("lead", OWNER_UNSCOPED, "l")).toBe("");
  });

  it("carries its own conjunction, so no caller has to decide to write AND", () => {
    // Getting that wrong in one of ten statements is precisely the silent leak
    // this module exists to prevent, so the conjunction is not the caller's to
    // remember.
    const fragment = ownerScopeAnd("call", own(), "c");
    expect(fragment.startsWith(" AND ")).toBe(true);
    expect(fragment).toContain(TELECALLER);
  });
});
