import { scopeClause, scopeFilter, UNSCOPED, type CrmRecordScope } from "./crm-scope";

/**
 * `scope: 'owned'` was settable through the API from the day migration 0039
 * shipped and was read by nothing - a role configured to see only its own
 * records saw every record in the tenant. These cases pin the predicate that
 * closed that, including the column each object scopes on, because getting the
 * column wrong is a silent leak rather than an error.
 */

const USER = "33333333-3333-4333-8333-333333333333";
const OWNED: CrmRecordScope = { scope: "owned", userId: USER };

describe("scopeFilter", () => {
  it("returns nothing for an unscoped caller - the SQL is untouched", () => {
    for (const objectType of ["contact", "account", "deal", "task"] as const) {
      expect(scopeFilter(objectType, UNSCOPED)).toBeNull();
      expect(scopeFilter(objectType, { scope: "all", userId: USER })).toBeNull();
    }
  });

  it("scopes contact, account and deal on owner_user_id", () => {
    for (const objectType of ["contact", "account", "deal"] as const) {
      expect(scopeFilter(objectType, OWNED)).toEqual({
        sql: "owner_user_id = $?",
        value: USER,
      });
    }
  });

  it("scopes a task on EITHER end of it", () => {
    // A rep who asked a colleague to do something still needs to see it, and
    // the assignee obviously does - as does anyone else it was shared with and
    // who has not declined it (0135). Narrower than it sounds: it is still only
    // tasks you are actually part of.
    expect(scopeFilter("task", OWNED)).toEqual({
      sql: "(assignee_user_id = $? OR created_by = $? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $? AND ta.status <> 'declined'))",
      value: USER,
    });
  });

  it("applies the table alias to every column it emits", () => {
    expect(scopeFilter("deal", OWNED, "d")?.sql).toBe("d.owner_user_id = $?");
    // Both branches of the task predicate must carry it, or the query is a
    // syntax error the moment two tables are joined.
    expect(scopeFilter("task", OWNED, "t")?.sql).toBe(
      "(t.assignee_user_id = $? OR t.created_by = $? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $? AND ta.status <> 'declined'))",
    );
  });

  it("matches NOTHING rather than everything when a scoped caller has no id", () => {
    // A contradiction the guard should already have refused. The safe reading
    // is an empty list; the dangerous one is treating "no user" as "no filter".
    const broken: CrmRecordScope = { scope: "owned", userId: null };
    const filter = scopeFilter("deal", broken);
    expect(filter).not.toBeNull();
    expect(filter?.value).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("scopeClause", () => {
  it("substitutes the parameter index into every placeholder", () => {
    expect(scopeClause("deal", OWNED, 2)).toBe("owner_user_id = $2");
    // Both task branches take the SAME index - one value, two comparisons.
    expect(scopeClause("task", OWNED, 5, "t")).toBe(
      "(t.assignee_user_id = $5 OR t.created_by = $5 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $5 AND ta.status <> 'declined'))",
    );
  });

  it("returns null when unscoped, so callers can omit the clause entirely", () => {
    expect(scopeClause("contact", UNSCOPED, 2)).toBeNull();
  });

  it("leaves no `$?` behind - an unsubstituted placeholder is a syntax error", () => {
    for (const objectType of ["contact", "account", "deal", "task"] as const) {
      expect(scopeClause(objectType, OWNED, 3)).not.toContain("$?");
    }
  });
});
