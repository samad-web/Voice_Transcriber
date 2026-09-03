/*
 * End-to-end exercise of the Report Builder against a running API.
 *
 * Walks the acceptance criteria that only a live request can prove: upload ->
 * schema inference -> aggregate + filter + derived field -> re-upload with a
 * changed column -> drift flagged -> template reuse -> schedule validation.
 *
 * Everything it creates is named `E2E ...` and deleted at the end.
 *
 *   node apps/api/e2e-report-builder.cjs
 */
const API = process.env.API_URL || "http://localhost:4000";
const ORG = process.env.E2E_ORG;
const USER = process.env.E2E_USER;
const KEY = process.env.ADMIN_API_KEY || "dev-admin-key";

if (!ORG || !USER) throw new Error("E2E_ORG and E2E_USER are required");

const headers = {
  "content-type": "application/json",
  "x-admin-key": KEY,
  "x-org-id": ORG,
  "x-caller-user-id": USER,
};

let pass = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, text };
}

const REGIONS = ["North", "South", "East", "West"];
function buildRows(count, { renameRevenue = false } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const row = {
      region: REGIONS[i % 4],
      rep: `Rep ${i % 7}`,
      closed: new Date(Date.UTC(2026, i % 6, (i % 27) + 1)).toISOString().slice(0, 10),
      invoice_no: `INV-${i}`,
    };
    row[renameRevenue ? "net_revenue" : "revenue"] = String(((i * 37) % 9000) + 500);
    rows.push(row);
  }
  return rows;
}
const HEADERS_V1 = ["region", "rep", "revenue", "closed", "invoice_no"];
const HEADERS_V2 = ["region", "rep", "net_revenue", "closed", "invoice_no"];

