"use client";

import { useMemo } from "react";
import { Lightbulb, Trash2 } from "lucide-react";
import { Button, Checkbox, FormField, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
import {
  columnLabel,
  suggestCharts,
  type ChartType,
  type ColumnMeta,
  type QuerySpec,
  type Widget,
} from "@aura/shared";

/**
 * The column mapper, the suggestion list, and the widget's own options.
 *
 * ── THE SUGGESTIONS RUN IN THE BROWSER ──────────────────────────────────
 *
 * `suggestCharts` is pure and lives in `@aura/shared`, so it runs here with no
 * round trip - the list re-ranks the instant a different data source is picked.
 * That matters more than it sounds: a suggestion that arrives 300ms after the
 * dropdown closes is a suggestion nobody reads.
 *
 * Every one carries its `why` on the face of the card, not behind a tooltip.
 * The prompt (3.2) asks for the rationale to be visible, and the reason is
 * substantive: a recommendation a user cannot evaluate is one they either
 * follow blindly or ignore entirely, and both are worse than a sentence.
 */

export interface DatasetOption {
  id: string;
  name: string;
  kind: "crm" | "upload";
  columns: ColumnMeta[];
}

interface WidgetInspectorProps {
  widget: Widget;
  datasets: DatasetOption[];
  onChange: (patch: Partial<Widget>) => void;
  onDelete: () => void;
  /** Report id, for the per-widget CSV export link. */
  reportId: string;
  canExport: boolean;
}

const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "donut", label: "Donut" },
  { value: "pie", label: "Pie" },
  { value: "scatter", label: "Scatter" },
  { value: "bubble", label: "Bubble" },
  { value: "radar", label: "Radar" },
];

