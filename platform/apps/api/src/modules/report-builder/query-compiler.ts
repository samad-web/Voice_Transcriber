import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  MAX_RESULT_ROWS,
  type Aggregation,
  type ColumnMeta,
  type QueryFilter,
  type QuerySpec,
  type TimeBucket,
} from "@aura/shared";
import type { CrmRecordScope } from "../../common/crm-scope";
import type { CrmSource } from "./crm-sources";

/**
 * A widget's query spec -> one parameterised SQL statement.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────
 *
 * Every IDENTIFIER in the output comes from a lookup table written by a
 * person; every VALUE is a `$n` placeholder. There is no third category. A
 * column name the caller sends is used only as a Map key - if the lookup
 * misses, the query is rejected. Nothing the caller sends is ever concatenated
 * into the statement, so this file has no escaping logic and needs none:
 * escaping is a defence you can be subtly wrong about, and a whitelist is one
 * you cannot.
 *
 * ── TWO BACKENDS, ONE SHAPE ─────────────────────────────────────────────
 *
 * A CRM source resolves a column to `t.amount`; an uploaded dataset resolves
 * the same alias to `(r.data->>'amount')::numeric`. Everything downstream -
 * grouping, filtering, aggregating, sorting, capping - is identical, which is
 * the point: two engines would eventually disagree about what `avg` over an
 * empty group means, and the disagreement would surface as a wrong number on a
 * client-facing report rather than as a failing test.
 */

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  /** Result keys that came from dimensions, in order. */
  dimensionKeys: string[];
  /** Result keys that came from measures, in order. */
  measureKeys: string[];
}

/** How a source resolves an alias to a SQL expression, and what type it is. */
export interface ColumnResolver {
  expression(alias: string): string | undefined;
  type(alias: string): ColumnMeta["type"] | undefined;
}

/**
 * Aliases are quoted with double quotes in the SELECT list, which means an
 * alias containing a double quote would break out. Aliases come from the
 * widget's own `alias` fields, which ARE caller-supplied - so they are
 * validated here rather than trusted.
 *
 * Deliberately strict: letters, digits, space, and a small set of punctuation
 * people actually use in a column heading. Anything else is refused with the
 * offending alias named, which is a better outcome than silently rewriting a
 * user's column heading.
 */
