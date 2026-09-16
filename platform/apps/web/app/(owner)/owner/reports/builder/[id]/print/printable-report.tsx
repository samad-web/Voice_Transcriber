"use client";

import { useEffect } from "react";
import { paletteById, type ReportDoc } from "@aura/shared";
import { ChartSurface, type WidgetResult } from "../../chart-surface";
import { GRID_GAP, GRID_COLUMNS, ROW_HEIGHT } from "../../canvas-grid";

/**
 * The report, laid out for paper.
 *
 * ── WHY THIS IS NOT THE EDITOR CANVAS WITH A PRINT STYLESHEET ───────────
 *
 * The editor positions tiles absolutely, which paginates badly: an absolutely
 * positioned element has no relationship to a page break, so a tall page
 * produces one enormous sheet and a lot of white space. So print re-lays the
 * same document into a normal block flow using CSS grid rows sized from the
 * widget's own `h` - the layout is recognisably the same report, and every
 * tile is a block the pagination engine can reason about.
 *
 * `break-inside: avoid` is applied to each tile rather than to a wrapper, and
 * the grid is `grid-auto-flow: row` rather than flex, because `break-inside`
 * is unreliable inside flex containers across engines (design doc D1).
 */
export function PrintableReport({
  name,
  doc,
  widgets,
  generatedAt,
  failures,
  orgName,
  autoPrint = true,
}: {
  name: string;
  doc: ReportDoc;
  widgets: Record<string, WidgetResult>;
  generatedAt: string;
  failures: string[];
  orgName: string;
  /**
   * Whether mounting opens the print dialog. True for the standalone `/print`
   * route, whose entire purpose is that; false when the editor mounts this
   * hidden and drives the dialog itself, where a second `window.print()` from
   * in here would open two.
   */
  autoPrint?: boolean;
}) {
  // Opens the print dialog once, after paint. `requestAnimationFrame` twice:
  // the first fires before the browser has laid the SVGs out, and printing
  // then captures empty chart boxes.
  useEffect(() => {
    if (!autoPrint) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    return () => cancelAnimationFrame(id);
  }, [autoPrint]);

  const palette = paletteById(doc.theme.paletteId);

  return (
    <>
      <style>{`
        @page { size: A4; margin: 14mm; }
        @media print {
          /* The console chrome - sidebar, nav, the print button itself - is
             not part of the document somebody is sending a client. */
          .print-hide { display: none !important; }
          body { background: #fff; }
          .print-tile { break-inside: avoid; page-break-inside: avoid; }
          .print-page { break-after: page; page-break-after: page; }
          .print-page:last-child { break-after: auto; page-break-after: auto; }
          /* Recharts renders real SVG, so this is a hint about backgrounds
             and fills rather than a rasterisation workaround. */
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          details { display: block; }
          details > summary { display: none; }
        }
      `}</style>

      <div className="print-hide mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg-subtle px-4 py-3">
        <p className="text-sm text-text-muted">
          Your browser&rsquo;s print dialog should have opened. Choose{" "}
          <span className="font-medium text-text">Save as PDF</span> as the destination.
        </p>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-hover"
        >
          Print again
        </button>
      </div>

      {failures.length > 0 ? (
        <div className="print-hide mb-4 rounded-md border border-warning-text/30 bg-warning-subtle px-4 py-3">
          <p className="text-xs font-medium text-warning-text">
            {failures.length} widget{failures.length === 1 ? "" : "s"} could not be built. They
            appear in the PDF with an explanation rather than being left blank.
          </p>
        </div>
      ) : null}

      <article className="mx-auto max-w-[210mm] bg-white text-black">
        {doc.pages.map((page, index) => (
          <section key={page.id} className="print-page mb-8">
            {/* A running header on every sheet: which report, whose, and as of
                when. A page of charts with no date on it is a page of charts
                somebody will still be circulating next quarter. */}
            <header className="mb-4 flex items-baseline justify-between border-b border-neutral-300 pb-2">
              <div>
                <h1 className="text-lg font-semibold text-neutral-900">{name}</h1>
                <p className="text-[10px] text-neutral-500">
                  {orgName} · {page.name} · page {index + 1} of {doc.pages.length}
                </p>
              </div>
              <p className="text-[10px] text-neutral-500">
                Generated {new Date(generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
              </p>
            </header>

            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
                gap: GRID_GAP,
              }}
            >
              {[...page.widgets]
                // Reading order, not authoring order: top to bottom, then left
                // to right. A widget added last but dragged to the top must
                // print first, or the PDF disagrees with the screen.
                .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
                .map((widget) => (
                  <div
                    key={widget.id}
                    className="print-tile rounded-md border border-neutral-300 p-3"
                    style={{
                      gridColumn: `span ${widget.layout.w} / span ${widget.layout.w}`,
                      minHeight: widget.layout.h * ROW_HEIGHT,
                    }}
                  >
                    {widget.title ? (
                      <p className="mb-1 text-xs font-semibold text-neutral-900">{widget.title}</p>
                    ) : null}
                    {widget.subtitle ? (
                      <p className="mb-1 text-[10px] text-neutral-500">{widget.subtitle}</p>
                    ) : null}
                    <div style={{ height: widget.layout.h * ROW_HEIGHT - 40 }}>
                      <ChartSurface
                        widget={widget}
                        result={widgets[widget.id]}
                        palette={palette}
                        preset={doc.theme.preset}
                        frozen
                      />
                    </div>
                  </div>
                ))}
            </div>
          </section>
        ))}
      </article>
    </>
  );
}
