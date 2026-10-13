import type { SeriesKey } from "@/lib/ceo-dashboard";

/**
 * The four series and the hues the pace chart draws them in (Build docs/46).
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 *
 * It used to live in `series-strip.tsx`, which was fine while that was a
 * server component. The moment the strip took `"use client"` the import broke
 * at RUNTIME and not at build: a Server Component importing from a client
 * module gets client REFERENCE stubs, not the values, so `SERIES_OPTIONS.calls`
 * was `undefined` and the dashboard 500'd on `.label`.
 *
 * Typecheck cannot see that - the types are real, only the runtime values are
 * proxies. So the constant lives in a module with no directive, which both
 * sides may import for what it actually is.
 */

export interface SeriesOption {
  key: SeriesKey;
  label: string;
  /** The figure for the whole window, already formatted. */
  value: string;
  /** One line under it - the comparison, or what the figure is a share of. */
  context: string;
  /**
   * The series' own fill, as a literal class pair (Tailwind v4 cannot see a
   * computed one). Selected tiles paint in it so the strip doubles as the
   * chart's legend and the plot needs no second one.
   */
  fill: string;
  on: string;
}

export const SERIES_OPTIONS: Record<SeriesKey, Pick<SeriesOption, "label" | "fill" | "on">> = {
  calls: { label: "Calls", fill: "bg-outgoing", on: "text-white" },
  leads: { label: "New leads", fill: "bg-kpi", on: "text-kpi-fg" },
  yield: { label: "Leads / 100 calls", fill: "bg-chart-cat-3", on: "text-white" },
  missed: { label: "Missed inbound", fill: "bg-danger", on: "text-danger-fg" },
};
