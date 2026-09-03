import { z } from "zod";

/**
 * The Report Builder's vocabulary (migration 0077).
 *
 * Everything in this file is PURE. No database, no fetch, no React. That is
 * deliberate and load-bearing: the suggestion engine, the schema-drift checker
 * and the binding resolver all have to run in three places - the API when it
 * validates a saved widget, the browser when it previews one, and the worker
 * when it renders a scheduled run - and three implementations of "is this
 * mapping still valid" would eventually disagree. A disagreement here surfaces
 * as a chart that renders in the editor and breaks in the PDF a client
 * receives, which is the worst place to find out.
 *
 * See `Build docs/report_builder_design.md` for the decisions behind the
 * shapes below (D1-D9).
 */

// ── limits (design doc D2) ─────────────────────────────────────────────────

/**
 * The most rows an uploaded dataset may hold. Above this the upload is
 * REFUSED with the count in the message - never silently truncated, because a
 * report built on a truncated file is wrong in a way nobody can see.
 */
export const MAX_UPLOAD_ROWS = 50_000;

/** The most rows any single widget query returns, post-aggregation. */
export const MAX_RESULT_ROWS = 5_000;

/**
 * Beyond this many points a chart stops being a chart. Widgets over the cap
 * fall back to Top-N + "Other" and say so on the tile, rather than rendering
 * 4,000 unreadable bars.
 */
export const CHART_POINT_CAP = 500;

/** Bounds the per-page query fan-out. A page is a page, not a dashboard farm. */
export const MAX_WIDGETS_PER_PAGE = 24;

/** Cardinality above which a categorical column stops suiting a pie/donut. */
export const HIGH_CARDINALITY = 12;

/** Client-side undo depth. The prompt asks for 20; 30 costs nothing more. */
export const UNDO_DEPTH = 30;

/** Autosave debounce, ms. Long enough that a drag is one save, not forty. */
export const AUTOSAVE_DEBOUNCE_MS = 1_500;

// ── column metadata ───────────────────────────────────────────────────────

/**
 * What a column IS, for the purposes of charting it.
 *
 * Not the storage type - `temporal` covers both `date` and `timestamptz`, and
 * `identifier` is a text column that happens to be unique per row (an id, an
 * invoice number, an email). Splitting `identifier` out of `categorical`
 * matters: grouping by one produces exactly as many groups as there are rows,
 * which is the single most common way a first chart comes out useless. The
 * suggestion engine refuses to offer it as a dimension and says why.
 */
export const ColumnType = z.enum([
  "categorical",
  "numeric",
  "temporal",
  "boolean",
  "identifier",
  "unknown",
]);
export type ColumnType = z.infer<typeof ColumnType>;

export const ColumnMeta = z.object({
  /** The machine name. For CRM sources this is the SQL alias, not the raw column. */
  name: z.string().min(1).max(120),
  /** What a human sees in the mapper. Defaults to a title-cased `name`. */
  label: z.string().max(200).optional(),
  type: ColumnType,
  /** Distinct value count, when known. Drives Top-N and the pie/bar split. */
  cardinality: z.number().int().nonnegative().optional(),
  /** 0..1. A column that is 95% empty is offered last and flagged in the mapper. */
  nullRate: z.number().min(0).max(1).optional(),
  /** A few real values, shown in the mapper so the user recognises the column. */
  samples: z.array(z.string().max(120)).max(5).optional(),
  /** Set on CRM sources for money columns, so the KPI card formats correctly. */
  currency: z.boolean().optional(),
});
export type ColumnMeta = z.infer<typeof ColumnMeta>;

export function columnLabel(column: ColumnMeta): string {
  if (column.label) return column.label;
  return column.name
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (c) => c.toUpperCase())
    .trim();
}

// ── type inference for uploaded data ──────────────────────────────────────

/** Matches ISO-8601 dates and the two other spellings people actually paste. */
const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u,
  /^\d{2}\/\d{2}\/\d{4}$/u,
  /^\d{2}-\d{2}-\d{4}$/u,
];

const BOOLEAN_WORDS = new Set(["true", "false", "yes", "no", "y", "n", "1", "0"]);

/**
 * Is this string a number? Tolerates thousands separators, a leading currency
 * symbol and a trailing percent, because those are what a spreadsheet export
 * actually contains - and a column of "₹1,20,000" typed as `categorical` is a
 * revenue column the user cannot chart.
 */
