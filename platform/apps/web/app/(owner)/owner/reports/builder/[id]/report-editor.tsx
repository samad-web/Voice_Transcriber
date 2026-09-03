"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  BarChart3,
  Hash,
  Minus,
  Plus,
  Printer,
  Redo2,
  Share2,
  Table2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Button, Card, MonoLabel, Select, StatusChip } from "@aura/ui";
import {
  AUTOSAVE_DEBOUNCE_MS,
  BUILT_IN_PALETTES,
  DESIGN_PRESETS,
  MAX_WIDGETS_PER_PAGE,
  paletteById,
  UNDO_DEPTH,
  type BindingIssue,
  type DesignPreset,
  type PageFilter,
  type Palette,
  type ReportDoc,
  type Widget,
  type WidgetType,
} from "@aura/shared";
import { CanvasGrid, nextFreeLayout, type GridItem } from "../canvas-grid";
import { ChartSurface, type WidgetResult } from "../chart-surface";
import { WidgetInspector, type DatasetOption } from "../widget-inspector";
import { runWidgetQueryAction, saveReportAction } from "../actions";
import { SharePanel, type Member, type ScheduleRow, type ShareRow } from "./share-panel";

/**
 * The canvas editor.
 *
 * ── STATE MODEL ─────────────────────────────────────────────────────────
 *
 * One `ReportDoc` in React state, plus a ring of previous documents for undo.
 * No Zustand, no Redux: the prompt asks for a store that "supports autosave
 * middleware and undo/redo history", and both of those are functions of a
 * single immutable document - `past`/`present`/`future` and a debounced effect.
 * Adding a store library would buy a devtools panel and a second place for the
 * document to live.
 *
 * ── WIDGET DATA IS FETCHED PER WIDGET, NOT PER PAGE ─────────────────────
 *
 * Each tile runs its own query keyed on a stable serialisation of (dataset,
 * query, page filters). Editing one widget re-fetches one widget; clicking a
 * bar re-fetches only the tiles that opted into the filter bus. A single
 * page-level fetch would redraw eight charts because somebody renamed an axis.
 */

interface ReportEditorProps {
  reportId: string;
  initial: {
    name: string;
    description: string | null;
    status: "draft" | "published" | "archived";
    revision: number;
    publishedVersion: number;
    hasLink: boolean;
    role: "owner" | "editor" | "viewer";
  };
  doc: ReportDoc;
  issues: BindingIssue[];
  datasets: DatasetOption[];
  customPalettes: Palette[];
  shares: ShareRow[];
  schedules: ScheduleRow[];
  members: Member[];
}

type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

