/*
 * Seeds two demo reports so the Report Builder can be looked at with real
 * charts on the screen rather than empty tiles.
 *
 *   A. "Lead funnel (live CRM)"   - the starter template, bound to live CRM leads.
 *   B. "Sales performance (CSV)"  - an uploaded 800-row file, every widget type.
 *
 * DEMO DATA. Everything it makes is prefixed "Demo" and can be removed with:
 *   node apps/api/demo-report-builder.cjs --clean
 *
 * Local dev only - it writes through the API against whatever E2E_ORG names.
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

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text), text };
  } catch {
    return { status: res.status, body: {}, text };
  }
}

const REGIONS = ["North", "South", "East", "West", "Central"];
const REPS = ["Priya", "Arun", "Meera", "Karthik", "Divya", "Sanjay"];
const CHANNELS = ["Instagram", "Google Ads", "Referral", "Website", "Walk-in", "WhatsApp"];
const PRODUCTS = ["3D Website", "Aura", "LexDraft", "Analytics Agent"];

/** Deterministic pseudo-random, so the demo looks the same every time. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function buildRows(count) {
  const rand = rng(42);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const month = Math.floor(rand() * 8); // Jan-Aug 2026
    const day = 1 + Math.floor(rand() * 27);
    // Give regions and reps genuinely different totals so the bars are not flat.
    const regionIndex = Math.floor(rand() ** 1.6 * REGIONS.length);
    const repIndex = Math.floor(rand() ** 1.3 * REPS.length);
    rows.push({
      region: REGIONS[Math.min(regionIndex, REGIONS.length - 1)],
      rep: REPS[Math.min(repIndex, REPS.length - 1)],
      channel: CHANNELS[Math.floor(rand() * CHANNELS.length)],
      product: PRODUCTS[Math.floor(rand() * PRODUCTS.length)],
      stage: rand() < 0.42 ? "Won" : rand() < 0.55 ? "Lost" : "Open",
      revenue: String(Math.round((8000 + rand() * 240000) / 100) * 100),
      deal_size: String(Math.round(1 + rand() * 9)),
      closed_on: `2026-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      invoice_no: `INV-2026-${String(1000 + i)}`,
    });
  }
  return rows;
}

const HEADERS = [
  "region",
  "rep",
  "channel",
  "product",
  "stage",
  "revenue",
  "deal_size",
  "closed_on",
  "invoice_no",
];

const q = (over) => ({ dimensions: [], measures: [], filters: [], derived: [], ...over });

function salesDoc(datasetId) {
  return {
    version: 1,
    theme: { preset: "executive", paletteId: "corporate-navy" },
    pages: [
      {
        id: "p1",
        name: "Overview",
        filters: [],
        widgets: [
          {
            id: "k1",
            type: "kpi",
            title: "Revenue won",
            subtitle: "All closed-won deals in the file",
            layout: { x: 0, y: 0, w: 3, h: 3 },
            datasetId,
            options: { format: "currency" },
            respondsToPageFilters: true,
            query: q({
              measures: [{ column: "revenue", agg: "sum", alias: "value" }],
              filters: [{ column: "stage", op: "eq", value: "Won" }],
            }),
          },
          {
            id: "k2",
            type: "kpi",
            title: "Deals",
            layout: { x: 3, y: 0, w: 3, h: 3 },
            datasetId,
            options: { format: "number" },
            respondsToPageFilters: true,
            query: q({ measures: [{ agg: "count", alias: "value" }] }),
          },
          {
            id: "k3",
            type: "kpi",
            title: "Average deal size",
            layout: { x: 6, y: 0, w: 3, h: 3 },
            datasetId,
            options: { format: "currency" },
            respondsToPageFilters: true,
            query: q({
              measures: [{ column: "revenue", agg: "avg", alias: "value" }],
              filters: [{ column: "stage", op: "eq", value: "Won" }],
            }),
          },
          {
            id: "k4",
            type: "kpi",
            title: "Win rate",
            subtitle: "Won as a share of everything",
            layout: { x: 9, y: 0, w: 3, h: 3 },
            datasetId,
            options: { format: "percent" },
            respondsToPageFilters: true,
            // The filtered-aggregate shape: two counts over one pass, divided.
            query: q({
              measures: [
                { agg: "count", alias: "total" },
                { agg: "count", alias: "won", where: { column: "stage", op: "eq", value: "Won" } },
              ],
              derived: [{ alias: "value", op: "div", left: "won", right: "total" }],
            }),
          },
          {
            id: "c1",
            type: "chart",
            chart: "area",
            title: "Revenue trend",
            subtitle: "Won revenue by month",
            layout: { x: 0, y: 3, w: 12, h: 8 },
            datasetId,
            options: { showGrid: true, showLegend: false },
            respondsToPageFilters: true,
            query: q({
              dimensions: [{ column: "closed_on", bucket: "month" }],
              measures: [{ column: "revenue", agg: "sum", alias: "Revenue" }],
              filters: [{ column: "stage", op: "eq", value: "Won" }],
              sort: { key: "closed_on", direction: "asc" },
            }),
          },
          {
            id: "c2",
            type: "chart",
            chart: "bar",
            title: "By rep",
            subtitle: "Click a bar to filter this page",
            layout: { x: 0, y: 11, w: 6, h: 8 },
            datasetId,
            options: { showLegend: false, filterKey: "rep" },
            respondsToPageFilters: false,
            query: q({
              dimensions: [{ column: "rep" }],
              measures: [{ column: "revenue", agg: "sum", alias: "Revenue" }],
              sort: { key: "Revenue", direction: "desc" },
            }),
          },
          {
            id: "c3",
            type: "chart",
            chart: "donut",
            title: "Where they came from",
            subtitle: "Deals by channel",
            layout: { x: 6, y: 11, w: 6, h: 8 },
            datasetId,
            options: { showLegend: true, filterKey: "channel" },
            respondsToPageFilters: true,
            query: q({
              dimensions: [{ column: "channel" }],
              measures: [{ agg: "count", alias: "Deals" }],
              sort: { key: "Deals", direction: "desc" },
            }),
          },
          {
            id: "t1",
            type: "table",
            title: "Region detail",
            subtitle: "Revenue and average deal size per region",
            layout: { x: 0, y: 19, w: 12, h: 8 },
            datasetId,
            options: {},
            respondsToPageFilters: true,
            query: q({
              dimensions: [{ column: "region" }],
              measures: [
                { column: "revenue", agg: "sum", alias: "Revenue" },
                { agg: "count", alias: "Deals" },
                { column: "deal_size", agg: "avg", alias: "Avg units" },
              ],
              derived: [{ alias: "Per deal", op: "div", left: "Revenue", right: "Deals" }],
              sort: { key: "Revenue", direction: "desc" },
            }),
          },
        ],
      },
      {
        id: "p2",
        name: "By product",
        filters: [],
        widgets: [
          {
            id: "n1",
            type: "text",
            title: "About this page",
            layout: { x: 0, y: 0, w: 12, h: 3 },
            options: {
              body:
                "A second page, to show multi-page reports. Each page has its own filter bus - " +
                "clicking a bar on the Overview page does not re-cut anything here.",
            },
            respondsToPageFilters: false,
            datasetId: null,
          },
          {
            id: "c4",
            type: "chart",
            chart: "bar",
            title: "Revenue by product",
            subtitle: "With a target line at 20M",
            layout: { x: 0, y: 3, w: 7, h: 8 },
            datasetId,
            options: {
              showLegend: false,
              showGrid: true,
              annotations: [{ value: 20000000, label: "Target" }],
              filterKey: "product",
            },
            respondsToPageFilters: true,
            query: q({
              dimensions: [{ column: "product" }],
              measures: [{ column: "revenue", agg: "sum", alias: "Revenue" }],
              sort: { key: "Revenue", direction: "desc" },
            }),
          },
          {
            id: "c5",
            type: "chart",
            chart: "line",
            title: "Deals per week",
            layout: { x: 7, y: 3, w: 5, h: 8 },
            datasetId,
            options: { showGrid: true, showLegend: false },
            respondsToPageFilters: true,
            query: q({
              dimensions: [{ column: "closed_on", bucket: "week" }],
              measures: [{ agg: "count", alias: "Deals" }],
              sort: { key: "closed_on", direction: "asc" },
            }),
          },
          {
            id: "c6",
            type: "chart",
            chart: "radar",
            title: "Stage profile by region",
            subtitle: "Axes normalised to 0-100 - read it as a shape, not as values",
            layout: { x: 0, y: 11, w: 12, h: 9 },
            datasetId,
            options: { showLegend: true },
            respondsToPageFilters: true,
            query: q({
              dimensions: [{ column: "region" }],
              measures: [
                { column: "revenue", agg: "sum", alias: "Revenue" },
                { agg: "count", alias: "Deals" },
                { column: "deal_size", agg: "sum", alias: "Units" },
              ],
            }),
          },
        ],
      },
    ],
  };
}

(async () => {
  if (process.argv.includes("--clean")) {
    const list = await call("GET", "/v1/report-builder");
    for (const r of list.body.reports ?? []) {
      if (r.name.startsWith("Demo")) {
        await call("DELETE", `/v1/report-builder/${r.id}`);
        console.log(`archived ${r.name}`);
      }
    }
    const ds = await call("GET", "/v1/report-datasets");
    for (const d of ds.body.datasets ?? []) {
      if (d.name.startsWith("Demo")) {
        await call("DELETE", `/v1/report-datasets/${d.id}`);
        console.log(`deleted dataset ${d.name}`);
      }
    }
    console.log("demo data removed");
    return;
  }

  // ── A. the starter template, bound to live CRM leads ────────────────────
  const leadsDs = await call("POST", "/v1/report-datasets", {
    kind: "crm",
    sourceKey: "leads",
    name: "Demo - Leads (live CRM)",
  });
  const tpls = await call("GET", "/v1/report-builder/templates");
  const funnel = tpls.body.templates.find((t) => t.key === "lead-funnel");

  const reportA = await call("POST", "/v1/report-builder", {
    name: "Demo - Lead funnel (live CRM)",
    description: "Built in one click from the Lead funnel starter template, bound to live CRM data.",
    templateId: funnel.id,
    datasetByRole: { leads: leadsDs.body.dataset.id },
  });
  await call("POST", `/v1/report-builder/${reportA.body.report.id}/publish`);

  // ── B. an uploaded file, every widget type ──────────────────────────────
  const rows = buildRows(800);
  const upload = await call("POST", "/v1/report-datasets", {
    kind: "upload",
    name: "Demo - Sales export 2026",
    headers: HEADERS,
    rows,
  });
  const dsId = upload.body.dataset.id;
  if (!dsId) throw new Error(`upload failed: ${upload.text.slice(0, 300)}`);

  const reportB = await call("POST", "/v1/report-builder", {
    name: "Demo - Sales performance (uploaded CSV)",
    description: "Two pages over an 800-row upload: KPIs, area, bar, donut, line, radar and a table.",
  });
  const bId = reportB.body.report.id;
  const save = await call("PATCH", `/v1/report-builder/${bId}`, {
    revision: 0,
    doc: salesDoc(dsId),
  });
  if (save.status !== 200) throw new Error(`save failed: ${save.text.slice(0, 300)}`);
  await call("POST", `/v1/report-builder/${bId}/publish`);

  // Check every widget actually renders before claiming the demo is ready.
  const rendered = await call("POST", `/v1/report-builder/${bId}/render`, {});
  const failures = rendered.body.failures ?? [];

  console.log(`\ninferred column types: ${JSON.stringify(
    Object.fromEntries(upload.body.dataset.columns.map((c) => [c.name, c.type])),
  )}`);
  console.log(`\nA  /owner/reports/builder/${reportA.body.report.id}`);
  console.log(`B  /owner/reports/builder/${bId}`);
  console.log(`\nwidgets rendered: ${Object.keys(rendered.body.snapshot?.widgets ?? {}).length}`);
  console.log(`failures: ${failures.length}${failures.length ? `\n  ${failures.join("\n  ")}` : ""}`);
  if (failures.length) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