export function parseNumericLike(raw: string): number | null {
  const cleaned = raw
    // Only what a spreadsheet actually puts AROUND a number: a leading
    // currency symbol, thousands separators (including the Indian 1,20,000
    // grouping), non-breaking spaces, a trailing percent.
    //
    // Deliberately NOT "strip any leading non-digit run". That version turned
    // "INV-42" into -42, which typed a whole invoice-number column as a
    // measure - and an identifier silently becoming a measure is this
    // engine's worst failure, because summing ids yields a confident,
    // entirely meaningless number.
    .replace(/^[\s ]*[$€£¥₹₩₪₫฿]?[\s ]*/u, "")
    .replace(/[,\s ]/gu, "")
    .replace(/%$/u, "");
  // Anchored: the WHOLE remaining string must be a number. `Number()` alone is
  // too generous - it accepts "0x1f", "1e5" and "Infinity".
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Infer one column's type from its values.
 *
 * MAJORITY, NOT UNANIMITY. A 5,000-row export with three "N/A"s in an amount
 * column is a numeric column with three bad cells, and typing it `categorical`
 * because of them makes the whole file unchartable. The threshold is 90% of
 * NON-EMPTY values; empties are counted separately and reported as `nullRate`
 * so the mapper can warn about a column that is mostly blank.
 *
 * Ties go to `categorical`, which is the type that can always be grouped -
 * being wrong toward "you can still group this" is recoverable, being wrong
 * toward "this is a number" produces silent NaNs in an aggregate.
 */
export function inferColumn(name: string, values: ReadonlyArray<unknown>): ColumnMeta {
  let nonEmpty = 0;
  let numeric = 0;
  let temporal = 0;
  let boolish = 0;
  const distinct = new Set<string>();
  const samples: string[] = [];

  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === "") continue;
    nonEmpty++;

    // Cap the distinct set: a 50,000-row id column would otherwise build a
    // 50,000-entry Set per column just to learn "very high".
    if (distinct.size <= HIGH_CARDINALITY * 4) distinct.add(text);
    if (samples.length < 5 && !samples.includes(text)) samples.push(text.slice(0, 120));

    if (parseNumericLike(text) !== null) numeric++;
    if (DATE_PATTERNS.some((p) => p.test(text))) temporal++;
    if (BOOLEAN_WORDS.has(text.toLowerCase())) boolish++;
  }

  const total = values.length;
  const nullRate = total === 0 ? 0 : (total - nonEmpty) / total;
  const meta = { name, nullRate, samples, cardinality: distinct.size };

  if (nonEmpty === 0) return { ...meta, type: "unknown" };

  const ratio = (n: number) => n / nonEmpty;

  // Temporal is checked before numeric: "20260101" parses as a number, and a
  // date column silently charted as a measure is a nonsense sum.
  if (ratio(temporal) >= 0.9) return { ...meta, type: "temporal" };
  // ...but only if it did not ALSO look boolean, since "1"/"0" satisfy both
  // the numeric and boolean tests and a two-valued column is not a measure.
  if (ratio(boolish) >= 0.9 && distinct.size <= 2) return { ...meta, type: "boolean" };
  if (ratio(numeric) >= 0.9) return { ...meta, type: "numeric" };

  // A text column with a distinct value for (nearly) every row is an
  // identifier, not a category. Needs enough rows to be a real signal - with
  // 4 rows, 4 distinct values is just a small category.
  if (nonEmpty >= 20 && distinct.size > HIGH_CARDINALITY * 4) {
    return { ...meta, type: "identifier" };
  }
  return { ...meta, type: "categorical" };
}

/** Infer a whole table's schema from parsed rows. Column order follows `headers`. */
export function inferSchema(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<Record<string, unknown>>,
): ColumnMeta[] {
  return headers.map((header) =>
    inferColumn(
      header,
      rows.map((row) => row[header]),
    ),
  );
}

/**
 * A stable hash of a schema's SHAPE - sorted `name:type` pairs.
 *
 * Re-uploading the same file with new VALUES must not flag a single widget, so
 * this deliberately ignores cardinality, null rate and samples. Re-uploading
 * with a renamed or retyped column must flag every widget that touched it, and
 * does. Not cryptographic; it only ever compares against itself.
 */
export function schemaFingerprint(columns: ReadonlyArray<ColumnMeta>): string {
  const shape = columns
    .map((c) => `${c.name}:${c.type}`)
    .sort()
    .join("|");
  let h = 2166136261;
  for (let i = 0; i < shape.length; i++) {
    h ^= shape.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── the transformation spec (prompt 3.2) ──────────────────────────────────

export const FilterOp = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "in",
  "is_null",
  "not_null",
  "between",
]);
export type FilterOp = z.infer<typeof FilterOp>;

export const QueryFilter = z.object({
  column: z.string().min(1).max(120),
  op: FilterOp,
  /**
   * Untyped on purpose - the compiler coerces against the column's declared
   * type rather than trusting whatever the client sent. `in` takes an array,
   * `between` a two-element array, `is_null`/`not_null` nothing.
   */
  value: z.unknown().optional(),
});
export type QueryFilter = z.infer<typeof QueryFilter>;

export const TimeBucket = z.enum(["day", "week", "month", "quarter", "year"]);
export type TimeBucket = z.infer<typeof TimeBucket>;

export const QueryDimension = z.object({
  column: z.string().min(1).max(120),
  /** Only meaningful on a temporal column; ignored elsewhere. */
  bucket: TimeBucket.optional(),
  alias: z.string().min(1).max(120).optional(),
});
export type QueryDimension = z.infer<typeof QueryDimension>;

export const Aggregation = z.enum(["sum", "avg", "count", "count_distinct", "min", "max"]);
export type Aggregation = z.infer<typeof Aggregation>;

export const QueryMeasure = z.object({
  /** Absent only for `count`, which counts rows rather than a column's values. */
  column: z.string().min(1).max(120).optional(),
  agg: Aggregation,
  alias: z.string().min(1).max(120),
  /**
   * A per-measure filter, compiled to SQL's `FILTER (WHERE ...)`.
   *
   * This is what lets "win rate" be one query instead of two: count everything
   * and count only the won rows, side by side, then divide. Without it every
   * ratio needs a second round trip and the two halves can be computed over
   * different snapshots of the table.
   */
  where: QueryFilter.optional(),
});
export type QueryMeasure = z.infer<typeof QueryMeasure>;

