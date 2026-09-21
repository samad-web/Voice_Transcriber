import { STATE_TONE, StateChip } from "@aura/ui";
import { formatCount, formatShare, ratio } from "@aura/shared";
import { niceCeiling } from "@/lib/report-dashboard";

/**
 * The call insights page's charts. Server-rendered HTML, like the Reports
 * page's own (daily-leads-chart.tsx): no chart library and no client bundle,
 * with hover done in CSS.
 *
 * ── COLOUR ──────────────────────────────────────────────────────────────────
 *
 * The stacked columns ARE the console's call states - outgoing, answered,
 * missed - so they wear those hues, taken from `STATE_TONE` rather than named
 * here (packages/ui/src/state.tsx is the only file allowed to name a state's
 * colour). Everything else on the page - sentiment, results, quality bands - is
 * a category or a magnitude, not a state, so it is one neutral ink. A green
 * "positive" bar would be a fifth meaning for green.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 *
 * Plots are `aria-hidden`; each carries an sr-only table with every value, so
 * no number is reachable only by hovering (and thirty focusable columns would
 * be a keyboard trap). The legend is the kit's StateChip, which carries each
 * state's glyph as well as its hue.
 */

const STACK = ["outgoing", "answered", "missed"] as const;
type StackState = (typeof STACK)[number];

export interface StateColumn {
  key: string;
  /** Under the axis, shown only where `showLabel` says. */
  label: string;
  /** The tooltip's heading: "12 Sep", "1–2 PM". */
  title: string;
  outgoing: number;
  answered: number;
  missed: number;
}

export function StateLegend() {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STACK.map((s) => (
        <StateChip key={s} state={s} />
      ))}
    </div>
  );
}

export function StateColumns({
  columns,
  caption,
  showLabel,
}: {
  columns: StateColumn[];
  caption: string;
  showLabel: (index: number, count: number) => boolean;
}) {
  const n = columns.length;
  const top = niceCeiling(Math.max(0, ...columns.map((c) => c.outgoing + c.answered + c.missed)));

  return (
    <>
      <div aria-hidden="true" className="mt-3 grid grid-cols-[auto_1fr] gap-x-2">
        <div className="flex h-40 flex-col justify-between text-right text-[11px] text-text-subtle tabular-nums">
          <span className="-translate-y-1/2">{formatCount(top)}</span>
          <span className="-translate-y-1/2">{top % 2 === 0 ? formatCount(top / 2) : ""}</span>
          <span className="translate-y-1/2">0</span>
        </div>

        <div className="relative h-40">
          <span className="absolute inset-x-0 top-0 border-t border-border" />
          <span className="absolute inset-x-0 top-1/2 border-t border-border" />
          <span className="absolute inset-x-0 bottom-0 border-t border-border-strong" />

          <div className="absolute inset-0 flex items-end gap-[2px]">
            {columns.map((c, i) => {
              const total = c.outgoing + c.answered + c.missed;
              // Tooltips at the edges open inward so they never leave the card.
              const align =
                i < n / 3 ? "left-0" : i >= (2 * n) / 3 ? "right-0" : "left-1/2 -translate-x-1/2";
              const present = STACK.filter((s) => c[s] > 0);
              return (
                <div
                  key={c.key}
                  className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded-sm transition-colors duration-150 ease-out hover:bg-surface-hover"
                >
                  {total > 0 ? (
                    <div
                      className="flex w-full max-w-6 flex-col-reverse overflow-hidden rounded-t"
                      style={{ height: `${Math.max(1.5, (total / top) * 100)}%` }}
                    >
                      {present.map((s, j) => (
                        <span
                          key={s}
                          // The 2px surface gap between segments (dataviz
                          // mark spec), drawn as a border so it is part of the
                          // segment's own share of the height.
                          className={`block w-full ${STATE_TONE[s].dot} ${j > 0 ? "border-b-2 border-surface" : ""}`}
                          style={{ height: `${(c[s] / total) * 100}%` }}
                        />
                      ))}
                    </div>
                  ) : null}
                  <span
                    className={`pointer-events-none invisible absolute bottom-full z-10 mb-1 w-max rounded-md border border-border bg-surface px-3 py-2 text-left text-xs text-text-muted shadow-md group-hover:visible ${align}`}
                  >
                    <span className="block font-medium text-text">{c.title}</span>
                    {STACK.map((s) => (
                      <TooltipRow key={s} state={s} value={c[s]} />
                    ))}
                    <span className="mt-1 block border-t border-border pt-1 tabular-nums">
                      <span className="font-semibold text-text">{formatCount(total)}</span> in total
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <span />
        <div className="relative mt-1 flex h-4 gap-[2px] text-[11px] text-text-subtle tabular-nums">
          {columns.map((c, i) => (
            <span key={c.key} className="relative min-w-0 flex-1">
              {showLabel(i, n) ? (
                <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{c.label}</span>
              ) : null}
            </span>
          ))}
        </div>
      </div>

      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Outgoing</th>
            <th scope="col">Answered</th>
            <th scope="col">Missed</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.key}>
              <th scope="row">{c.title}</th>
              <td>{c.outgoing}</td>
              <td>{c.answered}</td>
              <td>{c.missed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function TooltipRow({ state, value }: { state: StackState; value: number }) {
  return (
    <span className="mt-1 flex items-center gap-1.5 tabular-nums">
      <span className={`h-2 w-2 rounded-sm ${STATE_TONE[state].dot}`} />
      <span className="font-semibold text-text">{formatCount(value)}</span>
      {STATE_TONE[state].label.toLowerCase()}
    </span>
  );
}

export interface BarRow {
  key: string;
  label: string;
  count: number;
}

/**
 * A ranked list of horizontal bars for categories - one neutral ink, the count
 * and its share at the end. The share's base is stated by the caller in the
 * card's own subtitle ("of analysed calls"), because a percentage with an
 * unstated denominator is the most misread number on any dashboard.
 */
/**
 * Label, track and figures on a fixed grid rather than a flex row: in a flex
 * row the track is the only shrinkable child, so in a half-width card it
 * collapsed to nothing and the figures were pushed out past the card's edge.
 * Full class strings in a lookup, because Tailwind only emits classes it can
 * read as literals.
 */
const BAR_GRID = {
  narrow: "grid-cols-[minmax(0,6rem)_minmax(3rem,1fr)_5.5rem]",
  regular: "grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_5.5rem]",
  wide: "grid-cols-[minmax(0,12rem)_minmax(3rem,1fr)_5.5rem]",
} as const;

export function BarList({
  rows,
  denominator,
  caption,
  labels = "regular",
}: {
  rows: BarRow[];
  denominator: number;
  caption: string;
  labels?: keyof typeof BAR_GRID;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul aria-label={caption} className="mt-3 space-y-2">
      {rows.map((row) => (
        <li key={row.key} className={`grid ${BAR_GRID[labels]} items-center gap-3 text-sm`}>
          <span className="truncate text-text" title={row.label}>
            {row.label}
          </span>
          <span aria-hidden="true" className="relative h-2 rounded-full bg-surface-hover">
            {row.count > 0 ? (
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-text-muted"
                style={{ width: `${Math.max(1.5, (row.count / max) * 100)}%` }}
              />
            ) : null}
          </span>
          <span className="text-right text-xs whitespace-nowrap text-text-muted tabular-nums">
            <span className="font-medium text-text">{formatCount(row.count)}</span>
            <span className="ml-1.5">{formatShare(ratio(row.count, denominator))}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
