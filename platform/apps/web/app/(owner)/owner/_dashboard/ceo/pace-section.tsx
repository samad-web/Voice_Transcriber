"use client";

import { useCallback, useState } from "react";
import type { ForecastDay, Grain, SeriesKey } from "@/lib/ceo-dashboard";
import { PaceChart, type PaneSpec } from "./pace-chart";
import type { SeriesOption } from "./series-options";
import { SeriesStrip } from "./series-strip";

/**
 * The series strip and the pace chart, with the toggles as CLIENT state
 * (Build docs/46).
 *
 * ── WHY THIS IS THE ONE PLACE THE URL STOPPED BEING THE STATE ───────────────
 *
 * Everything else on this console keeps its view in the query string, and
 * these controls did too at first. They were links; each click was a server
 * navigation. That is the right trade for the DATE RANGE, which changes what
 * is fetched - but it is the wrong one here, because these three controls
 * change nothing about the data. Every series for both grains is already
 * computed and already in this component's props. The round trip re-rendered
 * the whole page to draw a line that was sitting in memory, and the reader
 * watched the dashboard blank and come back to pick a checkbox.
 *
 * So the state is local and the redraw is immediate.
 *
 * ── AND WHY THE URL STILL TRACKS IT ─────────────────────────────────────────
 *
 * A dashboard somebody has set up is one they send to their co-founder, and
 * losing that was not worth the speed. `window.history.replaceState` writes
 * the query string WITHOUT telling the router, so Next does not re-render and
 * nothing refetches - supported deliberately since 14.1 for exactly this. The
 * link stays shareable, a reload restores the view, and the page never moves.
 *
 * `replaceState`, not `pushState`: ticking four checkboxes should not put four
 * entries in the back stack between the reader and the page they came from.
 *
 * The server still parses the query string on first load and passes the result
 * in as the initial state, so a shared link opens on the right series.
 */
export function PaceSection({
  options,
  initialSeries,
  initialGrain,
  initialCompare,
  /** Pane specs for BOTH grains, every series - keyed so the client only picks. */
  panesByGrain,
  bucketsByGrain,
  forecastDays,
  insight,
  clock,
}: {
  options: readonly SeriesOption[];
  initialSeries: SeriesKey[];
  initialGrain: Grain;
  initialCompare: boolean;
  panesByGrain: Record<Grain, Record<SeriesKey, PaneSpec>>;
  bucketsByGrain: Record<Grain, React.ComponentProps<typeof PaceChart>["buckets"]>;
  forecastDays: readonly ForecastDay[];
  insight: string | null;
  clock: string;
}) {
  const [series, setSeries] = useState<SeriesKey[]>(initialSeries);
  const [grain, setGrain] = useState<Grain>(initialGrain);
  const [compare, setCompare] = useState(initialCompare);

  /**
   * Mirror the view into the address bar without routing.
   *
   * Reads the CURRENT location rather than a captured one, so the date range -
   * which is a real navigation and can change under this component - is never
   * clobbered by a stale copy of the query string.
   */
  const syncUrl = useCallback((next: { series: SeriesKey[]; grain: Grain; compare: boolean }) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    // Only non-default values ride in the URL, so an untouched dashboard keeps
    // a clean address and the default can be changed later without stranding
    // every bookmark on the old one.
    if (next.series.join(",") === "calls,leads") params.delete("series");
    else params.set("series", next.series.join(","));
    if (next.grain === "daily") params.delete("grain");
    else params.set("grain", next.grain);
    if (next.compare) params.set("compare", "1");
    else params.delete("compare");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, []);

  const onSeries = useCallback(
    (key: SeriesKey) => {
      setSeries((current) => {
        // The last series can never be turned off: an empty plot is not a view
        // anybody asked for, and no control should be able to produce one.
        const next = current.includes(key)
          ? current.length === 1
            ? current
            : current.filter((k) => k !== key)
          : [...current, key];
        syncUrl({ series: next, grain, compare });
        return next;
      });
    },
    [grain, compare, syncUrl],
  );

  const onGrain = useCallback(
    (next: Grain) => {
      setGrain(next);
      syncUrl({ series, grain: next, compare });
    },
    [series, compare, syncUrl],
  );

  const onCompare = useCallback(() => {
    setCompare((current) => {
      syncUrl({ series, grain, compare: !current });
      return !current;
    });
  }, [series, grain, syncUrl]);

  // Drawn in the strip's own order, not the order they were ticked - so the
  // legend and the plot keep a stable sequence however the reader got here.
  const panes = options
    .map((o) => o.key)
    .filter((k) => series.includes(k))
    .map((k) => panesByGrain[grain][k]);

  return (
    <>
      <SeriesStrip
        options={options}
        selected={series}
        grain={grain}
        compare={compare}
        onToggleSeries={onSeries}
        onGrain={onGrain}
        onCompare={onCompare}
      />
      <PaceChart
        buckets={bucketsByGrain[grain]}
        forecastDays={forecastDays}
        panes={panes}
        grain={grain}
        compare={compare}
        insight={insight}
        clock={clock}
      />
    </>
  );
}