export const DerivedOp = z.enum(["add", "sub", "mul", "div", "pct_of"]);
export type DerivedOp = z.infer<typeof DerivedOp>;

/**
 * A calculated field - the prompt's "basic expression support".
 *
 * DELIBERATELY NOT A PARSER. There is no expression language here, no
 * tokeniser, and nothing that could ever be handed to SQL as text. A derived
 * field is one binary operation over two things that are each either a measure
 * ALIAS already in the result or a literal number, evaluated in TypeScript
 * over the (already capped) result rows.
 *
 * That is less powerful than a formula box and it is the right trade: a
 * formula box over tenant data is a query injection surface with a friendly
 * name, and everything real users actually ask for - conversion rate, cost per
 * lead, average value, percent of total - is one operation over two columns.
 * Nesting is available by chaining: a second derived field may reference the
 * first, which is why they evaluate in declaration order.
 */
export const DerivedField = z.object({
  alias: z.string().min(1).max(120),
  op: DerivedOp,
  left: z.union([z.string().min(1).max(120), z.number()]),
  right: z.union([z.string().min(1).max(120), z.number()]),
});
export type DerivedField = z.infer<typeof DerivedField>;

export const TopN = z.object({
  enabled: z.boolean().default(false),
  n: z.number().int().min(1).max(100).default(10),
  /** Everything past the cut is summed into one row with this label. */
  otherLabel: z.string().min(1).max(40).default("Other"),
});
export type TopN = z.infer<typeof TopN>;

export const QuerySpec = z.object({
  dimensions: z.array(QueryDimension).max(4).default([]),
  measures: z.array(QueryMeasure).max(8).default([]),
  filters: z.array(QueryFilter).max(20).default([]),
  derived: z.array(DerivedField).max(8).default([]),
  sort: z
    .object({ key: z.string().min(1).max(120), direction: z.enum(["asc", "desc"]) })
    .optional(),
  limit: z.number().int().min(1).max(MAX_RESULT_ROWS).optional(),
  topN: TopN.optional(),
});
export type QuerySpec = z.infer<typeof QuerySpec>;

// ── the report document ───────────────────────────────────────────────────

export const WidgetType = z.enum(["chart", "kpi", "table", "text", "divider"]);
export type WidgetType = z.infer<typeof WidgetType>;

export const ChartType = z.enum([
  "bar",
  "line",
  "area",
  "pie",
  "donut",
  "scatter",
  "bubble",
  "radar",
]);
export type ChartType = z.infer<typeof ChartType>;

/** 12-column grid, `y`/`h` in 40px rows. Same units `react-grid-layout` uses. */
export const WidgetLayout = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(2).max(40),
});
export type WidgetLayout = z.infer<typeof WidgetLayout>;

export const WidgetOptions = z.object({
  showLegend: z.boolean().optional(),
  showGrid: z.boolean().optional(),
  stacked: z.boolean().optional(),
  /** KPI formatting. `currency` uses the org's own currency, not a hardcoded one. */
  format: z.enum(["number", "currency", "percent", "duration"]).optional(),
  /** Reference lines on a trend chart - the prompt's "target lines". */
  annotations: z
    .array(
      z.object({
        value: z.number(),
        label: z.string().max(60).optional(),
        color: z.string().max(32).optional(),
      }),
    )
    .max(4)
    .optional(),
  /**
   * Which dimension a click on this widget publishes to the page filter bus
   * (design doc D3). Absent = clicking does nothing, which is the right
   * default for a chart whose categories mean nothing to its neighbours.
   */
  filterKey: z.string().min(1).max(120).optional(),
  /** Markdown body, `text` widgets only. */
  body: z.string().max(20_000).optional(),
});
export type WidgetOptions = z.infer<typeof WidgetOptions>;

export const Widget = z.object({
  id: z.string().min(1).max(64),
  type: WidgetType,
  chart: ChartType.optional(),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  layout: WidgetLayout,

  /** Bound. Mutually exclusive with `datasetRole` - see design doc D4. */
  datasetId: z.string().uuid().nullish(),
  /** Unbound, template-side. The role a dataset must be supplied for. */
  datasetRole: z.string().min(1).max(60).nullish(),

  query: QuerySpec.optional(),
  options: WidgetOptions.default({}),

  /** Design doc D3. A widget that opts out keeps showing the whole picture. */
  respondsToPageFilters: z.boolean().default(true),

  /**
   * What to show INSTEAD of an empty tile when nothing is bound yet. The
   * prompt (3.5.1) is explicit that a starter template's widgets must say what
   * kind of column they want - "Map a date column here for your trend line" -
   * rather than rendering blank and leaving the user to guess.
   */
  placeholder: z.string().max(200).nullish(),
});
export type Widget = z.infer<typeof Widget>;

export const PageFilter = z.object({
  column: z.string().min(1).max(120),
  op: FilterOp,
  value: z.unknown().optional(),
  /** Which widget published it, so the console can show "filtered by X" with a source. */
  sourceWidgetId: z.string().max(64).optional(),
});
export type PageFilter = z.infer<typeof PageFilter>;

