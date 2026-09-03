import { describe, expect, it } from "vitest";
import {
  applyDerived,
  applyTopN,
  bindTemplate,
  blankDoc,
  describeChart,
  HIGH_CARDINALITY,
  inferColumn,
  inferSchema,
  nextRunAt,
  resolveBindings,
  schemaFingerprint,
  suggestCharts,
  toTemplateDoc,
  type ColumnMeta,
  type ReportDoc,
} from "./report-builder";

// ── type inference ─────────────────────────────────────────────────────────

describe("inferColumn", () => {
  it("reads a clean numeric column as numeric", () => {
    expect(inferColumn("amount", [1, 2, 3, 4]).type).toBe("numeric");
  });

  it("tolerates a minority of junk cells rather than downgrading the column", () => {
    // The whole point: three "N/A"s in a 40-row amount column must not make
    // the column unchartable. 90% of non-empty values decide it.
    const values = [...Array.from({ length: 37 }, (_, i) => String(i * 10)), "N/A", "N/A", "N/A"];
    expect(inferColumn("amount", values).type).toBe("numeric");
  });

  it("does not call a column numeric when the junk is more than a tenth", () => {
    const values = [...Array.from({ length: 30 }, (_, i) => String(i)), ...Array(8).fill("N/A")];
    expect(inferColumn("mixed", values).type).toBe("categorical");
  });

  it("reads currency and thousands separators as numbers", () => {
    const values = ["₹1,20,000", "₹95,000", "₹1,10,500", "₹80,000"];
    expect(inferColumn("value", values).type).toBe("numeric");
  });

  it("prefers temporal over numeric for an all-digit date", () => {
    // "2026-01-01" would also satisfy nothing numeric, but the guard matters
    // for the general ordering - a date must never become a measure.
    const values = ["2026-01-01", "2026-02-01", "2026-03-01"];
    expect(inferColumn("closed", values).type).toBe("temporal");
  });

  it("reads a two-valued 1/0 column as boolean, not numeric", () => {
    expect(inferColumn("flag", ["1", "0", "1", "1", "0"]).type).toBe("boolean");
  });

  it("calls a mostly-unique text column an identifier", () => {
    const values = Array.from({ length: 60 }, (_, i) => `INV-${i}`);
    expect(inferColumn("invoice", values).type).toBe("identifier");
  });

  it("does not call a small distinct set an identifier", () => {
    // Four rows, four distinct values is a small category, not an id column.
    expect(inferColumn("stage", ["new", "open", "won", "lost"]).type).toBe("categorical");
  });

  it("reports the null rate over ALL rows, not just non-empty ones", () => {
    const meta = inferColumn("phone", ["a", "", null, undefined]);
    expect(meta.nullRate).toBe(0.75);
  });

  it("types an entirely empty column as unknown rather than guessing", () => {
    expect(inferColumn("blank", ["", null, undefined]).type).toBe("unknown");
  });
});

describe("schemaFingerprint", () => {
  const columns = (): ColumnMeta[] => [
    { name: "stage", type: "categorical" },
    { name: "amount", type: "numeric" },
  ];

  it("ignores column ORDER, so a reordered export does not read as drift", () => {
    expect(schemaFingerprint(columns())).toBe(schemaFingerprint([...columns()].reverse()));
  });

  it("ignores cardinality and null rate, so new VALUES do not read as drift", () => {
    const withStats: ColumnMeta[] = columns().map((c) => ({ ...c, cardinality: 9, nullRate: 0.2 }));
    expect(schemaFingerprint(withStats)).toBe(schemaFingerprint(columns()));
  });

  it("changes when a column is RENAMED", () => {
    const renamed: ColumnMeta[] = [{ name: "stage_name", type: "categorical" }, columns()[1]];
    expect(schemaFingerprint(renamed)).not.toBe(schemaFingerprint(columns()));
  });

  it("changes when a column is RETYPED", () => {
    const retyped: ColumnMeta[] = [columns()[0], { name: "amount", type: "categorical" }];
    expect(schemaFingerprint(retyped)).not.toBe(schemaFingerprint(columns()));
  });
});

// ── the suggestion engine ──────────────────────────────────────────────────