(async () => {
  const created = { datasets: [], reports: [] };

  try {
    // ── upload ──────────────────────────────────────────────────────────
    console.log("\nUpload & schema inference");
    const rows = buildRows(1200);
    const up = await call("POST", "/v1/report-datasets", {
      kind: "upload",
      name: `E2E sales ${Date.now()}`,
      headers: HEADERS_V1,
      rows,
    });
    check("1,200-row upload accepted", up.status === 201, up.text.slice(0, 200));
    const dataset = up.body.dataset;
    if (!dataset) throw new Error("no dataset returned");
    created.datasets.push(dataset.id);

    const byName = Object.fromEntries(dataset.columns.map((c) => [c.name, c.type]));
    console.log(`       inferred: ${JSON.stringify(byName)}`);
    check("revenue inferred numeric", byName.revenue === "numeric");
    check("closed inferred temporal", byName.closed === "temporal");
    check("region inferred categorical", byName.region === "categorical");
    check("invoice_no inferred identifier, not numeric", byName.invoice_no === "identifier");

    // ── AC6: aggregate + filter + derived, server-side ───────────────────
    console.log("\nAC6: aggregation, filter and a calculated field");
    const agg = await call("POST", `/v1/report-datasets/${dataset.id}/query`, {
      dimensions: [{ column: "region" }],
      measures: [
        { column: "revenue", agg: "sum", alias: "Revenue" },
        { agg: "count", alias: "Deals" },
      ],
      filters: [{ column: "revenue", op: "gte", value: "2000" }],
      derived: [{ alias: "Avg", op: "div", left: "Revenue", right: "Deals" }],
      sort: { key: "Revenue", direction: "desc" },
    });
    check("aggregate query succeeded", !agg.body.error, agg.text.slice(0, 200));
    check("returns one row per region, not 1,200 rows", agg.body.rows?.length === 4,
      `got ${agg.body.rows?.length}`);
    check("derived field computed", typeof agg.body.rows?.[0]?.Avg === "number");
    console.log(`       ${JSON.stringify(agg.body.rows)}`);

    // The filter must actually have bitten - compare against no filter.
    const unfiltered = await call("POST", `/v1/report-datasets/${dataset.id}/query`, {
      dimensions: [],
      measures: [{ agg: "count", alias: "n" }],
      filters: [],
      derived: [],
    });
    const filtered = await call("POST", `/v1/report-datasets/${dataset.id}/query`, {
      dimensions: [],
      measures: [{ agg: "count", alias: "n" }],
      filters: [{ column: "revenue", op: "gte", value: "2000" }],
      derived: [],
    });
    check(
      "the filter changes the total (applied before aggregation)",
      Number(filtered.body.rows[0].n) < Number(unfiltered.body.rows[0].n) &&
        Number(unfiltered.body.rows[0].n) === 1200,
      `${filtered.body.rows[0].n} of ${unfiltered.body.rows[0].n}`,
    );

    // ── AC8: a month bucket over the whole file ──────────────────────────
    console.log("\nAC8: 1,200 rows aggregated server-side");
    const trend = await call("POST", `/v1/report-datasets/${dataset.id}/query`, {
      dimensions: [{ column: "closed", bucket: "month" }],
      measures: [{ column: "revenue", agg: "sum", alias: "Revenue" }],
      filters: [],
      derived: [],
      sort: { key: "closed", direction: "asc" },
    });
    check("month bucket returns 6 rows for 1,200 source rows", trend.body.rows?.length === 6,
      `got ${trend.body.rows?.length}`);
    check(
      "date buckets are TEXT, not a day-early timestamp",
      typeof trend.body.rows?.[0]?.closed === "string" &&
        /^\d{4}-\d{2}$/.test(trend.body.rows[0].closed),
      JSON.stringify(trend.body.rows?.[0]),
    );
    console.log(`       ${JSON.stringify(trend.body.rows)}`);

    // ── a report over the uploaded data ──────────────────────────────────
    console.log("\nA report bound to the upload");
    const report = await call("POST", "/v1/report-builder", { name: `E2E upload report ${Date.now()}` });
    created.reports.push(report.body.report.id);
    const rid = report.body.report.id;

    const doc = {
      version: 1,
      theme: { preset: "executive", paletteId: "corporate-navy" },
      pages: [
        {
          id: "p1",
          name: "Sales",
          filters: [],
          widgets: [
            {
              id: "w1",
              type: "chart",
              chart: "bar",
              title: "Revenue by region",
              layout: { x: 0, y: 0, w: 6, h: 8 },
              datasetId: dataset.id,
              options: {},
              respondsToPageFilters: true,
              query: {
                dimensions: [{ column: "region" }],
                measures: [{ column: "revenue", agg: "sum", alias: "Revenue" }],
                filters: [],
                derived: [],
                sort: { key: "Revenue", direction: "desc" },
              },
            },
          ],
        },
      ],
    };
    const saved = await call("PATCH", `/v1/report-builder/${rid}`, { revision: 0, doc });
    check("autosave accepted with the right revision", saved.status === 200, saved.text.slice(0, 200));

    const stale = await call("PATCH", `/v1/report-builder/${rid}`, { revision: 0, doc });
    check("a stale revision is rejected 409, not silently overwritten", stale.status === 409,
      `got ${stale.status}`);

    const rendered = await call("POST", `/v1/report-builder/${rid}/render`, {});
    check("the report renders", rendered.body.failures?.length === 0, rendered.text.slice(0, 200));
    check("its widget has data", rendered.body.snapshot?.widgets?.w1?.rows?.length === 4);

    // ── AC7: re-upload with a renamed column ─────────────────────────────
    console.log("\nAC7: schema drift on re-upload");
    const same = await call("POST", `/v1/report-datasets/${dataset.id}/rows`, {
      headers: HEADERS_V1,
      rows: buildRows(900),
    });
    check("re-upload with the SAME columns reports no drift", same.body.drifted === false,
      JSON.stringify(same.body?.drifted));
    check("row count updated", same.body.dataset?.rowCount === 900);

    const drifted = await call("POST", `/v1/report-datasets/${dataset.id}/rows`, {
      headers: HEADERS_V2,
      rows: buildRows(900, { renameRevenue: true }),
    });
    check("re-upload with a RENAMED column reports drift", drifted.body.drifted === true);
    const flagged = (drifted.body.issues ?? []).find((r) => r.reportId === rid);
    check("the affected report is named", Boolean(flagged), JSON.stringify(drifted.body.issues));
    check(
      "the broken widget is named, with the missing column",
      Boolean(flagged?.issues?.some((i) => i.column === "revenue" && i.status === "missing")),
      JSON.stringify(flagged?.issues),
    );
    if (flagged) console.log(`       "${flagged.issues[0].message}"`);

    const afterDrift = await call("GET", `/v1/report-builder/${rid}`);
    check("opening the report still flags it rather than failing", afterDrift.body.issues?.length > 0);
    check(
      "and NOTHING was auto-remapped to the new column",
      afterDrift.body.doc.pages[0].widgets[0].query.measures[0].column === "revenue",
      JSON.stringify(afterDrift.body.doc.pages[0].widgets[0].query.measures),
    );
    const brokenRender = await call("POST", `/v1/report-builder/${rid}/render`, {});
    check(
      "the broken widget renders an explanation, not a blank tile",
      Boolean(brokenRender.body.snapshot?.widgets?.w1?.error),
      JSON.stringify(brokenRender.body.snapshot?.widgets?.w1),
    );
    console.log(`       "${brokenRender.body.snapshot?.widgets?.w1?.error}"`);

    // ── AC11: save as a template, reuse with a different source ──────────
    console.log("\nAC11: template reuse against a different data source");
    const tpl = await call("POST", "/v1/report-builder/templates", {
      reportId: rid,
      name: `E2E template ${Date.now()}`,
    });
    check("saved as a template", tpl.status === 201, tpl.text.slice(0, 200));
    const roles = tpl.body.template?.dataset_roles ?? [];
    check("the template declares a dataset role", roles.length === 1, JSON.stringify(roles));

    const second = await call("POST", "/v1/report-datasets", {
      kind: "upload",
      name: `E2E second source ${Date.now()}`,
      headers: HEADERS_V1,
      rows: buildRows(300),
    });
    created.datasets.push(second.body.dataset.id);

    const reused = await call("POST", "/v1/report-builder", {
      name: `E2E from template ${Date.now()}`,
      templateId: tpl.body.template.id,
      datasetByRole: { [roles[0].role]: second.body.dataset.id },
    });
    created.reports.push(reused.body.report.id);
    check(
      "the new report is bound to the NEW dataset",
      reused.body.report.doc.pages[0].widgets[0].datasetId === second.body.dataset.id,
    );
    const reusedRender = await call("POST", `/v1/report-builder/${reused.body.report.id}/render`, {});
    check(
      "and it renders real numbers from that source",
      reusedRender.body.snapshot?.widgets?.w1?.rows?.length === 4,
      JSON.stringify(reusedRender.body.snapshot?.widgets?.w1).slice(0, 200),
    );

    // ── schedules: the safety rule, enforced ─────────────────────────────
    console.log("\nScheduling (design doc D6: recipients must be members)");
    const unpublished = await call("POST", `/v1/report-builder/${rid}/schedules`, {
      cadence: "weekly",
      dayOfWeek: 1,
      hourUtc: 6,
      recipients: [USER],
    });
    check("cannot schedule an unpublished report", unpublished.status === 400,
      unpublished.text.slice(0, 160));

    await call("POST", `/v1/report-builder/${rid}/publish`);
    const stranger = await call("POST", `/v1/report-builder/${rid}/schedules`, {
      cadence: "weekly",
      dayOfWeek: 1,
      hourUtc: 6,
      recipients: ["00000000-0000-4000-8000-0000000000cc"],
    });
    check("a non-member cannot be a recipient", stranger.status === 400,
      stranger.text.slice(0, 160));

    const sched = await call("POST", `/v1/report-builder/${rid}/schedules`, {
      cadence: "weekly",
      dayOfWeek: 1,
      hourUtc: 6,
      recipients: [USER],
    });
    check("a member CAN be a recipient", sched.status === 201, sched.text.slice(0, 160));
    check("next run is in the future", new Date(sched.body.schedule?.next_run_at) > new Date(),
      sched.body.schedule?.next_run_at);
    console.log(`       next run: ${sched.body.schedule?.next_run_at}`);

    // ── a manual run freezes the numbers ─────────────────────────────────
    const run = await call("POST", `/v1/report-builder/${rid}/runs`, {});
    check("a manual run is recorded", run.status === 201, run.text.slice(0, 160));
    const runId = run.body.run?.id;
    const runDetail = await call("GET", `/v1/report-builder/${rid}/runs/${runId}`);
    check("the run carries a snapshot including its document",
      Boolean(runDetail.body.run?.snapshot?.doc && runDetail.body.run?.snapshot?.widgets));

    // ── the row cap ──────────────────────────────────────────────────────
    console.log("\nRow caps");
    // REFUSED with the cap in the message, not silently clamped. Both are
    // defensible; refusing is the one that tells the caller what happened
    // rather than returning a truncated answer that looks complete. The
    // compiler ALSO clamps as defence in depth - pinned in
    // query-compiler.spec.ts, which is the layer a non-HTTP caller hits.
    const capped = await call("POST", `/v1/report-datasets/${second.body.dataset.id}/query`, {
      dimensions: [{ column: "invoice_no" }],
      measures: [{ agg: "count", alias: "n" }],
      filters: [],
      derived: [],
      limit: 99999,
    });
    check(
      "an over-large limit is refused, with the cap named",
      capped.status === 400 && JSON.stringify(capped.body).includes("5000"),
      `${capped.status} ${capped.text.slice(0, 160)}`,
    );

    const atCap = await call("POST", `/v1/report-datasets/${second.body.dataset.id}/query`, {
      dimensions: [{ column: "region" }],
      measures: [{ agg: "count", alias: "n" }],
      filters: [],
      derived: [],
      limit: 5000,
    });
    check("a limit at the cap is accepted", atCap.status === 201 && atCap.body.rows?.length === 4,
      `${atCap.status} ${atCap.text.slice(0, 160)}`);

    const tooBig = await call("POST", "/v1/report-datasets", {
      kind: "upload",
      name: "E2E too big",
      headers: HEADERS_V1,
      rows: [],
    });
    check("an empty upload is refused with a reason", tooBig.status === 400);
  } finally {
    console.log("\nCleanup");
    for (const id of created.reports) {
      const r = await call("DELETE", `/v1/report-builder/${id}`);
      console.log(`  archived report ${id} -> ${r.status}`);
    }
    for (const id of created.datasets) {
      const r = await call("DELETE", `/v1/report-datasets/${id}`);
      console.log(`  deleted dataset ${id} -> ${r.status}`);
    }
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