export const ReportPage = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  widgets: z.array(Widget).max(MAX_WIDGETS_PER_PAGE).default([]),
  /** Filters saved WITH the page - a starting cut, not the live click state. */
  filters: z.array(PageFilter).max(10).default([]),
});
export type ReportPage = z.infer<typeof ReportPage>;

export const DesignPreset = z.enum(["minimal", "modern", "executive"]);
export type DesignPreset = z.infer<typeof DesignPreset>;

export const ReportTheme = z.object({
  preset: DesignPreset.default("minimal"),
  /** A built-in palette key, or a `report_palettes.id` for a tenant's own. */
  paletteId: z.string().min(1).max(64).default("corporate-navy"),
});
export type ReportTheme = z.infer<typeof ReportTheme>;

export const ReportDoc = z.object({
  version: z.literal(1).default(1),
  theme: ReportTheme.default({ preset: "minimal", paletteId: "corporate-navy" }),
  pages: z.array(ReportPage).min(1).max(20),
});
export type ReportDoc = z.infer<typeof ReportDoc>;

/** A brand-new report: one page, nothing on it. */
export function blankDoc(): ReportDoc {
  return {
    version: 1,
    theme: { preset: "minimal", paletteId: "corporate-navy" },
    pages: [{ id: "p1", name: "Page 1", widgets: [], filters: [] }],
  };
}

// ── palettes and presets (prompt 3.3) ─────────────────────────────────────

export interface Palette {
  id: string;
  name: string;
  /** Ordered series colours. Cycles when a chart has more series than colours. */
  colors: string[];
}

/**
 * The four built-ins. Rows in `report_palettes` are the tenant's OWN palettes;
 * these are code, because a report that references "Corporate Navy" by id must
 * still render that way next year, and a tenant editing a shared row out from
 * under it would silently restyle every report in the org.
 *
 * Each set is ordered so the first four are distinguishable at a glance and to
 * the two commonest colour-vision deficiencies - series 1 and 2 differ in
 * lightness as well as hue, so a two-series chart survives being printed in
 * greyscale, which is what actually happens to a board pack.
 */
export const BUILT_IN_PALETTES: Palette[] = [
  {
    id: "minimal-mono",
    name: "Minimal Monochrome",
    colors: ["#171717", "#6b6b6b", "#a3a3a3", "#c9c9c9", "#e0e0e0", "#454545"],
  },
  {
    id: "corporate-navy",
    name: "Corporate Navy",
    colors: ["#1e3a8a", "#2563eb", "#60a5fa", "#0891b2", "#155e75", "#94a3b8"],
  },
  {
    id: "vibrant-sunset",
    name: "Vibrant Sunset",
    colors: ["#c2410c", "#f59e0b", "#e11d48", "#7c3aed", "#0891b2", "#65a30d"],
  },
  {
    id: "forest-emerald",
    name: "Forest Emerald",
    colors: ["#065f46", "#16a34a", "#84cc16", "#0f766e", "#4d7c0f", "#a3a3a3"],
  },
];

export function paletteById(id: string, custom: ReadonlyArray<Palette> = []): Palette {
  return (
    custom.find((p) => p.id === id) ??
    BUILT_IN_PALETTES.find((p) => p.id === id) ??
    BUILT_IN_PALETTES[1]
  );
}

/** The colour for series `i`, cycling. Never returns undefined. */
export function seriesColor(palette: Palette, index: number): string {
  if (palette.colors.length === 0) return "#2563eb";
  return palette.colors[index % palette.colors.length];
}

export interface PresetSpec {
  id: DesignPreset;
  name: string;
  description: string;
  /** Chart-surface knobs the renderer reads. Colours come from the palette. */
  chart: {
    gridOpacity: number;
    axisLine: boolean;
    strokeWidth: number;
    dot: boolean;
    fillOpacity: number;
    cornerRadius: number;
  };
}

/**
 * The three looks from the prompt (3.3), expressed as the handful of knobs a
 * chart actually has. A preset is not a stylesheet - swapping one must
 * re-theme every widget on the page at once, which means the knobs have to
 * live in data the renderer reads, not in CSS classes each widget picked.
 */
export const DESIGN_PRESETS: Record<DesignPreset, PresetSpec> = {
  minimal: {
    id: "minimal",
    name: "Minimalistic",
    description: "Thin axes, faint gridlines, generous padding, muted tones.",
    chart: {
      gridOpacity: 0.35,
      axisLine: false,
      strokeWidth: 2,
      dot: false,
      fillOpacity: 0.12,
      cornerRadius: 6,
    },
  },
  modern: {
    id: "modern",
    name: "Stylish / Modern",
    description: "Gradient fills, soft glow, bold type. Reads well on dark.",
    chart: {
      gridOpacity: 0.2,
      axisLine: false,
      strokeWidth: 3,
      dot: true,
      fillOpacity: 0.38,
      cornerRadius: 10,
    },
  },
  executive: {
    id: "executive",
    name: "Executive / Corporate",
    description: "Crisp borders, high contrast, sharp corners, tables alongside charts.",
    chart: {
      gridOpacity: 0.6,
      axisLine: true,
      strokeWidth: 2,
      dot: true,
      fillOpacity: 0.18,
      cornerRadius: 2,
    },
  },
};

// ── the suggestion engine (prompt 3.2) ────────────────────────────────────

