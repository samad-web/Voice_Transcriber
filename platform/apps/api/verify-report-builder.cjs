/*
 * Runs every CRM source's compiled SQL, and every seeded starter template's
 * widget queries, against the real development database.
 *
 * Exists because generated SQL is invisible to `tsc`: the query compiler is
 * unit-tested on the TEXT it produces (query-compiler.spec.ts), and that proves
 * the whitelist holds but not that `LEFT JOIN LATERAL ... FILTER (WHERE ...)`
 * is something Postgres will actually accept against these tables.
 *
 * Read-only. Every statement is a SELECT inside a transaction that is rolled
 * back, so it can be run against any database whose schema is current.
 *
 *   node apps/api/verify-report-builder.cjs
 */
const { Client } = require("pg");
const { CRM_SOURCES, crmSource, crmSourceSchema } = require("./dist/modules/report-builder/crm-sources");
const { compileCrmQuery, compileUploadQuery } = require("./dist/modules/report-builder/query-compiler");
const shared = require("@aura/shared");

const UNSCOPED = { scope: "all", userId: null };
const OWNED = { scope: "owned", userId: "00000000-0000-4000-8000-0000000000aa" };

let pass = 0;
let fail = 0;
const failures = [];

function ok(label) {
  pass++;
  console.log(`  ok   ${label}`);
}
function bad(label, err) {
  fail++;
  failures.push(`${label}: ${err}`);
  console.log(`  FAIL ${label}\n       ${String(err).split("\n")[0]}`);
}

