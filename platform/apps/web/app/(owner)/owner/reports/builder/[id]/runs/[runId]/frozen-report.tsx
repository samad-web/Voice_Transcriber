"use client";

import { paletteById, type ReportDoc } from "@aura/shared";
import { Card } from "@aura/ui";
import { ChartSurface, type WidgetResult } from "../../../chart-surface";
import { CanvasGrid, type GridItem } from "../../../canvas-grid";

/**
 * A run, rendered.
 *
 * The same `CanvasGrid` and `ChartSurface` the editor uses, with `frozen` on -
 * one layout engine and one renderer, so a run cannot look different from the
 * report it came from. Duplicating either for a read-only view is how the two
 * drift, and a scheduled report that does not match the live one is the kind of
 * discrepancy that costs somebody an afternoon proving the numbers are fine.
 */
export function FrozenReport({
  doc,
  widgets,
}: {
  doc: ReportDoc;
  widgets: Record<string, WidgetResult>;
}) {
  const palette = paletteById(doc.theme.paletteId);

  return (
    <>
      {doc.pages.map((page) => {
        const items: GridItem[] = page.widgets.map((w) => ({ id: w.id, layout: w.layout }));
        return (
          <Card key={page.id}>
            <p className="mb-2 text-xs font-medium text-text">{page.name}</p>
            {page.widgets.length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">Nothing on this page.</p>
            ) : (
              <CanvasGrid items={items} onChange={() => {}} frozen>
                {(item) => {
                  const widget = page.widgets.find((w) => w.id === item.id);
                  if (!widget) return null;
                  return (
                    <div className="flex h-full flex-col p-3">
                      {widget.title ? (
                        <div className="mb-1">
                          <p className="truncate text-xs font-medium text-text">{widget.title}</p>
                          {widget.subtitle ? (
                            <p className="truncate text-[11px] text-text-muted">
                              {widget.subtitle}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="min-h-0 flex-1">
                        <ChartSurface
                          widget={widget}
                          result={widgets[widget.id]}
                          palette={palette}
                          preset={doc.theme.preset}
                          frozen
                        />
                      </div>
                    </div>
                  );
                }}
              </CanvasGrid>
            )}
          </Card>
        );
      })}
    </>
  );
}