export interface ChartSuggestion {
  /** What to build. `kpi`/`table` are widget types with no chart type. */
  widget: WidgetType;
  chart?: ChartType;
  /** Ranking hint, 0..1. Only meaningful relative to the other suggestions. */
  confidence: number;
  /** The one-line rationale the prompt requires to be visible to the user. */
  why: string;
  /** A ready-to-use query, so "use this" is one click and not a form. */
  query: QuerySpec;
  title: string;
}

/**
 * A reason the engine could NOT confidently suggest anything - surfaced to the
 * user rather than resolved by guessing. The prompt is explicit: "Ambiguous /
 * mixed-type columns -> flag to user rather than guessing silently".
 */
export interface SuggestionWarning {
  column?: string;
  message: string;
}

export interface SuggestionResult {
  suggestions: ChartSuggestion[];
  warnings: SuggestionWarning[];
}

const byPriority = <T>(items: T[], score: (item: T) => number): T[] =>
  [...items].sort((a, b) => score(b) - score(a));

/**
 * Rank chart types for a set of columns, each with a reason.
 *
 * The rules are the prompt's own (3.2), with two additions the prompt implies
 * but does not spell out:
 *
 *   * `identifier` columns are never offered as a dimension. Grouping by one
 *     produces one group per row - the commonest way a first chart comes out
 *     useless - so they are excluded and the exclusion is reported as a
 *     warning naming the column, not hidden.
 *   * high-cardinality categoricals keep their bar suggestion but lose the
 *     pie, and the bar arrives with Top-N already switched on. A 40-slice
 *     donut is not a chart, and silently drawing one teaches people the tool
 *     is broken.
 *
 * `preferred` lets the caller nudge the engine with columns the user has
 * already picked in the mapper; it changes ORDER, never the rules.
 */