export function WidgetInspector({
  widget,
  datasets,
  onChange,
  onDelete,
  reportId,
  canExport,
}: WidgetInspectorProps) {
  const dataset = datasets.find((d) => d.id === widget.datasetId);
  const columns = dataset?.columns ?? [];

  const query: QuerySpec = widget.query ?? {
    dimensions: [],
    measures: [],
    filters: [],
    derived: [],
  };

  const { suggestions, warnings } = useMemo(
    () =>
      columns.length > 0
        ? suggestCharts(columns, query.dimensions.map((d) => d.column))
        : { suggestions: [], warnings: [] },
    [columns, query.dimensions],
  );

  const setQuery = (patch: Partial<QuerySpec>) => onChange({ query: { ...query, ...patch } });

  const groupable = columns.filter(
    (c) => c.type === "categorical" || c.type === "temporal" || c.type === "boolean",
  );
  const measurable = columns.filter((c) => c.type === "numeric");

  const isData = widget.type === "chart" || widget.type === "kpi" || widget.type === "table";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>Widget</MonoLabel>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          <Trash2 className="size-3.5" aria-hidden="true" />
          Remove
        </Button>
      </div>

      <FormField label="Title" name="widget-title">
        <Input
          value={widget.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Untitled widget"
        />
      </FormField>

      <FormField label="Subtitle" name="widget-subtitle" hint="One line under the title.">
        <Input
          value={widget.subtitle ?? ""}
          onChange={(e) => onChange({ subtitle: e.target.value })}
        />
      </FormField>

      {widget.type === "text" ? (
        <FormField label="Text" name="widget-body" hint="Plain text. Line breaks are kept.">
          <textarea
            value={widget.options.body ?? ""}
            onChange={(e) => onChange({ options: { ...widget.options, body: e.target.value } })}
            rows={8}
            className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
        </FormField>
      ) : null}

      {isData ? (
        <>
          <FormField
            label="Data source"
            name="widget-dataset"
            hint="CRM sources are live - their numbers are recomputed every time this report is opened."
          >
            <Select
              value={widget.datasetId ?? ""}
              onChange={(e) => {
                // Changing the source clears the mapping. Keeping the old
                // column names would silently point them at a different
                // dataset's columns of the same name - the exact
                // wrong-number-right-title failure that resolveBindings
                // exists to prevent, arrived at by a different route.
                onChange({
                  datasetId: e.target.value || null,
                  query: { dimensions: [], measures: [], filters: [], derived: [] },
                });
              }}
            >
              <option value="">Not connected</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.kind === "crm" ? "(live)" : "(uploaded)"}
                </option>
              ))}
            </Select>
          </FormField>

          {warnings.length > 0 ? (
            <ul className="space-y-1 rounded-md border border-warning-text/30 bg-warning-subtle p-2">
              {warnings.map((warning, i) => (
                <li key={i} className="text-[11px] leading-snug text-warning-text">
                  {warning.message}
                </li>
              ))}
            </ul>
          ) : null}

          {suggestions.length > 0 && widget.type === "chart" ? (
            <div>
              <p className="flex items-center gap-1.5 text-xs font-medium text-text">
                <Lightbulb className="size-3.5 text-accent-text" aria-hidden="true" />
                Suggested for this data
              </p>
              <ul className="mt-2 space-y-2">
                {suggestions.slice(0, 4).map((suggestion, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() =>
                        onChange({
                          type: suggestion.widget,
                          chart: suggestion.chart,
                          title: widget.title || suggestion.title,
                          query: suggestion.query,
                        })
                      }
                      className="w-full rounded-md border border-border bg-surface p-2 text-left transition-colors hover:border-accent hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-text capitalize">
                          {suggestion.chart ?? suggestion.widget}
                        </span>
                        <StatusChip tone="outline">
                          {Math.round(suggestion.confidence * 100)}% fit
                        </StatusChip>
                      </span>
                      {/* The rationale, on the card. Prompt 3.2. */}
                      <span className="mt-1 block text-[11px] leading-snug text-text-muted">
                        {suggestion.why}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {widget.type === "chart" ? (
            <FormField label="Chart type" name="widget-chart">
              <Select
                value={widget.chart ?? "bar"}
                onChange={(e) => onChange({ chart: e.target.value as ChartType })}
              >
                {CHART_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {widget.type !== "kpi" ? (
            <FormField
              label="Group by"
              name="widget-dimension"
              hint="The categories along the bottom of the chart, or the rows of the table."
            >
              <Select
                value={query.dimensions[0]?.column ?? ""}
                onChange={(e) =>
                  setQuery({
                    dimensions: e.target.value ? [{ column: e.target.value }] : [],
                  })
                }
                disabled={!dataset}
              >
                <option value="">Nothing</option>
                {groupable.map((column) => (
                  <option key={column.name} value={column.name}>
                    {columnLabel(column)} ({column.type})
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {query.dimensions[0] &&
          columns.find((c) => c.name === query.dimensions[0].column)?.type === "temporal" ? (
            <FormField label="Bucket dates by" name="widget-bucket">
              <Select
                value={query.dimensions[0].bucket ?? "month"}
                onChange={(e) =>
                  setQuery({
                    dimensions: [
                      {
                        ...query.dimensions[0],
                        bucket: e.target.value as "day" | "week" | "month" | "quarter" | "year",
                      },
                    ],
                  })
                }
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="quarter">Quarter</option>
                <option value="year">Year</option>
              </Select>
            </FormField>
          ) : null}

          <FormField
            label="Measure"
            name="widget-measure"
            hint="What is being counted or added up."
          >
            <div className="flex gap-2">
              <Select
                value={query.measures[0]?.agg ?? "count"}
                onChange={(e) => {
                  const agg = e.target.value as QuerySpec["measures"][number]["agg"];
                  const existing = query.measures[0];
                  setQuery({
                    measures: [
                      {
                        agg,
                        // `count` is the only aggregation that works without a
                        // column, so switching to it drops the column rather
                        // than leaving one the API would reject.
                        column: agg === "count" ? undefined : (existing?.column ?? measurable[0]?.name),
                        alias: existing?.alias ?? "Value",
                      },
                    ],
                  });
                }}
                disabled={!dataset}
              >
                <option value="count">Count of rows</option>
                <option value="sum">Sum</option>
                <option value="avg">Average</option>
                <option value="min">Minimum</option>
                <option value="max">Maximum</option>
                <option value="count_distinct">Distinct count</option>
              </Select>

              {query.measures[0] && query.measures[0].agg !== "count" ? (
                <Select
                  value={query.measures[0].column ?? ""}
                  onChange={(e) =>
                    setQuery({
                      measures: [{ ...query.measures[0], column: e.target.value }],
                    })
                  }
                >
                  <option value="">Pick a column</option>
                  {measurable.map((column) => (
                    <option key={column.name} value={column.name}>
                      {columnLabel(column)}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
          </FormField>

          <FormField label="Label for the measure" name="widget-alias">
            <Input
              value={query.measures[0]?.alias ?? ""}
              onChange={(e) =>
                query.measures[0]
                  ? setQuery({ measures: [{ ...query.measures[0], alias: e.target.value }] })
                  : undefined
              }
              placeholder="Value"
            />
          </FormField>

          <FilterEditor query={query} columns={columns} onChange={setQuery} />

          {widget.type === "kpi" ? (
            <FormField label="Format" name="widget-format">
              <Select
                value={widget.options.format ?? "number"}
                onChange={(e) =>
                  onChange({
                    options: {
                      ...widget.options,
                      format: e.target.value as NonNullable<Widget["options"]["format"]>,
                    },
                  })
                }
              >
                <option value="number">Number</option>
                <option value="currency">Currency</option>
                <option value="percent">Percentage</option>
                <option value="duration">Duration</option>
              </Select>
            </FormField>
          ) : null}

          {widget.type === "chart" ? (
            <div className="space-y-2">
              <MonoLabel>Appearance</MonoLabel>
              <Checkbox
                checked={widget.options.showLegend !== false}
                onChange={(e) =>
                  onChange({ options: { ...widget.options, showLegend: e.target.checked } })
                }
                label="Show legend"
              />
              <Checkbox
                checked={widget.options.showGrid !== false}
                onChange={(e) =>
                  onChange({ options: { ...widget.options, showGrid: e.target.checked } })
                }
                label="Show gridlines"
              />
              <Checkbox
                checked={widget.options.stacked === true}
                onChange={(e) =>
                  onChange({ options: { ...widget.options, stacked: e.target.checked } })
                }
                label="Stack series"
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <MonoLabel>Interaction</MonoLabel>
            <Checkbox
              checked={widget.respondsToPageFilters !== false}
              onChange={(e) => onChange({ respondsToPageFilters: e.target.checked })}
              label="React to filters on this page"
            />
            {widget.type === "chart" && query.dimensions[0] ? (
              <Checkbox
                checked={widget.options.filterKey === query.dimensions[0].column}
                onChange={(e) =>
                  onChange({
                    options: {
                      ...widget.options,
                      filterKey: e.target.checked ? query.dimensions[0].column : undefined,
                    },
                  })
                }
                label="Clicking this chart filters the page"
              />
            ) : null}
          </div>

          {/* Reference lines (prompt 3.3: "target lines"). One is enough for
              the shape people actually draw - "this is the target". */}
          {widget.type === "chart" ? (
            <FormField
              label="Target line"
              name="widget-annotation"
              hint="Draws a dashed reference line at this value. Leave blank for none."
            >
              <Input
                type="number"
                value={widget.options.annotations?.[0]?.value ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange({
                    options: {
                      ...widget.options,
                      annotations:
                        raw === ""
                          ? undefined
                          : [{ value: Number(raw), label: `Target ${raw}` }],
                    },
                  });
                }}
              />
            </FormField>
          ) : null}

          {canExport && widget.datasetId ? (
            <a
              href={`/owner/reports/builder/${reportId}/export/${widget.id}`}
              className="inline-block text-xs font-medium text-accent-text hover:underline"
            >
              Export this widget&rsquo;s data as CSV
            </a>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Filters applied BEFORE the chart is built (prompt 3.2).
 *
 * One filter at a time in the UI, though the spec supports twenty - the
 * commonest real need is "just the won ones" or "since January", and a filter
 * builder that starts as a grid is a filter builder nobody's first report
 * uses. The data model is not the limit here; the panel is, and it can grow.
 */
function FilterEditor({
  query,
  columns,
  onChange,
}: {
  query: QuerySpec;
  columns: ColumnMeta[];
  onChange: (patch: Partial<QuerySpec>) => void;
}) {
  const filter = query.filters[0];
  const column = columns.find((c) => c.name === filter?.column);

  return (
    <FormField
      label="Filter"
      name="widget-filter"
      hint="Applied before the chart is built, so the totals reflect it."
    >
      <div className="space-y-2">
        <Select
          value={filter?.column ?? ""}
          onChange={(e) =>
            onChange({
              filters: e.target.value
                ? [{ column: e.target.value, op: "eq", value: "" }]
                : [],
            })
          }
        >
          <option value="">No filter</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {columnLabel(c)}
            </option>
          ))}
        </Select>

        {filter ? (
          <div className="flex gap-2">
            <Select
              value={filter.op}
              onChange={(e) =>
                onChange({
                  filters: [{ ...filter, op: e.target.value as typeof filter.op }],
                })
              }
            >
              <option value="eq">is</option>
              <option value="neq">is not</option>
              <option value="contains">contains</option>
              {column?.type === "numeric" || column?.type === "temporal" ? (
                <>
                  <option value="gte">is at least</option>
                  <option value="lte">is at most</option>
                </>
              ) : null}
              <option value="not_null">has a value</option>
              <option value="is_null">is empty</option>
            </Select>

            {filter.op !== "is_null" && filter.op !== "not_null" ? (
              <Input
                value={String(filter.value ?? "")}
                onChange={(e) => onChange({ filters: [{ ...filter, value: e.target.value }] })}
                placeholder={column?.samples?.[0] ?? "value"}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </FormField>
  );
}
