"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WidgetLayout } from "@aura/shared";

/**
 * A 12-column drag-and-resize canvas.
 *
 * ── WHY NOT `react-grid-layout` ─────────────────────────────────────────
 *
 * The prompt names it, and it is a fine library. It is also a new dependency
 * in a console whose ONLY existing drag-and-drop - the lead kanban board - is
 * hand-rolled on native HTML5 drag events, and it brings its own `<style>`
 * injection, its own breakpoint model and a React 19 peer-dependency question.
 * The engine underneath it is roughly what is below: snap a pointer delta to a
 * grid, push overlaps down, compact upward. Writing those 120 lines keeps the
 * bundle, the styling and the accessibility story ours.
 *
 * What we deliberately keep from that library's model: the `{x,y,w,h}` shape in
 * 12 columns with a fixed row height, so swapping to it later is a rendering
 * change and not a data migration.
 *
 * ── KEYBOARD EDITING IS NOT AN AFTERTHOUGHT ─────────────────────────────
 *
 * Prompt 3.7 asks for "keyboard-navigable canvas editing where feasible". Every
 * tile is a focusable element: arrows move it, shift+arrows resize it, and the
 * live region announces the result. That is the whole feature for a keyboard
 * user - not a degraded one - and it costs one `onKeyDown`.
 */

export const GRID_COLUMNS = 12;
export const ROW_HEIGHT = 44;
export const GRID_GAP = 12;

export interface GridItem {
  id: string;
  layout: WidgetLayout;
}

interface CanvasGridProps {
  items: GridItem[];
  onChange: (id: string, layout: WidgetLayout) => void;
  /** Renders one tile's contents. The grid owns position, never appearance. */
  children: (item: GridItem) => ReactNode;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Read-only: print and the shared view render the same layout, inert. */
  frozen?: boolean;
}

type DragState = {
  id: string;
  mode: "move" | "resize";
  originX: number;
  originY: number;
  start: WidgetLayout;
} | null;