export function suggestCharts(
  columns: ReadonlyArray<ColumnMeta>,
  preferred: ReadonlyArray<string> = [],
): SuggestionResult {
  const warnings: SuggestionWarning[] = [];
  const suggestions: ChartSuggestion[] = [];

  const prefer = (c: ColumnMeta) => (preferred.includes(c.name) ? 1 : 0);

  const numeric = byPriority(
    columns.filter((c) => c.type === "numeric"),
    prefer,
  );
  const temporal = byPriority(
    columns.filter((c) => c.type === "temporal"),
    prefer,
  );
  const categorical = byPriority(
    columns.filter((c) => c.type === "categorical" || c.type === "boolean"),
    (c) =>
      prefer(c) * 2 + (c.cardinality !== undefined && c.cardinality <= HIGH_CARDINALITY ? 1 : 0),
  );

  for (const c of columns) {
    if (c.type === "identifier") {
      warnings.push({
        column: c.name,
        message: `"${columnLabel(c)}" looks like an identifier - one distinct value per row - so grouping by it would produce a chart with as many bars as you have rows. Not offered as a category.`,
      });
    }
    if (c.type === "unknown") {
      warnings.push({
        column: c.name,
        message: `"${columnLabel(c)}" is empty or its values are mixed types, so we could not tell what it is. Set its type by hand if you want to use it.`,
      });
    }
    if (c.nullRate !== undefined && c.nullRate > 0.5 && c.type !== "unknown") {
      warnings.push({
        column: c.name,
        message: `"${columnLabel(c)}" is ${Math.round(c.nullRate * 100)}% empty. Anything you chart from it will be based on the minority of rows that have a value.`,
      });
    }
  }

  const measure = numeric[0];
  const countMeasure: QueryMeasure = { agg: "count", alias: "Count" };
  const sumOf = (c: ColumnMeta): QueryMeasure => ({
    column: c.name,
    agg: "sum",
    alias: columnLabel(c),
  });

  // ── time-series + numeric -> line, area ────────────────────────────────
  if (temporal.length > 0) {
    const t = temporal[0];
    const m = measure ? sumOf(measure) : countMeasure;
    const base: QuerySpec = {
      dimensions: [{ column: t.name, bucket: "month" }],
      measures: [m],
      filters: [],
      derived: [],
      sort: { key: t.name, direction: "asc" },
    };
    suggestions.push({
      widget: "chart",
      chart: "line",
      confidence: 0.95,
      title: `${m.alias} over time`,
      why: measure
        ? `"${columnLabel(t)}" is a date and "${columnLabel(measure)}" is a number - a line shows the trend between them more clearly than anything else.`
        : `"${columnLabel(t)}" is a date, so a line over row counts shows how volume is moving.`,
      query: base,
    });
    suggestions.push({
      widget: "chart",
      chart: "area",
      confidence: 0.78,
      title: `${m.alias} over time`,
      why: `Same trend as the line, filled - use it when the total accumulated matters more than the exact value at each point.`,
      query: base,
    });
  }

  // ── categorical + numeric -> bar, pie/donut ────────────────────────────
  if (categorical.length > 0) {
    const c = categorical[0];
    const wide = (c.cardinality ?? 0) > HIGH_CARDINALITY;
    const m = measure ? sumOf(measure) : countMeasure;
    const query: QuerySpec = {
      dimensions: [{ column: c.name }],
      measures: [m],
      filters: [],
      derived: [],
      sort: { key: m.alias, direction: "desc" },
      // Switched on automatically rather than offered as an option, exactly as
      // the prompt asks: "switch to Top-N + Other grouping automatically when
      // cardinality > 12".
      ...(wide ? { topN: { enabled: true, n: 10, otherLabel: "Other" } } : {}),
    };
    suggestions.push({
      widget: "chart",
      chart: "bar",
      confidence: 0.9,
      title: `${m.alias} by ${columnLabel(c)}`,
      why: wide
        ? `"${columnLabel(c)}" has ${c.cardinality} distinct values - too many to read at once - so this shows the top 10 and rolls the rest into "Other".`
        : `"${columnLabel(c)}" is a category and "${m.alias}" is a number - bars make the comparison between categories easy to read left to right.`,
      query,
    });

    if (!wide) {
      suggestions.push({
        widget: "chart",
        chart: "donut",
        confidence: 0.62,
        title: `${m.alias} by ${columnLabel(c)}`,
        why: `Only ${c.cardinality ?? "a few"} categories, so a ring reads as a share of the whole. Bars are still better if you need to compare exact sizes.`,
        query,
      });
    }
  }

  // ── numeric + numeric -> scatter, bubble ───────────────────────────────
  if (numeric.length >= 2) {
    const [x, y] = numeric;
    suggestions.push({
      widget: "chart",
      chart: "scatter",
      confidence: 0.7,
      title: `${columnLabel(y)} against ${columnLabel(x)}`,
      why: `"${columnLabel(x)}" and "${columnLabel(y)}" are both numbers - a scatter shows whether one moves with the other, which a bar chart cannot.`,
      query: {
        dimensions: [{ column: x.name }],
        measures: [{ column: y.name, agg: "avg", alias: columnLabel(y) }],
        filters: [],
        derived: [],
        limit: CHART_POINT_CAP,
      },
    });
    if (numeric.length >= 3) {
      const z = numeric[2];
      suggestions.push({
        widget: "chart",
        chart: "bubble",
        confidence: 0.5,
        title: `${columnLabel(y)} against ${columnLabel(x)}, sized by ${columnLabel(z)}`,
        why: `A third number, "${columnLabel(z)}", can size each point - useful when volume matters as much as position.`,
        query: {
          dimensions: [{ column: x.name }],
          measures: [
            { column: y.name, agg: "avg", alias: columnLabel(y) },
            { column: z.name, agg: "sum", alias: columnLabel(z) },
          ],
          filters: [],
          derived: [],
          limit: CHART_POINT_CAP,
        },
      });
    }
  }

  // ── a single number -> KPI ─────────────────────────────────────────────
  if (measure) {
    suggestions.push({
      widget: "kpi",
      confidence: temporal.length > 0 || categorical.length > 0 ? 0.55 : 0.98,
      title: `Total ${columnLabel(measure)}`,
      why:
        temporal.length > 0
          ? `One number, big. Pair it with the trend line above so the reader sees both the total and its direction.`
          : `"${columnLabel(measure)}" is a number with nothing to break it down by, so a single figure is the honest presentation.`,
      query: {
        dimensions: [],
        measures: [{ column: measure.name, agg: "sum", alias: "value" }],
        filters: [],
        derived: [],
      },
    });
  }

  // ── several measures over few categories -> radar ──────────────────────
  if (numeric.length >= 3 && categorical.length > 0 && (categorical[0].cardinality ?? 99) <= 8) {
    const c = categorical[0];
    suggestions.push({
      widget: "chart",
      chart: "radar",
      confidence: 0.4,
      title: `${columnLabel(c)} profile`,
      why: `Three or more numbers across ${c.cardinality} categories - a radar compares their shape. Axes are normalised to 0-100, so read it as a profile, not as values.`,
      query: {
        dimensions: [{ column: c.name }],
        measures: numeric.slice(0, 4).map(sumOf),
        filters: [],
        derived: [],
      },
    });
  }

  if (suggestions.length === 0) {
    warnings.push({
      message:
        "Nothing here can be charted yet - we found no numeric, date or category column. Check the column types in the mapper, or upload a file with a header row.",
    });
  }

  return {
    suggestions: byPriority(suggestions, (s) => s.confidence),
    warnings,
  };
}

// ── binding resolution & schema drift (prompt 3.2 / 3.5, design doc D4) ────

export type BindingStatus = "ok" | "missing" | "wrong_type";

export interface BindingIssue {
  widgetId: string;
  widgetTitle: string;
  pageId: string;
  column: string;
  status: Exclude<BindingStatus, "ok">;
  expected?: ColumnType;
  actual?: ColumnType;
  message: string;
}

/** Which column types can stand in for a role. */
const DIMENSION_TYPES: ColumnType[] = ["categorical", "temporal", "boolean", "numeric"];
const MEASURE_TYPES: ColumnType[] = ["numeric"];

/**
 * Check every column a widget references against a dataset's actual schema.
 *
 * ONE function for two jobs that must never diverge:
 *   * a dataset was re-uploaded and its columns changed (prompt 3.2, "flag
 *     broken widgets explicitly rather than failing silently or auto-guessing
 *     a new mapping");
 *   * a template is being bound to a dataset it was not authored against
 *     (prompt 3.5, design doc D4).
 *
 * It NEVER repairs anything. A near-miss - `created` where the widget wanted
 * `created_at` - is reported, not silently substituted, because a chart that
 * quietly re-points at a different column is a wrong number wearing the right
 * title.
 */