describe("suggestCharts", () => {
  const temporal: ColumnMeta = { name: "created_at", type: "temporal" };
  const measure: ColumnMeta = { name: "amount", type: "numeric" };
  const small: ColumnMeta = { name: "stage", type: "categorical", cardinality: 5 };
  const wide: ColumnMeta = { name: "city", type: "categorical", cardinality: 40 };

  it("puts a line chart first for time-series + numeric", () => {
    const { suggestions } = suggestCharts([temporal, measure]);
    expect(suggestions[0].chart).toBe("line");
  });

  it("gives every suggestion a non-empty rationale", () => {
    const { suggestions } = suggestCharts([temporal, measure, small]);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) expect(s.why.length).toBeGreaterThan(20);
  });

  it("offers a donut for a low-cardinality category", () => {
    const { suggestions } = suggestCharts([small, measure]);
    expect(suggestions.map((s) => s.chart)).toContain("donut");
  });

  it("withholds the donut and switches Top-N on above the cardinality cap", () => {
    const { suggestions } = suggestCharts([wide, measure]);
    expect(suggestions.map((s) => s.chart)).not.toContain("donut");
    const bar = suggestions.find((s) => s.chart === "bar");
    expect(bar?.query.topN?.enabled).toBe(true);
    expect(bar?.why).toContain(String(wide.cardinality));
    expect(wide.cardinality!).toBeGreaterThan(HIGH_CARDINALITY);
  });

  it("suggests scatter for two numerics", () => {
    const second: ColumnMeta = { name: "score", type: "numeric" };
    const { suggestions } = suggestCharts([measure, second]);
    expect(suggestions.map((s) => s.chart)).toContain("scatter");
  });

  it("ranks a lone KPI top when there is nothing to break it down by", () => {
    const { suggestions } = suggestCharts([measure]);
    expect(suggestions[0].widget).toBe("kpi");
  });

  it("never offers an identifier as a grouping, and says why", () => {
    const id: ColumnMeta = { name: "invoice_number", type: "identifier" };
    const { suggestions, warnings } = suggestCharts([id, measure]);
    for (const s of suggestions) {
      expect(s.query.dimensions.map((d) => d.column)).not.toContain("invoice_number");
    }
    expect(warnings.some((w) => w.column === "invoice_number")).toBe(true);
  });

  it("flags a mostly-empty column instead of silently charting it", () => {
    const sparse: ColumnMeta = {
      name: "notes",
      type: "categorical",
      nullRate: 0.8,
      cardinality: 4,
    };
    const { warnings } = suggestCharts([sparse, measure]);
    expect(warnings.some((w) => w.column === "notes" && w.message.includes("80%"))).toBe(true);
  });

  it("flags an untyped column rather than guessing at it", () => {
    const { warnings } = suggestCharts([{ name: "mystery", type: "unknown" }]);
    expect(warnings.some((w) => w.column === "mystery")).toBe(true);
  });

  it("says so plainly when nothing at all is chartable", () => {
    const { suggestions, warnings } = suggestCharts([{ name: "id", type: "identifier" }]);
    expect(suggestions).toHaveLength(0);
    expect(warnings.some((w) => w.message.includes("no numeric, date or category"))).toBe(true);
  });

  it("lets a preferred column reorder without changing the rules", () => {
    const other: ColumnMeta = { name: "owner", type: "categorical", cardinality: 6 };
    const plain = suggestCharts([small, other, measure]);
    const nudged = suggestCharts([small, other, measure], ["owner"]);
    const barOf = (r: typeof plain) => r.suggestions.find((s) => s.chart === "bar");
    expect(barOf(plain)?.query.dimensions[0].column).toBe("stage");
    expect(barOf(nudged)?.query.dimensions[0].column).toBe("owner");
  });
});

describe("inferSchema", () => {
  it("keeps the header order the file had", () => {
    const rows = [{ b: "1", a: "x" }];
    expect(inferSchema(["a", "b"], rows).map((c) => c.name)).toEqual(["a", "b"]);
  });
});

// ── binding resolution / drift ─────────────────────────────────────────────

const docWith = (query: unknown): ReportDoc =>
  ({
    version: 1,
    theme: { preset: "minimal", paletteId: "corporate-navy" },
    pages: [
      {
        id: "p1",
        name: "Page 1",
        filters: [],
        widgets: [
          {
            id: "w1",
            type: "chart",
            chart: "bar",
            title: "Deals by stage",
            layout: { x: 0, y: 0, w: 6, h: 6 },
            datasetId: "11111111-1111-4111-8111-111111111111",
            options: {},
            respondsToPageFilters: true,
            query,
          },
        ],
      },
    ],
  }) as ReportDoc;

const SCHEMA: ColumnMeta[] = [
  { name: "stage", type: "categorical" },
  { name: "amount", type: "numeric" },
];
const BY_ID = { "11111111-1111-4111-8111-111111111111": SCHEMA };

