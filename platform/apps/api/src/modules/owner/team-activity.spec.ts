import { OWNER_UNSCOPED, type OwnerRecordScope } from "@aura/shared";
import { buildActivitySql } from "./team-activity.controller";

/**
 * The scope threading on the team-activity statement.
 *
 * ── WHY THIS SPEC EXISTS AND WHAT IT IS REALLY GUARDING ─────────────────────
 *
 * That statement has TEN scoped reads in it - two stage ledgers, completed tasks,
 * open leads, open tasks, the call rollup, the roster, wins, leads created and
 * tasks completed - and every one of them has to carry the persona's predicate.
 * The failure mode is the worst kind this codebase has: a CTE added without its
 * clause does not throw, does not render wrong, and does not look wrong in
 * review. It just returns a colleague's records to a rep, quietly, on a page that
 * otherwise works.
 *
 * "Read it carefully" is not a control over ten clauses. Counting them is. So this
 * spec asserts the COUNT of narrowed reads rather than spot-checking a couple - an
 * eleventh read added without a clause fails here, which is the only place it can
 * fail cheaply. Writing this spec is also what established that the count is ten
 * and not the eight the controller's header first claimed.
 *
 * No database. `buildActivitySql` is pure for exactly this reason.
 */

/** A telecaller: narrowed to their own records, with both identities resolved. */
const OWN: OwnerRecordScope = {
  role: "telecaller",
  scope: "own",
  userId: "11111111-1111-1111-1111-111111111111",
  telecallerId: "22222222-2222-2222-2222-222222222222",
};

/**
 * The load-bearing edge: an own-scoped persona whose telecaller identity could
 * not be resolved. Must match NOTHING, never everything.
 */
const OWN_UNRESOLVED: OwnerRecordScope = {
  role: "telecaller",
  scope: "own",
  userId: null,
  telecallerId: null,
};

const RANGE = ["2026-09-01", "2026-09-30"] as const;

const build = (scope: OwnerRecordScope) => buildActivitySql(RANGE[0], RANGE[1], scope);

/**
 * How many reads must carry a predicate. Ten, and the number is written here on
 * purpose: changing it is the deliberate act of saying a new read is either
 * scoped or does not need to be.
 */
const NARROWED_CTES = 10;

describe("buildActivitySql", () => {
  it("passes the range and the stage threshold as the first three parameters", () => {
    const { params } = build(OWNER_UNSCOPED);
    expect(params.slice(0, 2)).toEqual(["2026-09-01", "2026-09-30"]);
    // The threshold is a number, not text: it reaches make_interval(days => $3).
    expect(typeof params[2]).toBe("number");
  });

  it("adds NOTHING for an owner, so the query is what it was before personas", () => {
    const { sql, params } = build(OWNER_UNSCOPED);
    expect(params).toHaveLength(3);
    expect(sql).not.toContain("assigned_telecaller_id =");
    expect(sql).not.toContain("assignee_user_id = $");
  });

  it("narrows every one of the ten reads for an own-scoped persona", () => {
    const { sql, params } = build(OWN);

    /**
     * Asserted through the PLACEHOLDERS rather than by matching clause text.
     *
     * The first version of this grepped for ` AND <alias>.` and counted 29,
     * because every ordinary predicate in the statement is also an `AND t.`.
     * Counting the scope parameters instead is exact: each helper pushes exactly
     * one parameter and interpolates exactly one index, so "every index from $4 up
     * appears in the SQL" says both that nothing was pushed without being used
     * and that nothing was interpolated without being bound - which is the pair of
     * mistakes that would send a malformed statement or an unscoped one.
     */
    expect(params).toHaveLength(3 + NARROWED_CTES);
    for (let i = 4; i <= 3 + NARROWED_CTES; i++) {
      // The lookahead stops `$1` matching inside `$13`.
      expect(new RegExp(`\\$${i}(?!\\d)`).test(sql)).toBe(true);
    }
    // And nothing beyond the last one, which would be an unbound placeholder.
    expect(new RegExp(`\\$${4 + NARROWED_CTES}(?!\\d)`).test(sql)).toBe(false);
  });

  it("binds one parameter per narrowed read and no identity as text", () => {
    const { sql, params } = build(OWN);
    expect(params).toHaveLength(3 + NARROWED_CTES);
    // Every bound identity is one of the two uuids, never interpolated.
    for (const value of params.slice(3)) {
      expect([OWN.userId, OWN.telecallerId]).toContain(value);
    }
    expect(sql).not.toContain(OWN.telecallerId!);
    expect(sql).not.toContain(OWN.userId!);
  });

  it("scopes leads on the telecaller and tasks on the user - they are different columns", () => {
    const { sql, params } = build(OWN);
    // Leads take the union of assignment and attribution (see leadHeldBy).
    expect(sql).toContain("l.assigned_telecaller_id = $");
    expect(sql).toContain("l.telecaller_id = $");
    // A task belongs to a login, and to its creator as well as its assignee.
    expect(sql).toContain("t.assignee_user_id = $");
    expect(sql).toContain("t.created_by = $");
    // Both identities are actually bound, not just one of them twice.
    expect(params).toContain(OWN.telecallerId);
    expect(params).toContain(OWN.userId);
  });

  it("narrows the ROSTER too, not only the records hanging off it", () => {
    // Without this, a rep reads their own leads and tasks - and a list of every
    // colleague's name, with their call counts, in the workload matrix.
    expect(build(OWN).sql).toContain("tc.id = $");
    expect(build(OWNER_UNSCOPED).sql).not.toContain("tc.id = $");
  });

  it("binds a never-matching id when an own-scoped persona has no identity", () => {
    const { params } = build(OWN_UNRESOLVED);
    expect(params).toHaveLength(3 + NARROWED_CTES);
    // An empty page beats everyone's page. The shape is unchanged - same clause
    // count, same parameter count - so the query plan does not vary by caller.
    for (const value of params.slice(3)) {
      expect(value).toBe("00000000-0000-0000-0000-000000000000");
    }
  });

  it("caps each ledger before the union, so one chatty ledger cannot crowd out the others", () => {
    const { sql } = build(OWNER_UNSCOPED);
    // Three inner caps plus the one on the merged result. Matched on the feed's
    // own limit rather than on /LIMIT \d+/, which also catches the `LIMIT 1` that
    // reads the single organizations row.
    expect(sql.match(/LIMIT 200/g) ?? []).toHaveLength(4);
  });

  it("keeps the workload matrix un-windowed and the leaderboard windowed", () => {
    const { sql } = build(OWNER_UNSCOPED);
    // The matrix is a snapshot of now: its open-lead read must not reference the
    // window CTE, or "who is overloaded" silently becomes "who was given work".
    const matrix = section(sql, "open_leads AS (", "),\n-- Open tasks per PERSON");
    expect(matrix).not.toContain("w.from_at");
    // The board is the opposite: every figure on it is "in this range".
    const wins = section(sql, "wins_in_range AS (", "),\nleads_in_range");
    expect(wins).toContain("w.from_at");
  });
});

/** The text between two markers, for asserting about one CTE at a time. */
function section(sql: string, open: string, close: string): string {
  const start = sql.indexOf(open);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf(close, start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}
