import { cx } from "./cx";

/**
 * A tiny inline bar sparkline for a KPI tile's trailing series (Platform Hub
 * dashboard overhaul).
 *
 * Plain SVG, server-rendered, no chart library and no client JS - the same
 * convention the owner console's own dashboard charts already use
 * (`app/(owner)/owner/_dashboard/chart-parts.tsx`): a KPI tile is not the
 * place for a `ResponsiveContainer` and a hydration boundary over seven
 * numbers.
 *
 * ── WHY TWO COLOUR MODES ────────────────────────────────────────────────────
 *
 * This is a MAGNITUDE mark, not a state - nobody's business is "up" or "down"
 * in colour here, just bigger or smaller bars - so it never reaches for
 * `--color-success`/`--color-danger`/etc. (the functional colour system,
 * `state.tsx`, reserves hue for missed/answered/outgoing/error and nothing
 * else).
 *
 * `--color-chart-seq-3` (the sequential grey ramp, already dark-mode bound) is
 * right on a plain surface, but it is TUNED AGAINST `--color-surface`/
 * `--color-text` and goes invisible on `StatCard`'s solid `--color-kpi` fill -
 * so inside a filled tile this reuses `--color-kpi-hairline`, the same token
 * the tile's own icon tint and divider already spend (3.91:1 on the fill,
 * past the 3:1 graphic floor - see theme.css's note on that token).
 *
 * ── WHY IT IS aria-hidden ────────────────────────────────────────────────────
 *
 * Decorative next to a headline number that already states the fact in text
 * (the tile's `value`/`context`/`trend`) - the same treatment every other
 * decorative glyph in the kit gets (`StateKey`'s icon, `StatCard`'s own icon
 * slot). A sparkline that were the ONLY place a number lived would need a
 * table twin instead; this one never is.
 */
export interface SparklineProps {
  /** Oldest first. Fewer than 2 points renders nothing - a single bar has no
   *  trend to show and would just look like a broken chart. */
  values: readonly number[];
  /** Draw on the KPI fill (`--color-kpi-hairline`) instead of a plain surface
   *  (`--color-chart-seq-3`). Match the `StatCard` it sits inside. */
  filled?: boolean;
  className?: string;
}

const WIDTH = 64;
const HEIGHT = 20;
const GAP = 2;

export function Sparkline({ values, filled = false, className = "" }: SparklineProps) {
  if (values.length < 2) return null;

  const max = Math.max(...values, 0);
  const barWidth = (WIDTH - GAP * (values.length - 1)) / values.length;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      // Colour via `currentColor` + a `text-*` token on the wrapper, the same
      // convention every glyph in `state.tsx`/`state-chip.tsx` uses, rather
      // than a `fill-*` utility this codebase has never otherwise generated.
      className={cx("h-5 w-16 shrink-0", filled ? "text-kpi-hairline" : "text-chart-seq-3", className)}
      preserveAspectRatio="none"
    >
      {values.map((v, i) => {
        // A non-zero value never draws shorter than 2px - "a little" and
        // "none" must stay visually different, same floor `barPercent` in
        // apps/web's dashboard-charts.ts applies to the full-size charts.
        const h = max > 0 && v > 0 ? Math.max(2, (v / max) * HEIGHT) : 0;
        return (
          <rect
            key={i}
            x={i * (barWidth + GAP)}
            y={HEIGHT - h}
            width={barWidth}
            height={h}
            rx={0.5}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}