describe("resolveBindings", () => {
  it("passes a mapping that still lines up", () => {
    const doc = docWith({
      dimensions: [{ column: "stage" }],
      measures: [{ column: "amount", agg: "sum", alias: "Value" }],
      filters: [],
      derived: [],
    });
    expect(resolveBindings(doc, BY_ID)).toEqual([]);
  });

  it("flags a column that is gone, naming it", () => {
    const doc = docWith({
      dimensions: [{ column: "stage_name" }],
      measures: [{ column: "amount", agg: "sum", alias: "Value" }],
      filters: [],
      derived: [],
    });
    const issues = resolveBindings(doc, BY_ID);
    expect(issues).toHaveLength(1);
    expect(issues[0].status).toBe("missing");
    expect(issues[0].column).toBe("stage_name");
  });

  it("flags a measure that stopped being numeric", () => {
    const doc = docWith({
      dimensions: [{ column: "stage" }],
      measures: [{ column: "stage", agg: "sum", alias: "Value" }],
      filters: [],
      derived: [],
    });
    const issues = resolveBindings(doc, BY_ID);
    expect(issues[0].status).toBe("wrong_type");
    expect(issues[0].actual).toBe("categorical");
  });

  it("never silently re-points a near-miss at a similar column", () => {
    // `created` vs `created_at` is the case that tempts a fuzzy match. The
    // contract is that it is REPORTED, and that the document is untouched.
    const doc = docWith({
      dimensions: [{ column: "created" }],
      measures: [],
      filters: [],
      derived: [],
    });
    const before = JSON.stringify(doc);
    const issues = resolveBindings(doc, {
      "11111111-1111-4111-8111-111111111111": [{ name: "created_at", type: "temporal" }],
    });
    expect(issues).toHaveLength(1);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("treats a dataset that no longer exists as a broken widget, not a skip", () => {
    const doc = docWith({
      dimensions: [{ column: "stage" }],
      measures: [],
      filters: [],
      derived: [],
    });
    const issues = resolveBindings(doc, {});
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("no longer available");
  });

  it("does not validate a bare count, which has no column", () => {
    const doc = docWith({
      dimensions: [{ column: "stage" }],
      measures: [{ agg: "count", alias: "Count" }],
      filters: [],
      derived: [],
    });
    expect(resolveBindings(doc, BY_ID)).toEqual([]);
  });
});

describe("template binding", () => {
  it("round-trips a document through unbind and rebind", () => {
    const doc = docWith({
      dimensions: [{ column: "stage" }],
      measures: [{ column: "amount", agg: "sum", alias: "Value" }],
      filters: [],
      derived: [],
    });
    const template = toTemplateDoc(doc, () => "deals");
    expect(template.pages[0].widgets[0].datasetId).toBeNull();
    expect(template.pages[0].widgets[0].datasetRole).toBe("deals");

    const rebound = bindTemplate(template, { deals: "22222222-2222-4222-8222-222222222222" });
    expect(rebound.pages[0].widgets[0].datasetId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("leaves an unfilled role unbound rather than dropping the widget", () => {
    const template = toTemplateDoc(
      docWith({
        dimensions: [],
        measures: [{ agg: "count", alias: "n" }],
        filters: [],
        derived: [],
      }),
      () => "deals",
    );
    const rebound = bindTemplate(template, {});
    expect(rebound.pages[0].widgets).toHaveLength(1);
    expect(rebound.pages[0].widgets[0].datasetId).toBeNull();
  });
});

// ── derived fields and Top-N ───────────────────────────────────────────────

describe("applyDerived", () => {
  it("divides two measures", () => {
    const rows = [{ won: 3, total: 12 }];
    const out = applyDerived(rows, [{ alias: "rate", op: "div", left: "won", right: "total" }]);
    expect(out[0].rate).toBe(0.25);
  });

  it("returns null for a zero denominator rather than Infinity or 0", () => {
    // A conversion rate with no denominator is UNKNOWN. Rendering it as 0%
    // would state something false about a rep who made no calls.
    const out = applyDerived(
      [{ won: 3, total: 0 }],
      [{ alias: "rate", op: "div", left: "won", right: "total" }],
    );
    expect(out[0].rate).toBeNull();
  });

  it("evaluates in declaration order, so a field can reference an earlier one", () => {
    const out = applyDerived(
      [{ a: 10, b: 2 }],
      [
        { alias: "sum", op: "add", left: "a", right: "b" },
        { alias: "doubled", op: "mul", left: "sum", right: 2 },
      ],
    );
    expect(out[0].doubled).toBe(24);
  });

  it("yields null when an operand is missing instead of coercing it to zero", () => {
    const out = applyDerived([{ a: 10 }], [{ alias: "x", op: "add", left: "a", right: "missing" }]);
    expect(out[0].x).toBeNull();
  });

  it("leaves rows untouched when nothing is derived", () => {
    const rows = [{ a: 1 }];
    expect(applyDerived(rows, [])).toBe(rows);
  });
});

describe("applyTopN", () => {
  const rows = [
    { stage: "a", n: 10 },
    { stage: "b", n: 8 },
    { stage: "c", n: 3 },
    { stage: "d", n: 2 },
  ];

  it("rolls the tail into one Other row that SUMS the measures", () => {
    const out = applyTopN(rows, { enabled: true, n: 2, otherLabel: "Other" }, ["stage"], ["n"]);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ stage: "Other", n: 5 });
  });

  it("does nothing when the row count is already at or below the cut", () => {
    const out = applyTopN(rows, { enabled: true, n: 10, otherLabel: "Other" }, ["stage"], ["n"]);
    expect(out).toBe(rows);
  });

  it("does nothing when Top-N is off", () => {
    expect(applyTopN(rows, undefined, ["stage"], ["n"])).toBe(rows);
  });

  it("gives Other a null measure when the tail had no numbers at all", () => {
    const withNulls = [
      { s: "a", n: 1 },
      { s: "b", n: null },
      { s: "c", n: null },
    ];
    const out = applyTopN(withNulls, { enabled: true, n: 1, otherLabel: "Other" }, ["s"], ["n"]);
    expect(out[1].n).toBeNull();
  });
});

// ── accessibility summary ──────────────────────────────────────────────────

describe("describeChart", () => {
  it("names the largest category and its share", () => {
    const text = describeChart(
      "Deals by stage",
      [
        { stage: "Won", value: 75 },
        { stage: "Lost", value: 25 },
      ],
      "stage",
      ["value"],
    );
    expect(text).toContain("Won");
    expect(text).toContain("75%");
  });

  it("says so when there is nothing to describe", () => {
    expect(describeChart("Empty", [], "stage", ["value"])).toBe("Empty: no data.");
  });

  it("uses singular grammar for one category", () => {
    // This string is the only thing a screen-reader user gets from a chart, and
    // it goes into client-facing PDFs. "1 categories" is not acceptable there.
    const text = describeChart("Solo", [{ stage: "Won", value: 4 }], "stage", ["value"]);
    expect(text).toContain("1 category");
    expect(text).not.toContain("1 categories");
  });

  it("still pluralises for more than one", () => {
    const text = describeChart(
      "Pair",
      [
        { stage: "Won", value: 4 },
        { stage: "Lost", value: 1 },
      ],
      "stage",
      ["value"],
    );
    expect(text).toContain("2 categories");
  });
});

// ── schedule arithmetic ────────────────────────────────────────────────────

describe("nextRunAt", () => {
  // Not `as const`: that makes `recipients` a readonly tuple, which is not
  // assignable to ScheduleInput's `string[]`. Vitest does not typecheck, so
  // this only showed up in `tsc -p` - which is why the build runs in CI too.
  const base = { recipients: ["11111111-1111-4111-8111-111111111111"], active: true };

  it("moves a daily schedule to tomorrow once today's hour has passed", () => {
    const after = new Date("2026-03-10T07:00:00Z");
    const next = nextRunAt({ ...base, cadence: "daily", hourUtc: 6 }, after);
    expect(next.toISOString()).toBe("2026-03-11T06:00:00.000Z");
  });

  it("keeps a daily schedule today when the hour is still ahead", () => {
    const after = new Date("2026-03-10T05:00:00Z");
    const next = nextRunAt({ ...base, cadence: "daily", hourUtc: 6 }, after);
    expect(next.toISOString()).toBe("2026-03-10T06:00:00.000Z");
  });

  it("finds the next occurrence of a weekday", () => {
    // 2026-03-10 is a Tuesday; Thursday is dayOfWeek 4.
    const next = nextRunAt(
      { ...base, cadence: "weekly", dayOfWeek: 4, hourUtc: 6 },
      new Date("2026-03-10T07:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-03-12T06:00:00.000Z");
  });

  it("rolls a weekly schedule a full week when today IS the day but the hour has gone", () => {
    const tuesday = 2;
    const next = nextRunAt(
      { ...base, cadence: "weekly", dayOfWeek: tuesday, hourUtc: 6 },
      new Date("2026-03-10T07:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-03-17T06:00:00.000Z");
  });

  it("rolls a monthly schedule into next month once the date has passed", () => {
    const next = nextRunAt(
      { ...base, cadence: "monthly", dayOfMonth: 1, hourUtc: 6 },
      new Date("2026-03-10T07:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-04-01T06:00:00.000Z");
  });

  it("never lands on a day February does not have", () => {
    // dayOfMonth is capped at 28 by the schema precisely so this cannot drift.
    const next = nextRunAt(
      { ...base, cadence: "monthly", dayOfMonth: 28, hourUtc: 6 },
      new Date("2026-01-29T07:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-02-28T06:00:00.000Z");
  });
});

describe("blankDoc", () => {
  it("starts with exactly one empty page", () => {
    const doc = blankDoc();
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].widgets).toHaveLength(0);
  });
});
