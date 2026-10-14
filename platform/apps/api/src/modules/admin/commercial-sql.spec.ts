import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BILLINGS_BY_MONTH_SQL,
  FLEET_COMMERCIAL_SQL,
  FUNNEL_SQL,
  NET_NEW_SQL,
  PLATFORM_INCIDENTS_SQL,
} from "./commercial-sql";

/**
 * THE WIRING AROUND THE COMMERCIAL QUERIES (doc 49 P13c).
 *
 * ── WHAT THIS CATCHES THAT NOTHING ELSE DOES ────────────────────────────────
 *
 * Three layers already cover this screen and none of them covers these:
 *
 *   - `packages/shared/src/commercial.test.ts` tests the ARITHMETIC with a
 *     table of inputs - a trial, a past-due tenant, an unpriced plan.
 *   - `scripts/verify-commercial.js` EXECUTES every query against a real
 *     Postgres, with a five-tenant fixture, and proves the vocabularies match
 *     the CHECK constraints. But it needs Docker, so it is not in CI.
 *   - typecheck sees none of it, because SQL is a string.
 *
 * What is left is the SEAM: the parameter index each query's scope gate is
 * built at has to equal the number of parameters the controller binds before
 * it. Get that wrong and the operator's email lands in the wrong placeholder -
 * a 42P02 if you are lucky, and a filter on the wrong column if you are not.
 * That is one integer, written in two files, and nothing else would notice.
 */

const SRC = __dirname;
const CONTROLLER = readFileSync(join(SRC, "admin-commercial.controller.ts"), "utf8");
const SQL_FILE = readFileSync(join(SRC, "commercial-sql.ts"), "utf8");