export function resolveBindings(
  doc: ReportDoc,
  schemaByDataset: Readonly<Record<string, ReadonlyArray<ColumnMeta>>>,
): BindingIssue[] {
  const issues: BindingIssue[] = [];

  for (const page of doc.pages) {
    for (const widget of page.widgets) {
      if (widget.type === "text" || widget.type === "divider") continue;
      const datasetId = widget.datasetId ?? undefined;
      if (!datasetId || !widget.query) continue;

      const columns = schemaByDataset[datasetId];
      // An unknown dataset is a broken widget, not a skip - otherwise a
      // deleted dataset leaves a tile that renders nothing and explains
      // nothing.
      if (!columns) {
        issues.push({
          widgetId: widget.id,
          widgetTitle: widget.title ?? "Untitled widget",
          pageId: page.id,
          column: "-",
          status: "missing",
          message: "The data source this widget used is no longer available.",
        });
        continue;
      }

      const byName = new Map(columns.map((c) => [c.name, c]));
      const check = (name: string, allowed: ColumnType[], role: string) => {
        const found = byName.get(name);
        if (!found) {
          issues.push({
            widgetId: widget.id,
            widgetTitle: widget.title ?? "Untitled widget",
            pageId: page.id,
            column: name,
            status: "missing",
            expected: allowed[0],
            message: `Column "${name}" (${role}) is not in this data source any more.`,
          });
          return;
        }
        if (!allowed.includes(found.type)) {
          issues.push({
            widgetId: widget.id,
            widgetTitle: widget.title ?? "Untitled widget",
            pageId: page.id,
            column: name,
            status: "wrong_type",
            expected: allowed[0],
            actual: found.type,
            message: `Column "${name}" is now ${found.type}, but this widget uses it as a ${role}.`,
          });
        }
      };

      for (const d of widget.query.dimensions) check(d.column, DIMENSION_TYPES, "grouping");
      for (const m of widget.query.measures) {
        // `count` with no column counts rows - nothing to validate.
        if (m.column) check(m.column, MEASURE_TYPES, "measure");
        if (m.where) check(m.where.column, [...DIMENSION_TYPES, "identifier"], "filter");
      }
      for (const f of widget.query.filters) {
        check(f.column, [...DIMENSION_TYPES, "identifier"], "filter");
      }
    }
  }

  return issues;
}

/** The widget ids a set of issues touches - what the canvas renders as broken. */
export function brokenWidgetIds(issues: ReadonlyArray<BindingIssue>): Set<string> {
  return new Set(issues.map((i) => i.widgetId));
}

/**
 * Rewrite a document's `datasetId`s from a role -> dataset map, for
 * instantiating a template. Widgets whose role has no dataset keep their
 * placeholder and stay unbound rather than being dropped, so the canvas can
 * guide the user to the mapping step (prompt 3.5.1).
 */
export function bindTemplate(
  doc: ReportDoc,
  datasetByRole: Readonly<Record<string, string>>,
): ReportDoc {
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      widgets: page.widgets.map((widget) => {
        const role = widget.datasetRole ?? undefined;
        const datasetId = role ? datasetByRole[role] : undefined;
        if (!datasetId) return widget;
        return { ...widget, datasetId, datasetRole: role };
      }),
    })),
  };
}

/**
 * The inverse: strip a report back to a template. Every `datasetId` becomes a
 * `datasetRole`, so the layout and every widget config survive while the data
 * bindings do not.
 *
 * `roleFor` maps a dataset id to a role name; the API derives it from the
 * dataset's own `source_key` (a CRM source) or a slugged name (an upload), so
 * a report over one dataset produces a template with one clearly-named role
 * rather than a uuid nobody can interpret.
 */
export function toTemplateDoc(doc: ReportDoc, roleFor: (datasetId: string) => string): ReportDoc {
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      widgets: page.widgets.map((widget) => {
        if (!widget.datasetId) return { ...widget, datasetId: null };
        return { ...widget, datasetId: null, datasetRole: roleFor(widget.datasetId) };
      }),
    })),
  };
}

// ── derived fields & Top-N, applied to result rows ────────────────────────

export type ResultRow = Record<string, string | number | null>;

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseNumericLike(value);
  return null;
};

/**
 * Evaluate derived fields over already-aggregated rows.
 *
 * Runs in declaration order so a later field may reference an earlier one.
 * Division by zero yields `null`, not `Infinity`: a conversion rate with no
 * denominator is unknown, and rendering it as infinity (or as 0) states
 * something false.
 */
export function applyDerived(
  rows: ReadonlyArray<ResultRow>,
  derived: ReadonlyArray<DerivedField>,
): ResultRow[] {
  if (derived.length === 0) return rows as ResultRow[];
  return rows.map((row) => {
    const out: ResultRow = { ...row };
    for (const field of derived) {
      const left = typeof field.left === "number" ? field.left : asNumber(out[field.left]);
      const right = typeof field.right === "number" ? field.right : asNumber(out[field.right]);
      if (left === null || right === null) {
        out[field.alias] = null;
        continue;
      }
      switch (field.op) {
        case "add":
          out[field.alias] = left + right;
          break;
        case "sub":
          out[field.alias] = left - right;
          break;
        case "mul":
          out[field.alias] = left * right;
          break;
        case "div":
          out[field.alias] = right === 0 ? null : left / right;
          break;
        case "pct_of":
          out[field.alias] = right === 0 ? null : (left / right) * 100;
          break;
      }
    }
    return out;
  });
}