const SAFE_ALIAS = /^[A-Za-z0-9 _()%/.,'+-]{1,120}$/u;

function checkAlias(alias: string): string {
  if (!SAFE_ALIAS.test(alias)) {
    throw new BadRequestException(
      `"${alias}" is not a usable column heading - letters, numbers, spaces and simple punctuation only.`,
    );
  }
  return alias;
}

/** Aggregations, as a lookup rather than a template - see THE ONE RULE. */
const AGG_SQL: Record<Aggregation, (expr: string) => string> = {
  sum: (e) => `sum(${e})`,
  avg: (e) => `avg(${e})`,
  min: (e) => `min(${e})`,
  max: (e) => `max(${e})`,
  count: (e) => (e === "*" ? "count(*)" : `count(${e})`),
  count_distinct: (e) => `count(DISTINCT ${e})`,
};

/** `to_char` patterns per bucket. A day bucket is also the unbucketed default. */
const FORMATS: Record<TimeBucket, string> = {
  day: "YYYY-MM-DD",
  week: "YYYY-MM-DD",
  month: "YYYY-MM",
  quarter: 'YYYY-"Q"Q',
  year: "YYYY",
};

/** Time buckets, likewise. `date_trunc` takes its unit as a string literal. */
const BUCKET_SQL: Record<TimeBucket, string> = {
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

/**
 * How many placeholders each operator consumes. Encoded once, here, because
 * getting it wrong shifts every subsequent `$n` and produces a query that
 * either errors or - worse - filters on the wrong value.
 */
const OP_ARITY: Record<QueryFilter["op"], number> = {
  eq: 1,
  neq: 1,
  gt: 1,
  gte: 1,
  lt: 1,
  lte: 1,
  contains: 1,
  starts_with: 1,
  in: 1,
  is_null: 0,
  not_null: 0,
  between: 2,
};

/** The simple binary comparators. Everything else has its own branch below. */
const COMPARATORS: Partial<Record<QueryFilter["op"], string>> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

class ParamList {
  private readonly values: unknown[] = [];

  /** Appends a value and returns its `$n` placeholder. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  get all(): unknown[] {
    return this.values;
  }

  get length(): number {
    return this.values.length;
  }
}

/**
 * Coerce a filter value against the column's declared type.
 *
 * A number typed into a text box arrives as `"12"`, and `(data->>'x')::numeric
 * > '12'` is a type error in Postgres rather than a comparison. Coercing here
 * - once, against the schema - is why the compiled SQL never needs a cast on
 * the parameter side.
 */
function coerce(value: unknown, type: ColumnMeta["type"] | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (type === "numeric") {
    const n = typeof value === "number" ? value : Number(String(value).replace(/[, ]/gu, ""));
    if (!Number.isFinite(n)) {
      throw new BadRequestException(
        `"${String(value)}" is not a number, but this filter needs one.`,
      );
    }
    return n;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const text = String(value).toLowerCase();
    return text === "true" || text === "yes" || text === "1";
  }
  if (type === "temporal") {
    // Left as text: Postgres casts a well-formed date literal against a
    // timestamptz column correctly, and parsing it here would introduce this
    // process's timezone into a comparison that has none.
    return String(value);
  }
  return String(value);
}

function filterSql(filter: QueryFilter, resolver: ColumnResolver, params: ParamList): string {
  const expr = resolver.expression(filter.column);
  if (!expr) {
    throw new BadRequestException(`Unknown column "${filter.column}" in a filter.`);
  }
  const type = resolver.type(filter.column);
  const arity = OP_ARITY[filter.op];

  if (arity === 0) {
    return filter.op === "is_null" ? `${expr} IS NULL` : `${expr} IS NOT NULL`;
  }

  if (filter.op === "between") {
    const range = Array.isArray(filter.value) ? filter.value : [];
    if (range.length !== 2) {
      throw new BadRequestException(`A "between" filter on "${filter.column}" needs two values.`);
    }
    return `${expr} BETWEEN ${params.add(coerce(range[0], type))} AND ${params.add(coerce(range[1], type))}`;
  }

  if (filter.op === "in") {
    const list = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (list.length === 0 || list.length > 200) {
      throw new BadRequestException(
        `An "is one of" filter on "${filter.column}" needs 1-200 values.`,
      );
    }
    // ONE parameter holding an array, not N placeholders: `= ANY($n)` keeps
    // the statement shape constant regardless of how many values the user
    // picked, so Postgres can reuse the plan and the parameter count cannot
    // drift from the placeholder count.
    return `${expr}::text = ANY(${params.add(list.map((v) => String(v)))}::text[])`;
  }

  if (filter.op === "contains" || filter.op === "starts_with") {
    // ILIKE with the wildcards added to the PARAMETER, never to the SQL, so a
    // user searching for a literal `%` matches a literal `%`.
    const raw = String(filter.value ?? "").replace(/[\\%_]/gu, (c) => `\\${c}`);
    const pattern = filter.op === "contains" ? `%${raw}%` : `${raw}%`;
    return `${expr}::text ILIKE ${params.add(pattern)}`;
  }

  const comparator = COMPARATORS[filter.op];
  // Unreachable while OP_ARITY and COMPARATORS stay in step - which is exactly
  // why it throws rather than emitting `undefined` into the statement. A new
  // operator added to the shared enum lands here loudly on its first use
  // instead of producing SQL that will not parse.
  if (!comparator) throw new BadRequestException(`Unsupported filter "${filter.op}".`);
  return `${expr} ${comparator} ${params.add(coerce(filter.value, type))}`;
}

function dimensionExpression(
  column: string,
  bucket: TimeBucket | undefined,
  resolver: ColumnResolver,
): string {
  const expr = resolver.expression(column);
  if (!expr) throw new BadRequestException(`Unknown column "${column}".`);
  const temporal = resolver.type(column) === "temporal";

  if (bucket && !temporal) {
    throw new BadRequestException(
      `"${column}" is not a date, so it cannot be grouped by ${bucket}.`,
    );
  }
  if (!temporal) return expr;

  // ── EVERY TEMPORAL DIMENSION LEAVES AS TEXT ──────────────────────────────
  //
  // node-postgres parses a `date`/`timestamptz` into a JS Date at the SERVER's
  // local midnight, and JSON.stringify then emits UTC - so on this +05:30 host
  // a bucket of `2026-08-01` reaches the browser as `2026-07-31T18:30:00Z` and
  // every axis label is a day early. The bug already bit `tasks.due_on` and
  // `deals.expected_close_date` elsewhere in this codebase; a text bucket
  // cannot have it.
  //
  // This lives HERE rather than in the source catalogue because the catalogue
  // does not know whether a bucket was asked for. Formatting in the column
  // definition made the column's type TEXT, and `date_trunc('month', text)`
  // does not exist - so bucketing a due date failed outright. The rule is:
  // sources declare columns, the compiler decides how they are read.
  const format = FORMATS[bucket ?? "day"];
  const truncated = bucket ? `date_trunc('${BUCKET_SQL[bucket]}', ${expr})` : expr;
  return `to_char(${truncated}, '${format}')`;
}

/**
 * Compile a spec against a resolver.
 *
 * `scopeSql` is the caller's record-scope predicate, already resolved by the
 * source (CRM) or absent (upload - an uploaded file has no per-record owner,
 * and its tenant boundary is RLS on `report_dataset_rows`).
 */
function compile(
  spec: QuerySpec,
  resolver: ColumnResolver,
  from: string,
  baseWhere: string,
  baseParams: unknown[],
  scope: { sql: string; userId: string } | null,
): CompiledQuery {
  if (spec.dimensions.length === 0 && spec.measures.length === 0) {
    throw new BadRequestException("A widget needs at least one column or one measure.");
  }

  const params = new ParamList();
  for (const value of baseParams) params.add(value);

  const selects: string[] = [];
  const groupBys: string[] = [];
  const dimensionKeys: string[] = [];
  const measureKeys: string[] = [];

  for (const dimension of spec.dimensions) {
    const expr = dimensionExpression(dimension.column, dimension.bucket, resolver);
    const alias = checkAlias(dimension.alias ?? dimension.column);
    selects.push(`${expr} AS "${alias}"`);
    // GROUP BY the EXPRESSION, not the output alias. Postgres does accept an
    // output name here, but only when it is unambiguous - an alias that
    // collides with a real column name silently groups by the wrong thing.
    groupBys.push(expr);
    dimensionKeys.push(alias);
  }

  for (const measure of spec.measures) {
    const alias = checkAlias(measure.alias);
    let inner = "*";
    if (measure.column) {
      const expr = resolver.expression(measure.column);
      if (!expr) throw new BadRequestException(`Unknown column "${measure.column}" in a measure.`);
      if (measure.agg !== "count" && measure.agg !== "count_distinct") {
        const type = resolver.type(measure.column);
        if (type !== "numeric") {
          throw new BadRequestException(
            `"${measure.column}" is a ${type ?? "text"} column, so it cannot be ${measure.agg}'d. Use count instead.`,
          );
        }
      }
      inner = expr;
    } else if (measure.agg !== "count") {
      throw new BadRequestException(`A ${measure.agg} needs a column to work on.`);
    }

    let sql = AGG_SQL[measure.agg](inner);
    if (measure.where) {
      // Postgres's own aggregate FILTER clause - one pass over the rows, and
      // the filtered and unfiltered measures are guaranteed to be computed
      // over the same snapshot. Two round trips could not promise that.
      sql += ` FILTER (WHERE ${filterSql(measure.where, resolver, params)})`;
    }
    // COALESCE only on sum/count, where "no rows" genuinely means zero. An avg
    // or a min over nothing is UNKNOWN, and coalescing it to 0 would state
    // something false - an average deal size of ₹0 reads as a catastrophe
    // rather than as an empty window.
    if (measure.agg === "sum" || measure.agg === "count" || measure.agg === "count_distinct") {
      sql = `COALESCE(${sql}, 0)`;
    }
    selects.push(`${sql} AS "${alias}"`);
    measureKeys.push(alias);
  }

  const wheres = [baseWhere];
  for (const filter of spec.filters) wheres.push(filterSql(filter, resolver, params));
  if (scope) wheres.push(scope.sql.replace(/\$\?/gu, params.add(scope.userId)));

  // Sorting by an OUTPUT alias is safe and correct here - the sort key must be
  // something in the result, and validating it against the keys we just built
  // means a caller cannot name anything else.
  let orderBy = "";
  if (spec.sort) {
    const alias = spec.sort.key;
    if (!dimensionKeys.includes(alias) && !measureKeys.includes(alias)) {
      throw new BadRequestException(
        `Cannot sort by "${alias}" - it is not in this widget's result.`,
      );
    }
    const direction = spec.sort.direction === "asc" ? "ASC" : "DESC";
    // NULLS LAST in both directions: a chart whose biggest bar is "no value"
    // is a chart about missing data, which is almost never the question.
    orderBy = ` ORDER BY "${alias}" ${direction} NULLS LAST`;
  }

  // The limit is `min(requested, MAX_RESULT_ROWS)` and it is applied even when
  // the caller asked for nothing - design doc D2: there is no path where an
  // unbounded row count reaches the browser.
  const limit = Math.min(spec.limit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS);

  const groupBy = groupBys.length > 0 ? ` GROUP BY ${groupBys.join(", ")}` : "";
  const sql =
    `SELECT ${selects.join(", ")} FROM ${from} WHERE ${wheres.join(" AND ")}` +
    `${groupBy}${orderBy} LIMIT ${limit}`;

  return { sql, params: params.all, dimensionKeys, measureKeys };
}

/** Resolver over a CRM source's hand-written column table. */
function crmResolver(source: CrmSource): ColumnResolver {
  const byName = new Map(source.columns.map((c) => [c.name, c]));
  return {
    expression: (alias) => byName.get(alias)?.sql,
    type: (alias) => byName.get(alias)?.type,
  };
}

export function compileCrmQuery(
  source: CrmSource,
  spec: QuerySpec,
  orgId: string,
  recordScope: CrmRecordScope,
): CompiledQuery {
  let scope: { sql: string; userId: string } | null = null;

  if (recordScope.scope === "owned") {
    if (!source.ownerSql) {
      // See the `leads` and `campaigns` entries in crm-sources.ts. Refusing is
      // the only safe branch: this source has no owner column, so "only your
      // records" cannot be expressed, and running the query unscoped would
      // hand a restricted role the whole tenant's data through a chart.
      throw new ForbiddenException(
        `The "${source.name}" data source has no per-record owner, so it cannot be narrowed to your own records. Your role only grants access to records you own.`,
      );
    }
    // A scoped grant with no resolvable user is a contradiction the guard
    // should already have refused; matching nothing is the safe reading, and
    // it mirrors scopeFilter()'s own all-zeros fallback exactly.
    scope = {
      sql: source.ownerSql,
      userId: recordScope.userId ?? "00000000-0000-0000-0000-000000000000",
    };
  }

  return compile(spec, crmResolver(source), source.from, source.where, [orgId], scope);
}

/**
 * Resolver over an uploaded dataset's jsonb rows.
 *
 * Every column becomes `(r.data->>'name')` with a cast chosen by the INFERRED
 * type, so a numeric column sums as a number rather than sorting "9" after
 * "10". The column name is interpolated into the expression, which looks like
 * it breaks THE ONE RULE - it does not: `name` here comes from the dataset's
 * stored `columns` metadata, which the API wrote from the uploaded headers,
 * and it is additionally validated below. A caller cannot introduce a name
 * that is not already in that list, because `expression()` is a Map lookup.
 */
function uploadResolver(columns: ReadonlyArray<ColumnMeta>): ColumnResolver {
  const built = new Map<string, { sql: string; type: ColumnMeta["type"] }>();
  for (const column of columns) {
    // A single quote in a header would close the jsonb key literal. Headers
    // are stored data rather than request data, but this is the one place a
    // stored string becomes SQL text, so it is checked at the boundary rather
    // than trusted because of where it came from.
    if (/['\\]/u.test(column.name)) continue;
    const raw = `(r.data->>'${column.name}')`;
    const sql =
      column.type === "numeric"
        ? `NULLIF(${raw}, '')::numeric`
        : column.type === "temporal"
          ? `NULLIF(${raw}, '')::timestamptz`
          : column.type === "boolean"
            ? `NULLIF(${raw}, '')::boolean`
            : raw;
    built.set(column.name, { sql, type: column.type });
  }
  return {
    expression: (alias) => built.get(alias)?.sql,
    type: (alias) => built.get(alias)?.type,
  };
}

export function compileUploadQuery(
  columns: ReadonlyArray<ColumnMeta>,
  spec: QuerySpec,
  orgId: string,
  datasetId: string,
): CompiledQuery {
  return compile(
    spec,
    uploadResolver(columns),
    "report_dataset_rows r",
    "r.org_id = $1 AND r.dataset_id = $2",
    [orgId, datasetId],
    // An uploaded file has no per-record owner. Its tenant boundary is RLS on
    // report_dataset_rows plus the explicit org predicate above; there is
    // nothing narrower to apply, and pretending otherwise would be theatre.
    null,
  );
}
