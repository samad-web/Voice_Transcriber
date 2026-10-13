import type { EffortPlot } from "@/lib/ceo-dashboard";
import { AXIS_TEXT, ChartTable, Insight, TD, TD_NUM, TH, TH_NUM } from "../chart-parts";
import type { ActorPalette } from "./actor-colors";
import { Panel, PanelEmpty, PanelHead } from "./panel";

/**
 * Effort against yield: how much each person dials, against what each dial is
 * worth (Build docs/46).
 *
 * ── A SCATTER, BECAUSE THE FINDING IS THE COMBINATION ───────────────────────
 *
 * Both measures are already in the band above as bars, and the bars are better
 * at reading either one. What they cannot show is the pairing, which is the
 * actual management finding on most floors: the person who dials most converts
 * least, and the person who converts best barely dials. Two bar charts make
 * the reader hold four numbers in their head and do the cross-reference; one
 * scatter with named quadrants makes it the first thing they see.
 *
 * ── THE LABELS ARE SELECTIVE ────────────────────────────────────────────────
 *
 * The design this comes from labels every dot, and on its own sample data the
 * labels overlap into an unreadable stack at the right-hand edge. Only the
 * points that carry the finding are labelled here - the busiest caller and the
 * best converter, which are the two the quadrant names are about - and labels
 * flip to the other side of their dot when they would run off the plot. Every
 * dot has a hover tooltip and every row is in the table twin, so nothing is
 * only available by hovering.
 *
 * ── AND THE REFERENCE LINE IS THE TEAM, NOT A TARGET ────────────────────────
 *
 * The dotted horizontal is the floor's own leads-per-100-calls. A target line
 * would need a target, and nothing in this product sets one; the team's own
 * rate is a benchmark every reader can act on - "who is above the line" - and
 * cannot be wrong.
 */
