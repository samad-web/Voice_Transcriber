import type { ReactNode } from "react";
import { STATE_TONE, type ConsoleState } from "@aura/ui";
import { deltaText, type Delta } from "@/lib/dashboard-charts";

/**
 * The pieces every dashboard chart is assembled from (Build docs/29 §5).
 *
 * Server-rendered HTML and CSS, no chart library and no client JavaScript:
 * hover is `group-hover`, so a chart paints complete in the server HTML and
 * never pops in after hydration (docs/29 P6). Keyboard and screen-reader
 * readers get the table twin instead of ninety tab stops across a plot.
 */

/** The tooltip box. Value first and strong, label second (dataviz interaction rule). */
export const TOOLTIP_BOX =
  "pointer-events-none invisible absolute z-20 w-max max-w-[16rem] rounded-md border border-border bg-surface px-3 py-2 text-left text-xs text-text-muted shadow-md";

/** The box, shown while its nearest `group` is hovered. A mark inside a hoverable ROW uses a named group instead. */
export const TOOLTIP = `${TOOLTIP_BOX} group-hover:visible`;

/** Tooltips near an edge open inward so they never leave the card. */
export function edgeAlign(index: number, count: number): string {
  if (index < count / 3) return "left-0";
  if (index >= (2 * count) / 3) return "right-0";
  return "left-1/2 -translate-x-1/2";
}

/** Axis and tick text - recessive, aligned figures. */
export const AXIS_TEXT = "text-[11px] text-text-subtle tabular-nums";

/**
 * A legend or tooltip swatch for a call STATE: its chart colour plus its glyph,
 * never colour alone. The swatch is a SQUARE (2px corners, not the theme's 6px
 * rounded-sm, which turns a 10px swatch into a dot) so it reads as "the bars
 * are this colour" and never as a second glyph beside the real one.
 */
export function StateKey({ state, label, line = false }: { state: ConsoleState; label: ReactNode; line?: boolean }) {
  const tone = STATE_TONE[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
      <span aria-hidden="true" className={`${line ? "h-0.5 w-3" : "h-2.5 w-2.5 rounded-[2px]"} ${tone.mark}`} />
      <svg aria-hidden="true" viewBox="0 0 10 10" className={`h-2.5 w-2.5 ${tone.text}`}>
        {tone.glyph}
      </svg>
      {label}
    </span>
  );
}

/** A legend swatch for a neutral series. `line` draws the key as a stroke (a line series). */
export function SwatchKey({ swatch, label, line = false }: { swatch: string; label: ReactNode; line?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
      <span aria-hidden="true" className={`${line ? "h-0.5 w-3.5 rounded-full" : "h-2.5 w-2.5 rounded-[2px]"} ${swatch}`} />
      {label}
    </span>
  );
}

/**
 * A change against the previous window, as a glyph and words (docs/29 P2 -
 * never green/red, which mean answered/missed here). The glyph is hidden from
 * screen readers, which hear "up"/"down" instead of "black up-pointing
 * triangle".
 */
export function DeltaNote({ delta, days, unit = "%" }: { delta: Delta | null; days: number; unit?: "%" | " pts" }) {
  if (!delta) return null;
  const text = deltaText(delta, days, unit);
  if (delta.kind !== "up" && delta.kind !== "down") return <span>{text}</span>;
  return (
    <span>
      <span aria-hidden="true">{text.slice(0, 1)}</span>
      <span className="sr-only">{delta.kind === "up" ? "up" : "down"}</span>
      {text.slice(1)}
    </span>
  );
}

/** The table twin every chart carries (docs/29 P5). Collapsed; the chart is the default view. */
export function ChartTable({ children }: { children: ReactNode }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-text-muted transition-colors duration-150 ease-out hover:text-text">
        Show as table
      </summary>
      <div className="mt-2 max-h-72 overflow-auto">{children}</div>
    </details>
  );
}

/** Header/body cell classes for the table twins, so every twin reads the same. */
export const TH = "border-b border-border px-2 py-1.5 text-left font-medium text-text-muted whitespace-nowrap";
export const TH_NUM = `${TH} text-right`;
export const TD = "px-2 py-1.5 text-text whitespace-nowrap";
export const TD_NUM = `${TD} text-right tabular-nums`;

/** One plain sentence that says what the chart shows (docs/29 P7). */
export function Insight({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text">{children}</p>;
}