async function run(client, label, compiled) {
  // A SAVEPOINT per statement. Without it the first failure aborts the whole
  // transaction and every later check reports "current transaction is aborted"
  // - which hides how many things are actually broken behind the first one.
  await client.query("SAVEPOINT s");
  try {
    await client.query(compiled.sql, compiled.params);
    await client.query("RELEASE SAVEPOINT s");
    ok(label);
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s");
    bad(label, err.message);
  }
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString: url });
  await client.connect();

  const { rows: orgs } = await client.query(
    "SELECT id FROM organizations WHERE status = 'active' ORDER BY created_at LIMIT 1",
  );
  const orgId = orgs[0]?.id;
  if (!orgId) throw new Error("no active org in this database");

  // Everything below runs inside one transaction that is rolled back at the
  // end, and sets app.org_id so RLS behaves exactly as it does in a request.
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

  console.log(`\nCRM sources (org ${orgId})`);
  for (const source of CRM_SOURCES) {
    const columns = crmSourceSchema(source);
    const dimension = columns.find((c) => c.type === "categorical");
    const temporal = columns.find((c) => c.type === "temporal");
    const measure = columns.find((c) => c.type === "numeric");

    // 1. group by a category, count rows
    if (dimension) {
      await run(
        client,
        `${source.key}: count by ${dimension.name}`,
        compileCrmQuery(
          source,
          {
            dimensions: [{ column: dimension.name }],
            measures: [{ agg: "count", alias: "Count" }],
            filters: [],
            derived: [],
            sort: { key: "Count", direction: "desc" },
          },
          orgId,
          UNSCOPED,
        ),
      );
    }

    // 2. sum a measure over a month bucket - exercises to_char(date_trunc(...))
    if (temporal && measure) {
      await run(
        client,
        `${source.key}: sum ${measure.name} by month of ${temporal.name}`,
        compileCrmQuery(
          source,
          {
            dimensions: [{ column: temporal.name, bucket: "month" }],
            measures: [{ column: measure.name, agg: "sum", alias: "Total" }],
            filters: [],
            derived: [],
            sort: { key: temporal.name, direction: "asc" },
          },
          orgId,
          UNSCOPED,
        ),
      );
    }

    // 3. every aggregation over every numeric column - the widest net for a
    //    column expression that is valid TypeScript and invalid SQL.
    for (const column of columns.filter((c) => c.type === "numeric")) {
      await run(
        client,
        `${source.key}: avg+min+max ${column.name}`,
        compileCrmQuery(
          source,
          {
            dimensions: [],
            measures: [
              { column: column.name, agg: "avg", alias: "a" },
              { column: column.name, agg: "min", alias: "b" },
              { column: column.name, agg: "max", alias: "c" },
              { column: column.name, agg: "count_distinct", alias: "d" },
            ],
            filters: [],
            derived: [],
          },
          orgId,
          UNSCOPED,
        ),
      );
    }

    // 4. every categorical/temporal column as a GROUP BY, one at a time
    for (const column of columns.filter((c) => c.type !== "numeric")) {
      await run(
        client,
        `${source.key}: group by ${column.name}`,
        compileCrmQuery(
          source,
          {
            dimensions: [{ column: column.name }],
            measures: [{ agg: "count", alias: "n" }],
            filters: [],
            derived: [],
            limit: 5,
          },
          orgId,
          UNSCOPED,
        ),
      );
    }

    // 5. a FILTER-ed measure plus a filtered query - the win-rate shape
    if (dimension) {
      await run(
        client,
        `${source.key}: filtered aggregate + where`,
        compileCrmQuery(
          source,
          {
            dimensions: [{ column: dimension.name }],
            measures: [
              { agg: "count", alias: "total" },
              {
                agg: "count",
                alias: "matching",
                where: { column: dimension.name, op: "not_null" },
              },
            ],
            filters: [{ column: dimension.name, op: "not_null" }],
            derived: [],
          },
          orgId,
          UNSCOPED,
        ),
      );
    }

    // 6. the owned-scope predicate, where the source has one
    if (source.ownerSql) {
      await run(
        client,
        `${source.key}: owned scope`,
        compileCrmQuery(
          source,
          { dimensions: [], measures: [{ agg: "count", alias: "n" }], filters: [], derived: [] },
          orgId,
          OWNED,
        ),
      );
    } else {
      try {
        compileCrmQuery(
          source,
          { dimensions: [], measures: [{ agg: "count", alias: "n" }], filters: [], derived: [] },
          orgId,
          OWNED,
        );
        bad(`${source.key}: owned scope must be refused`, "it was allowed");
      } catch {
        ok(`${source.key}: owned scope correctly refused`);
      }
    }
  }

  // ── the uploaded-dataset path ────────────────────────────────────────────
  console.log("\nUploaded datasets (jsonb row store)");
  const uploadColumns = [
    { name: "region", type: "categorical" },
    { name: "revenue", type: "numeric" },
    { name: "closed", type: "temporal" },
    { name: "active", type: "boolean" },
  ];
  const fakeDataset = "00000000-0000-4000-8000-0000000000ff";
  await run(
    client,
    "upload: group + sum + bucket",
    compileUploadQuery(
      uploadColumns,
      {
        dimensions: [{ column: "closed", bucket: "month" }],
        measures: [{ column: "revenue", agg: "sum", alias: "Revenue" }],
        filters: [{ column: "region", op: "contains", value: "so%uth" }],
        derived: [],
        sort: { key: "Revenue", direction: "desc" },
      },
      orgId,
      fakeDataset,
    ),
  );
  await run(
    client,
    "upload: boolean cast + in-list",
    compileUploadQuery(
      uploadColumns,
      {
        dimensions: [{ column: "active" }],
        measures: [{ agg: "count", alias: "n" }],
        filters: [{ column: "region", op: "in", value: ["north", "south"] }],
        derived: [],
      },
      orgId,
      fakeDataset,
    ),
  );

  // ── the seeded starter templates ─────────────────────────────────────────
  console.log("\nSeeded starter templates");
  const { rows: templates } = await client.query(
    "SELECT key, name, doc, dataset_roles FROM report_templates WHERE org_id IS NULL ORDER BY sort_order",
  );

  for (const template of templates) {
    const parsed = shared.ReportDoc.safeParse(template.doc);
    if (!parsed.success) {
      bad(`${template.key}: document schema`, JSON.stringify(parsed.error.issues[0]));
      continue;
    }
    ok(`${template.key}: document parses`);

    const roleToSource = {};
    for (const role of template.dataset_roles) {
      if (role.suggestedSourceKey) roleToSource[role.role] = role.suggestedSourceKey;
    }

    for (const page of parsed.data.pages) {
      for (const widget of page.widgets) {
        if (!widget.query || !widget.datasetRole) continue;
        const sourceKey = roleToSource[widget.datasetRole];
        const source = sourceKey ? crmSource(sourceKey) : null;
        if (!source) {
          bad(
            `${template.key}/${widget.id}`,
            `role "${widget.datasetRole}" has no CRM source behind it`,
          );
          continue;
        }
        await client.query("SAVEPOINT w");
        try {
          const compiled = compileCrmQuery(source, widget.query, orgId, UNSCOPED);
          const result = await client.query(compiled.sql, compiled.params);
          await client.query("RELEASE SAVEPOINT w");
          // Also run the post-processing the service applies, so a derived
          // field naming a measure that does not exist is caught here too.
          const derived = shared.applyDerived(result.rows, widget.query.derived ?? []);
          const measureKeys = [
            ...compiled.measureKeys,
            ...(widget.query.derived ?? []).map((d) => d.alias),
          ];
          shared.applyTopN(derived, widget.query.topN, compiled.dimensionKeys, measureKeys);
          ok(`${template.key}/${widget.id} (${widget.title ?? widget.type}) -> ${result.rows.length} rows`);
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT w").catch(() => {});
          bad(`${template.key}/${widget.id} (${widget.title ?? widget.type})`, err.message);
        }
      }
    }
  }

  await client.query("ROLLBACK");
  await client.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