export function ReportEditor({
  reportId,
  initial,
  doc: initialDoc,
  issues,
  datasets,
  customPalettes,
  shares,
  schedules,
  members,
}: ReportEditorProps) {
  const readOnly = initial.role === "viewer";

  const [doc, setDocState] = useState<ReportDoc>(initialDoc);
  const [past, setPast] = useState<ReportDoc[]>([]);
  const [future, setFuture] = useState<ReportDoc[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(initial.revision);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);

  /** Live click-filters. NOT part of the document - see design doc D3. */
  const [pageFilters, setPageFilters] = useState<PageFilter[]>([]);

  const page = doc.pages[Math.min(pageIndex, doc.pages.length - 1)];
  const palette = paletteById(doc.theme.paletteId, customPalettes);
  const brokenIds = useMemo(() => new Set(issues.map((i) => i.widgetId)), [issues]);

  // ── document mutation, with history ─────────────────────────────────────

  const setDoc = useCallback(
    (next: ReportDoc | ((current: ReportDoc) => ReportDoc)) => {
      if (readOnly) return;
      setDocState((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        if (resolved === current) return current;
        // The ring is capped rather than unbounded: a long editing session
        // otherwise holds every intermediate document in memory, and nobody
        // has ever needed the 200th undo.
        setPast((p) => [...p, current].slice(-UNDO_DEPTH));
        setFuture([]);
        return resolved;
      });
    },
    [readOnly],
  );

  const undo = () => {
    setPast((p) => {
      if (p.length === 0) return p;
      const previous = p[p.length - 1];
      setFuture((f) => [doc, ...f].slice(0, UNDO_DEPTH));
      setDocState(previous);
      return p.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture((f) => {
      if (f.length === 0) return f;
      setPast((p) => [...p, doc].slice(-UNDO_DEPTH));
      setDocState(f[0]);
      return f.slice(1);
    });
  };

  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z. Skipped while focus is in a text field,
  // where the browser's own undo is what the user means.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName)) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── autosave ────────────────────────────────────────────────────────────

  const savedRef = useRef(JSON.stringify(initialDoc));
  useEffect(() => {
    if (readOnly) return;
    const serialized = JSON.stringify(doc);
    if (serialized === savedRef.current) return;

    setSaveState("saving");

    // `void save()` rather than `setTimeout(async ...)`: a promise handed to a
    // callback expecting void is a rejection nothing will ever catch.
    const save = async () => {
      const result = await saveReportAction(reportId, { revision, doc });
      if (result.error) {
        // A 409 means somebody else saved first. Distinguished from an outage
        // because the fix is different: reload, versus try again.
        const conflict = /changed somewhere else/iu.test(result.error);
        setSaveState(conflict ? "conflict" : "error");
        setSaveError(result.error);
        return;
      }
      savedRef.current = serialized;
      setRevision(result.data?.report.revision ?? revision + 1);
      setSaveState("saved");
      setSaveError(null);
    };

    const timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [doc, reportId, revision, readOnly]);

  // ── widget data ─────────────────────────────────────────────────────────

  const [results, setResults] = useState<Record<string, WidgetResult>>({});

  /**
   * The query a widget actually runs: its own, plus the page's live filters if
   * it opted in. Merged here rather than in the widget so the fetch key and the
   * fetch itself can never disagree about what was asked for.
   */
  const effectiveQuery = useCallback(
    (widget: Widget) => {
      if (!widget.query) return null;
      if (widget.respondsToPageFilters === false || pageFilters.length === 0) return widget.query;
      return {
        ...widget.query,
        filters: [
          ...widget.query.filters,
          ...pageFilters.map((f) => ({ column: f.column, op: f.op, value: f.value })),
        ],
      };
    },
    [pageFilters],
  );

  // Read by the fetch effect, which must not re-run when these identities
  // change - only when `fetchKey` says the QUESTION changed.
  const widgetsRef = useRef({ widgets: page.widgets, query: effectiveQuery });
  widgetsRef.current = { widgets: page.widgets, query: effectiveQuery };

  const fetchKey = useMemo(
    () =>
      JSON.stringify(
        page.widgets.map((w) => [w.id, w.datasetId, effectiveQuery(w)]),
      ),
    [page.widgets, effectiveQuery],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      for (const widget of widgetsRef.current.widgets) {
        const query = widgetsRef.current.query(widget);
        if (!widget.datasetId || !query) continue;
        const result = await runWidgetQueryAction(widget.datasetId, query);
        if (cancelled) return;
        setResults((prev) => ({
          ...prev,
          [widget.id]: result.data
            ? (result.data as WidgetResult)
            : {
                rows: [],
                dimensionKeys: [],
                measureKeys: [],
                truncated: false,
                error: result.error ?? "Could not load this widget.",
              },
        }));
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
    // `fetchKey` is deliberately the ONLY dependency. It is a serialisation of
    // exactly what each widget is ASKING FOR, so it changes when a question
    // changes and not when a title or a colour does - depending on
    // `page.widgets` here would refetch all eight charts because somebody
    // renamed an axis label. The widgets themselves are read through a ref so
    // this stays honest rather than suppressed.
  }, [fetchKey]);

  // ── widget operations ───────────────────────────────────────────────────

  const patchPage = (mutate: (p: typeof page) => typeof page) =>
    setDoc((current) => ({
      ...current,
      pages: current.pages.map((p, i) => (i === pageIndex ? mutate(p) : p)),
    }));

  const addWidget = (type: WidgetType) => {
    if (page.widgets.length >= MAX_WIDGETS_PER_PAGE) return;
    const id = `w${Date.now().toString(36)}`;
    const widget: Widget = {
      id,
      type,
      chart: type === "chart" ? "bar" : undefined,
      title: type === "kpi" ? "New metric" : type === "table" ? "New table" : "New widget",
      layout: nextFreeLayout(
        page.widgets.map((w) => ({ id: w.id, layout: w.layout })),
        type === "kpi" ? 3 : 6,
        type === "kpi" ? 3 : type === "divider" ? 2 : 8,
      ),
      options: {},
      respondsToPageFilters: true,
      datasetId: null,
      placeholder:
        type === "chart"
          ? "Pick a data source, then a column to group by."
          : type === "kpi"
            ? "Pick a data source and something to count."
            : null,
    };
    patchPage((p) => ({ ...p, widgets: [...p.widgets, widget] }));
    setSelectedId(id);
  };

  const patchWidget = (id: string, patch: Partial<Widget>) =>
    patchPage((p) => ({
      ...p,
      widgets: p.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    }));

  const removeWidget = (id: string) => {
    patchPage((p) => ({ ...p, widgets: p.widgets.filter((w) => w.id !== id) }));
    setSelectedId(null);
  };

  const selected = page.widgets.find((w) => w.id === selectedId) ?? null;

  // ── pages ───────────────────────────────────────────────────────────────

  const addPage = () =>
    setDoc((current) => ({
      ...current,
      pages: [
        ...current.pages,
        {
          id: `p${Date.now().toString(36)}`,
          name: `Page ${current.pages.length + 1}`,
          widgets: [],
          filters: [],
        },
      ],
    }));

  const removePage = (index: number) => {
    if (doc.pages.length === 1) return;
    setDoc((current) => ({ ...current, pages: current.pages.filter((_, i) => i !== index) }));
    setPageIndex((i) => Math.max(0, Math.min(i, doc.pages.length - 2)));
  };

  // ── render ──────────────────────────────────────────────────────────────

  const gridItems: GridItem[] = page.widgets.map((w) => ({ id: w.id, layout: w.layout }));

  return (
    <div className="space-y-3">
      {/* ── toolbar ─────────────────────────────────────────────────────── */}
      <Card className="sticky top-0 z-20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <input
              value={doc ? initial.name : ""}
              readOnly
              className="min-w-0 truncate border-0 bg-transparent p-0 text-base font-semibold text-text focus:outline-none"
              aria-label="Report name"
            />
            <SaveBadge state={saveState} error={saveError} readOnly={readOnly} />
            {initial.status === "published" ? (
              <StatusChip tone="solid">v{initial.publishedVersion}</StatusChip>
            ) : (
              <StatusChip tone="outline">draft</StatusChip>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {readOnly ? null : (
              <>
                <Button variant="ghost" size="sm" onClick={undo} disabled={past.length === 0}>
                  <Undo2 className="size-3.5" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">Undo</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={redo} disabled={future.length === 0}>
                  <Redo2 className="size-3.5" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">Redo</span>
                </Button>
              </>
            )}

            <Select
              value={doc.theme.preset}
              onChange={(e) =>
                setDoc((c) => ({
                  ...c,
                  theme: { ...c.theme, preset: e.target.value as DesignPreset },
                }))
              }
              aria-label="Design preset"
              className="w-auto"
              disabled={readOnly}
            >
              {Object.values(DESIGN_PRESETS).map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </Select>

            <Select
              value={doc.theme.paletteId}
              onChange={(e) =>
                setDoc((c) => ({ ...c, theme: { ...c.theme, paletteId: e.target.value } }))
              }
              aria-label="Colour palette"
              className="w-auto"
              disabled={readOnly}
            >
              {[...BUILT_IN_PALETTES, ...customPalettes].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>

            <Link href={`/owner/reports/builder/${reportId}/print`} target="_blank">
              <Button variant="secondary" size="sm">
                <Printer className="size-3.5" aria-hidden="true" />
                PDF
              </Button>
            </Link>

            {initial.role === "owner" ? (
              <Button variant="secondary" size="sm" onClick={() => setShowShare(true)}>
                <Share2 className="size-3.5" aria-hidden="true" />
                Share
              </Button>
            ) : null}
          </div>
        </div>

        {/* The palette, visible. A dropdown of colour NAMES is unusable for
            choosing colours. */}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-text-subtle">Series colours</span>
          <span className="flex gap-1" aria-hidden="true">
            {palette.colors.slice(0, 6).map((color, i) => (
              <span
                key={i}
                className="size-3.5 rounded-sm border border-border"
                style={{ background: color }}
              />
            ))}
          </span>
        </div>
      </Card>

      {issues.length > 0 ? (
        <Card className="border-warning-text/30 bg-warning-subtle">
          <MonoLabel>{issues.length} widget{issues.length === 1 ? "" : "s"} need attention</MonoLabel>
          <p className="mt-1 text-xs text-warning-text">
            The data behind these changed shape. Nothing has been re-pointed automatically - pick
            the right column yourself so the numbers stay the numbers you meant.
          </p>
          <ul className="mt-2 space-y-1">
            {issues.slice(0, 6).map((issue, i) => (
              <li key={i} className="text-[11px] text-warning-text">
                <span className="font-medium">{issue.widgetTitle}</span> - {issue.message}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* ── page tabs ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {doc.pages.map((p, i) => (
          <span key={p.id} className="flex items-center">
            <button
              type="button"
              onClick={() => {
                setPageIndex(i);
                setPageFilters([]);
              }}
              className={`rounded-l-sm border px-2.5 py-1 text-xs font-medium transition-colors ${
                i === pageIndex
                  ? "border-accent bg-accent-subtle text-accent-text"
                  : "border-border bg-surface text-text-muted hover:bg-surface-hover"
              }`}
            >
              {p.name}
            </button>
            {readOnly || doc.pages.length === 1 ? null : (
              <button
                type="button"
                onClick={() => removePage(i)}
                aria-label={`Remove ${p.name}`}
                className="rounded-r-sm border border-l-0 border-border bg-surface px-1.5 py-1 text-text-subtle hover:bg-surface-hover hover:text-danger-text"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        {readOnly ? null : (
          <Button variant="ghost" size="sm" onClick={addPage}>
            <Plus className="size-3.5" aria-hidden="true" />
            Page
          </Button>
        )}
      </div>

      {/* ── the live filter bus (design doc D3) ─────────────────────────── */}
      {pageFilters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent-subtle px-3 py-2">
          <span className="text-xs font-medium text-accent-text">Filtering this page:</span>
          {pageFilters.map((filter, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPageFilters((f) => f.filter((_, j) => j !== i))}
              className="flex items-center gap-1 rounded-full border border-accent/40 bg-surface px-2 py-0.5 text-[11px] text-accent-text hover:bg-surface-hover"
            >
              {filter.column} = {String(filter.value)}
              <X className="size-3" aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPageFilters([])}
            className="text-[11px] text-text-muted underline hover:text-text"
          >
            Clear all
          </button>
        </div>
      ) : null}

      <div className="flex gap-3">
        {/* ── canvas ───────────────────────────────────────────────────── */}
        <div className="min-w-0 flex-1">
          {readOnly ? null : (
            <div className="mb-2 flex flex-wrap gap-1.5">
              <AddButton icon={BarChart3} label="Chart" onClick={() => addWidget("chart")} />
              <AddButton icon={Hash} label="Metric" onClick={() => addWidget("kpi")} />
              <AddButton icon={Table2} label="Table" onClick={() => addWidget("table")} />
              <AddButton icon={Type} label="Note" onClick={() => addWidget("text")} />
              <AddButton icon={Minus} label="Divider" onClick={() => addWidget("divider")} />
              {page.widgets.length >= MAX_WIDGETS_PER_PAGE ? (
                <span className="self-center text-[11px] text-text-subtle">
                  {MAX_WIDGETS_PER_PAGE} widgets is the limit for one page - add another page.
                </span>
              ) : null}
            </div>
          )}

          {page.widgets.length === 0 ? (
            <Card>
              <p className="py-8 text-center text-sm text-text-muted">
                Nothing on this page yet. Add a chart, a metric or a table above.
              </p>
            </Card>
          ) : (
            <CanvasGrid
              items={gridItems}
              selectedId={selectedId}
              onSelect={setSelectedId}
              frozen={readOnly}
              onChange={(id, layout) => patchWidget(id, { layout })}
            >
              {(item) => {
                const widget = page.widgets.find((w) => w.id === item.id);
                if (!widget) return null;
                return (
                  <div className="flex h-full flex-col p-3">
                    {widget.title ? (
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-text">{widget.title}</p>
                          {widget.subtitle ? (
                            <p className="truncate text-[11px] text-text-muted">
                              {widget.subtitle}
                            </p>
                          ) : null}
                        </div>
                        {brokenIds.has(widget.id) ? (
                          <StatusChip tone="danger">check mapping</StatusChip>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="min-h-0 flex-1">
                      <ChartSurface
                        widget={widget}
                        result={results[widget.id]}
                        palette={palette}
                        preset={doc.theme.preset}
                        onFilter={(column, value) =>
                          setPageFilters((f) =>
                            f.some((x) => x.column === column && x.value === value)
                              ? f
                              : [...f, { column, op: "eq", value, sourceWidgetId: widget.id }],
                          )
                        }
                      />
                    </div>
                  </div>
                );
              }}
            </CanvasGrid>
          )}
        </div>

        {/* ── inspector ────────────────────────────────────────────────── */}
        {selected && !readOnly ? (
          <aside className="w-80 shrink-0">
            <Card className="sticky top-32 max-h-[calc(100vh-10rem)] overflow-y-auto">
              <WidgetInspector
                widget={selected}
                datasets={datasets}
                reportId={reportId}
                canExport={initial.role !== "viewer"}
                onChange={(patch) => patchWidget(selected.id, patch)}
                onDelete={() => removeWidget(selected.id)}
              />
            </Card>
          </aside>
        ) : null}
      </div>

      {showShare ? (
        <SharePanel
          reportId={reportId}
          open={showShare}
          onClose={() => setShowShare(false)}
          status={initial.status}
          hasLink={initial.hasLink}
          shares={shares}
          schedules={schedules}
          members={members}
        />
      ) : null}
    </div>
  );
}

function AddButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof BarChart3;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant="secondary" size="sm" onClick={onClick}>
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * The save indicator.
 *
 * Four states, not two. "Saving" and "Saved" are the ordinary pair; "conflict"
 * and "error" are different problems with different fixes, and collapsing them
 * into one red dot means the person has to guess which. Prompt 3.7: no silent
 * failures - and an autosave that quietly stops working is the quietest failure
 * a document editor has.
 */
function SaveBadge({
  state,
  error,
  readOnly,
}: {
  state: SaveState;
  error: string | null;
  readOnly: boolean;
}) {
  if (readOnly) return <StatusChip tone="muted">read only</StatusChip>;
  if (state === "saving") return <StatusChip tone="outline">saving…</StatusChip>;
  if (state === "saved") return <StatusChip tone="muted">saved</StatusChip>;
  if (state === "conflict") {
    return (
      <span className="flex items-center gap-1.5">
        <StatusChip tone="danger">not saved</StatusChip>
        <span className="text-[11px] text-danger-text">
          {error} <button type="button" onClick={() => location.reload()} className="underline">
            Reload
          </button>
        </span>
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="flex items-center gap-1.5">
        <StatusChip tone="danger">not saved</StatusChip>
        <span className="text-[11px] text-danger-text">{error}</span>
      </span>
    );
  }
  return null;
}