export function EffortYield({
  plot,
  palette,
  clock,
  insight,
  silent,
}: {
  plot: EffortPlot;
  palette: ActorPalette;
  clock: string;
  insight: string | null;
  /** People with no calls at all. Named in words; they cannot be plotted. */
  silent: readonly { id: string; name: string }[];
}) {
  const H = 200;
  // Keeps a dot (and its label) clear of the quadrant captions in the corners.
  const INSET = 0.1;

  if (plot.points.length === 0) {
    return (
      <Panel>
        <PanelHead title="Effort vs yield" clock={clock} />
        <PanelEmpty>Nobody dialled in this window.</PanelEmpty>
      </Panel>
    );
  }

  // The two dots the quadrant names are about.
  const busiest = plot.points[0]!;
  const best = [...plot.points].sort((a, b) => (b.yield ?? 0) - (a.yield ?? 0))[0]!;
  const labelled = new Set([busiest.id, best.id]);

  return (
    <Panel>
      <PanelHead title="Effort vs yield" clock={clock} />

      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div
          className={`flex w-4 items-center justify-center ${AXIS_TEXT}`}
          style={{ height: H }}
          aria-hidden="true"
        >
          <span className="origin-center -rotate-90 whitespace-nowrap">Leads per 100 calls</span>
        </div>

        <div className="relative rounded-sm bg-bg-subtle" style={{ height: H }} aria-hidden="true">
          {/* The busy/quiet divider and the team's own rate. */}
          <span
            className="absolute inset-y-0 border-l border-dashed border-border-strong"
            style={{ left: `${(INSET + plot.medianAt * (1 - 2 * INSET)) * 100}%` }}
          />
          {plot.teamYield !== null ? (
            <span
              className="absolute inset-x-0 border-t border-dotted border-chart-cat-3"
              style={{ bottom: `${(INSET + plot.teamAt * (1 - 2 * INSET)) * 100}%` }}
            >
              <span className="absolute right-1 -top-4 text-[11px] text-chart-cat-3 tabular-nums">
                team avg {plot.teamYield.toFixed(1)}
              </span>
            </span>
          ) : null}

          <span className="absolute left-2 top-1.5 text-[11px] text-text-subtle">Efficient, low effort</span>
          <span className="absolute right-2 top-1.5 text-[11px] text-text-subtle">Stars</span>
          <span className="absolute right-2 bottom-1.5 text-[11px] text-text-subtle">Busy, low yield</span>

          {plot.points.map((p) => {
            // A label that would run off the right edge flips to the left of
            // its dot; one near the top flips below it.
            const flipX = p.x > 0.72;
            // A label goes on the side of its dot AWAY from the team line, so
            // the two never overprint - which they did for the busiest caller,
            // whose rate is usually just under the floor's own average. Points
            // near the top flip down regardless, to stay inside the plot.
            const belowTeam = p.y < plot.teamAt;
            const flipY = p.y > 0.8 || belowTeam;
            // Dots are inset away from the plot's own edges. A point at a
            // true 0 or 1 sits exactly where a quadrant caption is, and the
            // two then overprint - which is what the source design does at
            // the bottom-right corner.
            const x = INSET + p.x * (1 - 2 * INSET);
            const y = INSET + p.y * (1 - 2 * INSET);
            return (
              <span
                key={p.id}
                className="group absolute h-0 w-0"
                style={{ left: `${x * 100}%`, bottom: `${y * 100}%` }}
              >
                <span
                  className="absolute block h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-surface"
                  style={{ backgroundColor: palette.varOf(p.id) }}
                />
                {labelled.has(p.id) ? (
                  <span
                    className={`absolute whitespace-nowrap text-[11px] font-medium text-text ${
                      flipX ? "right-2.5 translate-x-0" : "left-2.5"
                    } ${flipY ? "top-1.5" : "-top-4"}`}
                  >
                    {p.name} · {p.calls.toLocaleString()} {p.calls === 1 ? "call" : "calls"}
                  </span>
                ) : null}
                <span className="pointer-events-none invisible pointer-coarse:hidden absolute bottom-2 left-1/2 z-20 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-muted shadow-md group-hover:visible">
                  <span className="block font-medium text-text">{p.name}</span>
                  <span className="block tabular-nums">
                    {p.calls.toLocaleString()} calls · {(p.yield ?? 0).toFixed(1)} leads/100
                  </span>
                </span>
              </span>
            );
          })}
        </div>

        <span />
        <div className={`relative mt-1.5 h-4 ${AXIS_TEXT}`} aria-hidden="true">
          {plot.ticks.map((t, i) => (
            <span
              key={t.value}
              className={`absolute top-0 whitespace-nowrap ${i === 0 ? "left-0" : "-translate-x-1/2"}`}
              style={i === 0 ? undefined : { left: `${(INSET + t.at * (1 - 2 * INSET)) * 100}%` }}
            >
              {t.value.toLocaleString()}
              {i === plot.ticks.length - 1 ? " calls (log)" : ""}
            </span>
          ))}
        </div>
      </div>

      {insight ? <Insight>{insight}</Insight> : null}
      {silent.length > 0 ? (
        <p className="text-xs text-text-muted">
          Not plotted — no calls to divide by: {silent.map((s) => s.name).join(", ")}.
        </p>
      ) : null}

      <ChartTable>
        <table className="w-full border-collapse">
          <caption className="sr-only">Calls against leads per 100 calls, by person</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>Who</th>
              <th scope="col" className={TH_NUM}>Calls</th>
              <th scope="col" className={TH_NUM}>Leads / 100 calls</th>
            </tr>
          </thead>
          <tbody>
            {plot.points.map((p) => (
              <tr key={p.id}>
                <th scope="row" className={`${TD} font-normal`}>{p.name}</th>
                <td className={TD_NUM}>{p.calls.toLocaleString()}</td>
                <td className={TD_NUM}>{(p.yield ?? 0).toFixed(1)}</td>
              </tr>
            ))}
            {silent.map((s) => (
              <tr key={s.id}>
                <th scope="row" className={`${TD} font-normal`}>{s.name}</th>
                <td className={TD_NUM}>0</td>
                <td className={TD_NUM}>–</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartTable>
    </Panel>
  );
}