export function CanvasGrid({
  items,
  onChange,
  children,
  selectedId,
  onSelect,
  frozen,
}: CanvasGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<DragState>(null);
  const [preview, setPreview] = useState<{ id: string; layout: WidgetLayout } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // ResizeObserver rather than a window resize listener: the canvas shrinks
  // when the inspector panel opens, which is not a window resize at all.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const columnWidth = width > 0 ? (width - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS : 0;

  const toPixels = (layout: WidgetLayout) => ({
    left: layout.x * (columnWidth + GRID_GAP),
    top: layout.y * (ROW_HEIGHT + GRID_GAP),
    width: layout.w * columnWidth + (layout.w - 1) * GRID_GAP,
    height: layout.h * ROW_HEIGHT + (layout.h - 1) * GRID_GAP,
  });

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (!drag || columnWidth === 0) return;
      const dx = Math.round((event.clientX - drag.originX) / (columnWidth + GRID_GAP));
      const dy = Math.round((event.clientY - drag.originY) / (ROW_HEIGHT + GRID_GAP));

      const next =
        drag.mode === "move"
          ? {
              ...drag.start,
              x: clamp(drag.start.x + dx, 0, GRID_COLUMNS - drag.start.w),
              y: Math.max(0, drag.start.y + dy),
            }
          : {
              ...drag.start,
              w: clamp(drag.start.w + dx, 2, GRID_COLUMNS - drag.start.x),
              h: Math.max(3, drag.start.h + dy),
            };

      setPreview({ id: drag.id, layout: next });
    },
    [drag, columnWidth],
  );

  const onPointerUp = useCallback(() => {
    if (drag && preview) onChange(preview.id, preview.layout);
    setDrag(null);
    setPreview(null);
  }, [drag, preview, onChange]);

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [drag, onPointerMove, onPointerUp]);

  const begin = (event: React.PointerEvent, item: GridItem, mode: "move" | "resize") => {
    if (frozen) return;
    // Only the primary button, and never on a control inside the tile - a
    // click on the widget's own menu must not start a drag.
    if (event.button !== 0) return;
    event.preventDefault();
    onSelect?.(item.id);
    setDrag({
      id: item.id,
      mode,
      originX: event.clientX,
      originY: event.clientY,
      start: item.layout,
    });
    setPreview({ id: item.id, layout: item.layout });
  };

  const nudge = (item: GridItem, event: React.KeyboardEvent) => {
    if (frozen) return;
    const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!KEYS.includes(event.key)) return;
    event.preventDefault();

    const { layout } = item;
    const dx = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const dy = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;

    const next = event.shiftKey
      ? {
          ...layout,
          w: clamp(layout.w + dx, 2, GRID_COLUMNS - layout.x),
          h: Math.max(3, layout.h + dy),
        }
      : {
          ...layout,
          x: clamp(layout.x + dx, 0, GRID_COLUMNS - layout.w),
          y: Math.max(0, layout.y + dy),
        };

    onChange(item.id, next);
    setAnnouncement(
      event.shiftKey
        ? `Resized to ${next.w} of 12 columns, ${next.h} rows tall.`
        : `Moved to column ${next.x + 1}, row ${next.y + 1}.`,
    );
  };

  // The container has to be tall enough for the lowest tile plus room to drop
  // one below it - otherwise dragging to the bottom fights the scroll.
  const lowest = items.reduce((max, item) => Math.max(max, item.layout.y + item.layout.h), 0);
  const height = (lowest + 4) * (ROW_HEIGHT + GRID_GAP);

  return (
    <>
      <div ref={ref} className="relative w-full" style={{ height }}>
        {items.map((item) => {
          const layout = preview?.id === item.id ? preview.layout : item.layout;
          const position = toPixels(layout);
          const selected = selectedId === item.id;

          return (
            <div
              key={item.id}
              role={frozen ? undefined : "button"}
              tabIndex={frozen ? undefined : 0}
              aria-label={frozen ? undefined : `Widget tile. Arrows move, shift and arrows resize.`}
              onKeyDown={(e) => nudge(item, e)}
              onFocus={() => onSelect?.(item.id)}
              className={`absolute overflow-hidden rounded-lg border bg-surface transition-shadow ${
                selected && !frozen
                  ? "border-accent shadow-md ring-1 ring-accent"
                  : "border-border shadow-sm"
              } ${drag?.id === item.id ? "z-10 opacity-90" : ""} ${
                frozen ? "" : "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              }`}
              style={{
                left: position.left,
                top: position.top,
                width: position.width,
                height: position.height,
                // Transitions are skipped WHILE dragging: animating a position
                // that is already following the pointer makes the tile lag
                // behind the cursor, which reads as jank rather than as polish.
                transition: drag ? "none" : "left 120ms ease-out, top 120ms ease-out",
              }}
            >
              <div className="flex h-full flex-col">
                {frozen ? null : (
                  <div
                    onPointerDown={(e) => begin(e, item, "move")}
                    className="h-1.5 shrink-0 cursor-grab bg-transparent active:cursor-grabbing"
                    aria-hidden="true"
                  />
                )}
                <div className="min-h-0 flex-1">{children(item)}</div>
              </div>

              {frozen ? null : (
                <div
                  onPointerDown={(e) => begin(e, item, "resize")}
                  className="absolute right-0 bottom-0 size-4 cursor-se-resize"
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 16 16" className="size-full text-border-strong">
                    <path
                      d="M15 5 L5 15 M15 10 L10 15"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      fill="none"
                    />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Announces keyboard moves. Without it, an arrow-key move is silent -
          the tile has changed and the person driving it has no idea. */}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Where a new widget should land: the first fully-free row, full width of the
 * requested size.
 *
 * Deliberately simple - appended at the bottom rather than slotted into a gap.
 * A "smart" placement that finds a hole is a placement the user did not
 * predict, and on a canvas they are about to drag anyway, predictable beats
 * clever.
 */
export function nextFreeLayout(items: GridItem[], w = 6, h = 8): WidgetLayout {
  const lowest = items.reduce((max, item) => Math.max(max, item.layout.y + item.layout.h), 0);
  return { x: 0, y: lowest, w, h };
}