/**
 * Collapse everything past the top `n` into one "Other" row.
 *
 * Applied in TypeScript rather than SQL because the cut depends on the sort
 * that the derived fields may have changed, and because "Other" has to sum the
 * MEASURES while discarding the dimensions - which is a UNION in SQL and three
 * lines here. Rows are already capped at MAX_RESULT_ROWS by the time this runs.
 */
export function applyTopN(
  rows: ReadonlyArray<ResultRow>,
  spec: TopN | undefined,
  dimensionKeys: ReadonlyArray<string>,
  measureKeys: ReadonlyArray<string>,
): ResultRow[] {
  if (!spec?.enabled || rows.length <= spec.n) return rows as ResultRow[];

  const head = rows.slice(0, spec.n);
  const tail = rows.slice(spec.n);

  const other: ResultRow = {};
  for (const key of dimensionKeys) other[key] = spec.otherLabel;
  for (const key of measureKeys) {
    let sum = 0;
    let sawNumber = false;
    for (const row of tail) {
      const n = asNumber(row[key]);
      if (n !== null) {
        sum += n;
        sawNumber = true;
      }
    }
    other[key] = sawNumber ? sum : null;
  }
  return [...head, other];
}

/**
 * The accessible fallback the prompt requires (3.7 / AC 17): a one-sentence
 * summary of what a chart shows, for a screen reader that will never see the
 * SVG. Rendered into the chart's `aria-label`, with the full data also
 * available as a real `<table>` behind a disclosure.
 */
export function describeChart(
  title: string,
  rows: ReadonlyArray<ResultRow>,
  dimensionKey: string | undefined,
  measureKeys: ReadonlyArray<string>,
): string {
  if (rows.length === 0) return `${title}: no data.`;
  const measure = measureKeys[0];
  const rowCount = plural(rows.length, "row");
  if (!dimensionKey || !measure) return `${title}: ${rowCount}.`;

  let topLabel: string | null = null;
  let topValue = -Infinity;
  let total = 0;
  for (const row of rows) {
    const n = asNumber(row[measure]);
    if (n === null) continue;
    total += n;
    if (n > topValue) {
      topValue = n;
      topLabel = row[dimensionKey] === null ? "(blank)" : String(row[dimensionKey]);
    }
  }
  const categories = plural(rows.length, "category", "categories");
  if (topLabel === null) return `${title}: ${categories}, no numeric values.`;

  const share = total > 0 ? Math.round((topValue / total) * 100) : 0;
  return `${title}: ${categories} by ${measure}. Highest is ${topLabel} at ${topValue.toLocaleString()}, ${share}% of the total ${total.toLocaleString()}.`;
}

/**
 * "1 category", not "1 categories".
 *
 * Pedantic-looking, and worth it: this string is the ONLY thing a screen-reader
 * user gets from a chart, and it is embedded in PDFs that go to a tenant's own
 * clients. Broken grammar in the one sentence written for the reader who cannot
 * see the picture is a bad look in the place it can least afford one.
 */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ── scheduling arithmetic ─────────────────────────────────────────────────

export const ScheduleCadence = z.enum(["daily", "weekly", "monthly"]);
export type ScheduleCadence = z.infer<typeof ScheduleCadence>;

export const ScheduleInput = z
  .object({
    cadence: ScheduleCadence,
    dayOfWeek: z.number().int().min(0).max(6).nullish(),
    dayOfMonth: z.number().int().min(1).max(28).nullish(),
    hourUtc: z.number().int().min(0).max(23).default(6),
    recipients: z.array(z.string().uuid()).min(1).max(50),
    active: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    // Mirrors the CHECK constraint in migration 0077. Both exist on purpose:
    // the database one is the guarantee, this one is the error message.
    if (value.cadence === "weekly" && (value.dayOfWeek === null || value.dayOfWeek === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["dayOfWeek"],
        message: "a weekly schedule needs a day of the week",
      });
    }
    if (
      value.cadence === "monthly" &&
      (value.dayOfMonth === null || value.dayOfMonth === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["dayOfMonth"],
        message: "a monthly schedule needs a day of the month",
      });
    }
  });
export type ScheduleInput = z.infer<typeof ScheduleInput>;

/**
 * The next instant a schedule is due, strictly after `after`.
 *
 * All UTC (migration 0077's `hour_utc` comment says why). `dayOfMonth` is
 * capped at 28 by the schema, so this never has to decide what "the 31st" means
 * in February - the ambiguity is removed at the input rather than resolved
 * differently by every reader.
 */
export function nextRunAt(input: ScheduleInput, after: Date = new Date()): Date {
  const next = new Date(
    Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      input.hourUtc,
      0,
      0,
      0,
    ),
  );

  if (input.cadence === "daily") {
    if (next <= after) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  if (input.cadence === "weekly") {
    const target = input.dayOfWeek ?? 1;
    let delta = (target - next.getUTCDay() + 7) % 7;
    // Same weekday but the hour has already passed today -> next week.
    if (delta === 0 && next <= after) delta = 7;
    next.setUTCDate(next.getUTCDate() + delta);
    return next;
  }

  const target = input.dayOfMonth ?? 1;
  next.setUTCDate(target);
  if (next <= after) {
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(target);
  }
  return next;
}