/** Every `$n` in a query, as numbers. */
function placeholders(sql: string): number[] {
  return [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
}

/** The highest `$n`, ignoring the gate's own (passed as a literal below). */
function maxPlaceholder(sql: string): number {
  const all = placeholders(sql);
  return all.length === 0 ? 0 : Math.max(...all);
}

describe("the scope gate is bound at the right parameter index", () => {
  /**
   * Each query with the gate rendered as TRUE (no parameter of its own), and
   * the index the controller builds its gate at. The assertion is that the
   * gate's index is exactly one past the query's own parameters - no gap,
   * which would leave an unbound placeholder, and no collision, which would
   * overwrite one.
   */
  const cases = [
    { name: "fleet", sql: FLEET_COMMERCIAL_SQL("TRUE"), gateIndex: 2, own: 1 },
    { name: "billings", sql: BILLINGS_BY_MONTH_SQL("TRUE"), gateIndex: 1, own: 0 },
    { name: "funnel", sql: FUNNEL_SQL("TRUE"), gateIndex: 1, own: 0 },
    { name: "incidents", sql: PLATFORM_INCIDENTS_SQL("TRUE"), gateIndex: 2, own: 1 },
    { name: "net new", sql: NET_NEW_SQL("TRUE"), gateIndex: 1, own: 0 },
  ];

  for (const { name, sql, gateIndex, own } of cases) {
    it(`${name} binds its own ${own} parameter(s), so the gate is $${gateIndex}`, () => {
      expect(maxPlaceholder(sql)).toBe(own);
      expect(gateIndex).toBe(own + 1);
    });
  }

  it("the controller builds each gate at the index this spec asserts", () => {
    // Read out of the controller rather than trusted: the indices above are
    // only meaningful if they are the indices the controller actually uses.
    // Both $2 gates carry the same trailing comment, so one assertion covers
    // the pair; the three $1 gates are named individually.
    expect(CONTROLLER).toContain('operatorScopeSql(scope, "o.id", 2); // $1 = live statuses');
    expect(CONTROLLER.match(/operatorScopeSql\(scope, "o.id", 2\)/g)).toHaveLength(2);
    expect(CONTROLLER).toContain('const billingsGate = operatorScopeSql(scope, "o.id", 1);');
    expect(CONTROLLER).toContain('const funnelGate = operatorScopeSql(scope, "o.id", 1);');
    expect(CONTROLLER).toContain('const netNewGate = operatorScopeSql(scope, "o.id", 1);');
  });

  it("every query's placeholders are contiguous from $1", () => {
    // A gap means an unbound parameter, which Postgres refuses at PREPARE with
    // a message naming the number and nothing else.
    for (const { name, sql, gateIndex } of cases) {
      const used = new Set([...placeholders(sql), gateIndex]);
      const expected = new Set(Array.from({ length: gateIndex }, (_, i) => i + 1));
      expect([name, [...used].sort((a, b) => a - b)]).toEqual([
        name,
        [...expected].sort((a, b) => a - b),
      ]);
    }
  });
});

describe("the queries interpolate nothing but the scope", () => {
  it("has exactly one interpolation per query, and it is the gate", () => {
    // The gate's SQL is interpolated, which is safe only because its own
    // email is a BOUND parameter inside it. A second interpolation anywhere in
    // this file would be the thing to worry about, so there is a test rather
    // than a comment.
    const interpolations = [...SQL_FILE.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!.trim());
    expect([...new Set(interpolations)]).toEqual(["scope"]);
  });

  it("contains no backtick inside an SQL comment", () => {
    // A backtick inside a template literal ENDS it. This has broken two files
    // in this project already, both times in an SQL comment quoting a table
    // name, and both times the error pointed at a line nowhere near it.
    const offending = SQL_FILE.split("\n").filter(
      (line) => /^\s+--/.test(line) && line.includes("`"),
    );
    expect(offending).toEqual([]);
  });
});

describe("the borrowed definitions still match what they were borrowed from", () => {
  it("counts capture minutes over the same window the tenant's own page does", () => {
    // If these two disagree, the operator's screen and the client's invoice
    // are describing different months - and the client is right.
    const owner = readFileSync(
      join(SRC, "../billing/subscription.controller.ts"),
      "utf8",
    );
    const window = "occurred_at >= date_trunc('month', now(), 'UTC')";
    expect(owner).toContain(window);
    expect(SQL_FILE).toContain(window);

    const kinds = "kind IN ('asr_minutes', 'asr_minutes_diarized')";
    expect(SQL_FILE).toContain(kinds);
    // The owner page writes the same two kinds; whitespace differs, so the
    // comparison is on the kinds themselves.
    expect(owner).toContain("'asr_minutes'");
    expect(owner).toContain("'asr_minutes_diarized'");
  });

  it("resolves a live trial plan the way enforcement resolves it", () => {
    // `EFFECTIVE_LIMITS_SQL` is what the worker, the reaper and the owner's
    // plan page all read. A screen that resolved the plan differently would
    // report a tenant as being on a tier they are not being given.
    expect(SQL_FILE).toContain("tp.id = s.trial_plan_id AND s.trial_ends_at > now()");
    expect(SQL_FILE).toContain("COALESCE(tp.id, p.id)");
  });

  it("excludes NO_AUDIO from BOTH halves of the transcription rate", () => {
    // A missed-call log entry has no recording to transcribe. Counting it in
    // the denominator only would report a failure for a call that was never a
    // candidate, and dilute the rate into meaninglessness.
    expect(SQL_FILE).toContain("c.status <> 'NO_AUDIO'");
    expect(SQL_FILE).toContain("c.status = 'COMPLETE'");
  });

  it("sums occurrence_count rather than counting incident tickets", () => {
    // P12 folds a recurring platform failure into ONE ticket with a count, so
    // counting tickets would report a 2,792-call outage as a single incident.
    expect(SQL_FILE).toContain("sum(r.occurrence_count)");
  });

  it("reads what clients owe US from billing_orders, never from invoices", () => {
    // The plan's own source mapping says `invoices` (0176). That table belongs
    // to the tenant's finance module - it has account_id, contact_id, deal_id -
    // and summing it would report our clients' receivables as our cash, wrong
    // in our favour, on a screen somebody makes decisions from.
    expect(SQL_FILE).toContain("FROM billing_orders b");
    expect(SQL_FILE).not.toMatch(/FROM\s+invoices/);
  });
});

describe("the funnel cannot climb", () => {
  it("counts every step over the same CTE of orgs", () => {
    // A step counted over a different population is how a funnel starts going
    // up - which is what a signup-first funnel would do, because an
    // operator-provisioned tenant has no org_signups row.
    const sql = FUNNEL_SQL("TRUE");
    const steps = ["first_call", "first_transcript", "first_lead", "renewed"];
    for (const step of steps) {
      expect(sql).toContain(`AS ${step}`);
    }
    // Four of the five steps are EXISTS/count subqueries over `book`; the
    // fifth is `book` itself.
    expect(sql.match(/FROM book/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps paid-never-provisioned OUT of the funnel", () => {
    // It has no org, so it cannot be scoped and cannot be a step in a funnel
    // whose other steps are all orgs. It is reported beside it.
    const sql = FUNNEL_SQL("TRUE");
    // org_signups is read exactly once, and AFTER the last funnel step, so no
    // step can be counting it. Asserting on a slice up to the alias would
    // include the very subquery that produces it, which is the first version
    // of this test and why it is written this way.
    expect(sql.match(/org_signups/g)?.length).toBe(1);
    expect(sql.indexOf("org_signups")).toBeGreaterThan(sql.indexOf("AS renewed"));
  });
});

describe("the console's root-only control is decided on the server", () => {
  it("returns isRoot from the environment, not from anything the caller sends", () => {
    // Doc 49: a superadmin must not see "Invite a superadmin" AT ALL - absent,
    // not disabled, because "a greyed-out control is an invitation to find out
    // why". That decision cannot be made in the browser.
    expect(CONTROLLER).toContain("isRoot: isRootOperator(req.principal?.operatorEmail ?? null)");
  });
});
