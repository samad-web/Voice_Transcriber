import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { ColumnMeta, QuerySpec } from "@aura/shared";
import { UNSCOPED, type CrmRecordScope } from "../../common/crm-scope";
import { CRM_SOURCES, crmSource } from "./crm-sources";
import { compileCrmQuery, compileUploadQuery } from "./query-compiler";

/**
 * The compiler is the one place in this feature where a wrong answer is a
 * SECURITY answer rather than a cosmetic one, so these tests are written as
 * claims about the SQL text rather than about a result set.
 *
 * The claim being defended throughout: no caller-supplied string ever reaches
 * the statement as an identifier. Every "unknown column" case below is that
 * claim under a different disguise.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";

const deals = () => {
  const source = crmSource("deals");
  if (!source) throw new Error("the deals source has been renamed - update these tests");
  return source;
};

const spec = (over: Partial<QuerySpec> = {}): QuerySpec => ({
  dimensions: [],
  measures: [],
  filters: [],
  derived: [],
  ...over,
});

const owned: CrmRecordScope = { scope: "owned", userId: USER };

// ── the whitelist ──────────────────────────────────────────────────────────

describe("column whitelisting", () => {
  it("compiles a known column to its catalogue expression", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({
        dimensions: [{ column: "stage" }],
        measures: [{ column: "amount", agg: "sum", alias: "Value" }],
      }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("t.stage");
    expect(compiled.sql).toContain("sum(t.amount)");
  });

  it("rejects a column that is not in the catalogue", () => {
    expect(() =>
      compileCrmQuery(deals(), spec({ dimensions: [{ column: "notes" }] }), ORG, UNSCOPED),
    ).toThrow(BadRequestException);
  });

  it("rejects a SQL fragment posing as a column name", () => {
    for (const attempt of [
      "amount; DROP TABLE deals",
      "amount) , (SELECT password FROM users",
      "t.amount",
      '"amount"',
      "*",
    ]) {
      expect(
        () => compileCrmQuery(deals(), spec({ dimensions: [{ column: attempt }] }), ORG, UNSCOPED),
        // Named so a failure says WHICH disguise got through.
      ).toThrow(/Unknown column/u);
    }
  });

  it("rejects a fragment in a FILTER column too", () => {
    expect(() =>
      compileCrmQuery(
        deals(),
        spec({
          measures: [{ agg: "count", alias: "n" }],
          filters: [{ column: "1=1 OR t.org_id<>", op: "eq", value: "x" }],
        }),
        ORG,
        UNSCOPED,
      ),
    ).toThrow(/Unknown column/u);
  });

  it("rejects a fragment in a MEASURE column too", () => {
    expect(() =>
      compileCrmQuery(
        deals(),
        spec({ measures: [{ column: "amount) FROM users --", agg: "sum", alias: "x" }] }),
        ORG,
        UNSCOPED,
      ),
    ).toThrow(/Unknown column/u);
  });

  it("rejects a sort key that is not in its own result", () => {
    expect(() =>
      compileCrmQuery(
        deals(),
        spec({
          measures: [{ agg: "count", alias: "n" }],
          sort: { key: 'n" DESC, (SELECT 1) --', direction: "desc" },
        }),
        ORG,
        UNSCOPED,
      ),
    ).toThrow(/Cannot sort by/u);
  });

  it("rejects an output alias containing a quote", () => {
    // Aliases ARE caller-supplied and are quoted into the SELECT list, so this
    // is the one string that could break out if it were trusted.
    expect(() =>
      compileCrmQuery(
        deals(),
        spec({ measures: [{ agg: "count", alias: 'n" , (SELECT 1) AS "x' }] }),
        ORG,
        UNSCOPED,
      ),
    ).toThrow(/not a usable column heading/u);
  });

  it("allows the punctuation a real column heading uses", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ measures: [{ agg: "count", alias: "Won deals (last 30d)" }] }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain('AS "Won deals (last 30d)"');
  });
});

// ── parameters ─────────────────────────────────────────────────────────────

describe("parameterisation", () => {
  it("puts every filter VALUE in a parameter, never in the text", () => {
    const secret = "O'Brien & Co";
    const compiled = compileCrmQuery(
      deals(),
      spec({
        measures: [{ agg: "count", alias: "n" }],
        filters: [{ column: "account_name", op: "eq", value: secret }],
      }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).not.toContain(secret);
    expect(compiled.params).toContain(secret);
  });

  it("keeps placeholders and parameters in step across mixed operators", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({
        measures: [{ agg: "count", alias: "n" }],
        filters: [
          { column: "stage", op: "eq", value: "won" },
          { column: "amount", op: "between", value: [10, 20] },
          { column: "status", op: "in", value: ["open", "won"] },
          { column: "owner_name", op: "is_null" },
          { column: "account_name", op: "contains", value: "acme" },
        ],
      }),
      ORG,
      UNSCOPED,
    );
    const highest = Math.max(...[...compiled.sql.matchAll(/\$(\d+)/gu)].map((m) => Number(m[1])));
    expect(highest).toBe(compiled.params.length);
  });

  it("escapes LIKE wildcards into the parameter so a literal % matches a literal %", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({
        measures: [{ agg: "count", alias: "n" }],
        filters: [{ column: "name", op: "contains", value: "50%" }],
      }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.params).toContain("%50\\%%");
  });

  it("uses one array parameter for `in` rather than N placeholders", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({
        measures: [{ agg: "count", alias: "n" }],
        filters: [{ column: "stage", op: "in", value: ["a", "b", "c"] }],
      }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("= ANY(");
    expect(compiled.params.at(-1)).toEqual(["a", "b", "c"]);
  });

  it("refuses a non-numeric value against a numeric column", () => {
    expect(() =>
      compileCrmQuery(
        deals(),
        spec({
          measures: [{ agg: "count", alias: "n" }],
          filters: [{ column: "amount", op: "gt", value: "lots" }],
        }),
        ORG,
        UNSCOPED,
      ),
    ).toThrow(/is not a number/u);
  });
});

// ── tenancy and record scope ───────────────────────────────────────────────

describe("tenant and record scoping", () => {
  it("always pins the org, as the first parameter", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ measures: [{ agg: "count", alias: "n" }] }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("t.org_id = $1");
    expect(compiled.params[0]).toBe(ORG);
  });

  it("adds the owner predicate for an `owned` grant", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ measures: [{ agg: "count", alias: "n" }] }),
      ORG,
      owned,
    );
    expect(compiled.sql).toContain("t.owner_user_id = $");
    expect(compiled.params).toContain(USER);
  });

  it("adds NO owner predicate for an `all` grant", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ measures: [{ agg: "count", alias: "n" }] }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).not.toContain("owner_user_id =");
  });

  it("REFUSES rather than widening when a source cannot express `owned`", () => {
    // The whole point of crm-sources.ts's `ownerSql: null` on `leads`. Running
    // unscoped here would hand a restricted rep the tenant's entire enquiry
    // stream through a chart - a silent, total scope bypass.
    const leads = crmSource("leads");
    expect(leads?.ownerSql).toBeNull();
    expect(() =>
      compileCrmQuery(leads!, spec({ measures: [{ agg: "count", alias: "n" }] }), ORG, owned),
    ).toThrow(ForbiddenException);
  });

  it("substitutes the same parameter into BOTH halves of the tasks predicate", () => {
    const tasks = crmSource("tasks");
    const compiled = compileCrmQuery(
      tasks!,
      spec({ measures: [{ agg: "count", alias: "n" }] }),
      ORG,
      owned,
    );
    // One user id, two comparisons - a second parameter here would shift every
    // placeholder after it.
    expect(compiled.params.filter((p) => p === USER)).toHaveLength(1);
    expect(compiled.sql).toContain("assignee_user_id");
    expect(compiled.sql).toContain("created_by");
  });

  it("matches nothing rather than everything when a scoped grant has no user", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ measures: [{ agg: "count", alias: "n" }] }),
      ORG,
      { scope: "owned", userId: null },
    );
    expect(compiled.params).toContain("00000000-0000-0000-0000-000000000000");
  });
});

// ── aggregation semantics ──────────────────────────────────────────────────

describe("aggregation", () => {
  it("refuses to sum a text column", () => {
    expect(() =>
      compileCrmQuery(
        deals(),
        spec({ measures: [{ column: "stage", agg: "sum", alias: "x" }] }),
        ORG,
        UNSCOPED,
      ),
    ).toThrow(/cannot be sum'd/u);
  });

  it("allows count_distinct on a text column", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ measures: [{ column: "stage", agg: "count_distinct", alias: "Stages" }] }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("count(DISTINCT t.stage)");
  });

  it("coalesces sum and count to zero", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ measures: [{ column: "amount", agg: "sum", alias: "v" }] }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("COALESCE(sum(t.amount), 0)");
  });

  it("does NOT coalesce avg - an average over no rows is unknown, not zero", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ measures: [{ column: "amount", agg: "avg", alias: "v" }] }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("avg(t.amount)");
    expect(compiled.sql).not.toContain("COALESCE(avg");
  });

  it("compiles a per-measure filter to a FILTER clause", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({
        measures: [
          { agg: "count", alias: "total" },
          { agg: "count", alias: "won", where: { column: "status", op: "eq", value: "won" } },
        ],
      }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("FILTER (WHERE t.status = $");
  });

  it("rejects an aggregation with nothing to aggregate", () => {
    expect(() =>
      compileCrmQuery(deals(), spec({ measures: [{ agg: "sum", alias: "x" }] }), ORG, UNSCOPED),
    ).toThrow(/needs a column/u);
  });

  it("rejects a query with neither a column nor a measure", () => {
    expect(() => compileCrmQuery(deals(), spec(), ORG, UNSCOPED)).toThrow(
      /at least one column or one measure/u,
    );
  });
});

// ── time bucketing ─────────────────────────────────────────────────────────

describe("time buckets", () => {
  it("emits a TEXT bucket, never a raw timestamp", () => {
    // node-postgres parses a timestamptz at the server's local midnight and
    // JSON emits UTC, so a raw bucket goes out a day early on any host east of
    // Greenwich. This exact bug already bit tasks.due_on.
    const compiled = compileCrmQuery(
      deals(),
      spec({
        dimensions: [{ column: "created_at", bucket: "month" }],
        measures: [{ agg: "count", alias: "n" }],
      }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("to_char(date_trunc('month', t.created_at), 'YYYY-MM')");
  });

  it("refuses to bucket a non-date column", () => {
    expect(() =>
      compileCrmQuery(
        deals(),
        spec({
          dimensions: [{ column: "stage", bucket: "month" }],
          measures: [{ agg: "count", alias: "n" }],
        }),
        ORG,
        UNSCOPED,
      ),
    ).toThrow(/is not a date/u);
  });
});

// ── limits ─────────────────────────────────────────────────────────────────

describe("row caps", () => {
  it("caps an unbounded query at MAX_RESULT_ROWS", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ dimensions: [{ column: "name" }] }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("LIMIT 5000");
  });

  it("honours a smaller explicit limit", () => {
    const compiled = compileCrmQuery(
      deals(),
      spec({ dimensions: [{ column: "name" }], limit: 25 }),
      ORG,
      UNSCOPED,
    );
    expect(compiled.sql).toContain("LIMIT 25");
  });
});

// ── uploaded datasets ──────────────────────────────────────────────────────

describe("uploaded datasets", () => {
  const columns: ColumnMeta[] = [
    { name: "region", type: "categorical" },
    { name: "revenue", type: "numeric" },
    { name: "closed", type: "temporal" },
  ];

  it("casts a numeric jsonb field so it sums as a number", () => {
    const compiled = compileUploadQuery(
      columns,
      spec({
        dimensions: [{ column: "region" }],
        measures: [{ column: "revenue", agg: "sum", alias: "Revenue" }],
      }),
      ORG,
      DATASET,
    );
    expect(compiled.sql).toContain("NULLIF((r.data->>'revenue'), '')::numeric");
  });

  it("pins both the org and the dataset", () => {
    const compiled = compileUploadQuery(
      columns,
      spec({ measures: [{ agg: "count", alias: "n" }] }),
      ORG,
      DATASET,
    );
    expect(compiled.sql).toContain("r.org_id = $1 AND r.dataset_id = $2");
    expect(compiled.params.slice(0, 2)).toEqual([ORG, DATASET]);
  });

  it("rejects a column that is not in the stored schema", () => {
    expect(() =>
      compileUploadQuery(columns, spec({ dimensions: [{ column: "salary" }] }), ORG, DATASET),
    ).toThrow(/Unknown column/u);
  });

  it("drops a stored header that could close the jsonb key literal", () => {
    // Headers are stored data rather than request data, but this is the one
    // place a stored string becomes SQL text, so it is checked at the boundary.
    const hostile: ColumnMeta[] = [{ name: "a' || (SELECT 1) || '", type: "categorical" }];
    expect(() =>
      compileUploadQuery(
        hostile,
        spec({ dimensions: [{ column: "a' || (SELECT 1) || '" }] }),
        ORG,
        DATASET,
      ),
    ).toThrow(/Unknown column/u);
  });
});

// ── the catalogue itself ───────────────────────────────────────────────────

describe("CRM source catalogue", () => {
  it("gives every source a unique key", () => {
    const keys = CRM_SOURCES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every source's columns unique names", () => {
    for (const source of CRM_SOURCES) {
      const names = source.columns.map((c) => c.name);
      expect([source.key, new Set(names).size]).toEqual([source.key, names.length]);
    }
  });

  it("pins every source to the org, so RLS is never the only boundary", () => {
    for (const source of CRM_SOURCES) {
      expect([source.key, source.where.includes("org_id = $1")]).toEqual([source.key, true]);
    }
  });

  it("uses `$?` (not `$1`) in every owner predicate", () => {
    // A hardcoded index here would collide with the org parameter and filter
    // deals by the ORG id as if it were a user id - a query that runs, returns
    // nothing, and looks like an empty pipeline.
    for (const source of CRM_SOURCES) {
      if (!source.ownerSql) continue;
      expect([source.key, source.ownerSql.includes("$?")]).toEqual([source.key, true]);
      expect([source.key, /\$\d/u.test(source.ownerSql)]).toEqual([source.key, false]);
    }
  });

  it("declares date columns RAW, leaving the text cast to the compiler", () => {
    // This used to assert the opposite - that `tasks.due_on` was wrapped in
    // to_char inside the catalogue - and that was a real bug caught by running
    // the SQL: a to_char'd column is TEXT, so `date_trunc('month', ...)` on it
    // threw "function date_trunc(unknown, text) does not exist" and every trend
    // chart over a due date was a 500.
    //
    // The invariant is now the right way round: sources declare columns, the
    // compiler decides how they are read. The two tests below pin both halves.
    for (const source of CRM_SOURCES) {
      for (const column of source.columns) {
        if (column.type !== "temporal") continue;
        expect([`${source.key}.${column.name}`, column.sql.includes("to_char")]).toEqual([
          `${source.key}.${column.name}`,
          false,
        ]);
      }
    }
  });

  it("emits every temporal dimension as TEXT, bucketed or not", () => {
    // The day-early bug in one sentence: node-postgres parses a date at the
    // SERVER's local midnight and JSON emits UTC, so on a +05:30 host
    // `2026-08-01` leaves as `2026-07-31T18:30:00Z`. Text cannot have it.
    const tasks = crmSource("tasks")!;

    const unbucketed = compileCrmQuery(
      tasks,
      spec({ dimensions: [{ column: "due_on" }], measures: [{ agg: "count", alias: "n" }] }),
      ORG,
      UNSCOPED,
    );
    expect(unbucketed.sql).toContain("to_char(t.due_on, 'YYYY-MM-DD')");

    const bucketed = compileCrmQuery(
      tasks,
      spec({
        dimensions: [{ column: "due_on", bucket: "month" }],
        measures: [{ agg: "count", alias: "n" }],
      }),
      ORG,
      UNSCOPED,
    );
    expect(bucketed.sql).toContain("to_char(date_trunc('month', t.due_on), 'YYYY-MM')");
  });

});
