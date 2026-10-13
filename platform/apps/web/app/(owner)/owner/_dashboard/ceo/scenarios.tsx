import type { Scenario } from "@/lib/ceo-dashboard";
import { ChartTable, Insight, TD, TD_NUM, TH, TH_NUM } from "../chart-parts";
import { Panel, PanelHead } from "./panel";

/**
 * Won revenue over the next 30 days, under three assumptions (Build docs/46).
 *
 * ── A SENSITIVITY READING WEARING A BAR CHART ───────────────────────────────
 *
 * Every row is the same arithmetic with exactly one term moved, so the
 * comparison between the bars is the only honest thing on the panel: it ranks
 * the two levers an owner actually has. Reading any single bar as a
 * prediction is the misuse, and the panel is built to make that hard -
 * the ranges overlap heavily, the confidence note is in the header rather
 * than the footnotes, and no row is labelled "expected".
 *
 * ── THE THIN LINE IS A RANGE, NOT AN INTERVAL ───────────────────────────────
 *
 * A flat ±40%, and the legend calls it "likely range". With two closed deals
 * behind the estimate there is no distribution to draw a confidence interval
 * from, and rendering one would borrow a precision nobody earned. Where the
 * base is thin the header says so in the signal hue, next to the count it
 * rests on - which is the number that should decide how much weight a reader
 * puts on the whole panel.
 */
export function Scenarios({
  rows,
  lowConfidence,
  basis,
  money,
  insight,
}: {
  rows: readonly Scenario[];
  lowConfidence: boolean;
  /** What the estimate rests on - "5 leads, 2 wins". */
  basis: string;
  money: (value: number) => string;
  insight: string;
}) {
  const fillFor = (key: Scenario["key"]) =>
    key === "nothing" ? "bg-danger" : key === "restore" ? "bg-chart-cat-1" : "bg-chart-cat-3";

  return (
    <Panel>
      <PanelHead title="Won revenue · next 30 days" note="3 scenarios">
        {lowConfidence ? (
          <p className="text-xs font-medium text-orange-text">Low confidence · based on {basis}</p>
        ) : (
          <p className="text-xs text-text-muted">Based on {basis}</p>
        )}
      </PanelHead>

      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3">
            <div className="w-44 shrink-0">
              <p className="text-sm font-medium text-text">{r.label}</p>
              <p className="text-xs text-text-muted">{r.detail}</p>
            </div>
            <div className="relative h-6 min-w-0 flex-1 rounded-sm bg-bg-subtle">
              {/* The estimate. A zero-value row still shows its range, so a
                  scenario worth nothing is visibly a scenario and not a gap. */}
              {r.at > 0 ? (
                <span
                  className={`absolute inset-y-0 left-0 rounded-sm ${fillFor(r.key)}`}
                  style={{ width: `${r.at * 100}%` }}
                />
              ) : (
                <span className="absolute inset-y-1 left-0 w-0.5 rounded-sm bg-danger" />
              )}
              {/* The range, drawn over the bar - a hairline with end caps. */}
              <span
                aria-hidden="true"
                className="absolute top-1/2 h-px -translate-y-1/2 bg-text"
                style={{ left: `${r.lowAt * 100}%`, width: `${Math.max(0.5, (r.highAt - r.lowAt) * 100)}%` }}
              />
            </div>
            <span className="w-20 shrink-0 text-right text-sm font-semibold text-text tabular-nums">
              {money(r.value)}
            </span>
          </div>
        ))}
      </div>

      <Insight>{insight}</Insight>
      <p className="text-xs text-text-muted">Thin line = likely range (±40%), not a confidence interval.</p>

      <ChartTable>
        <table className="w-full border-collapse">
          <caption className="sr-only">Projected won revenue under three assumptions</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>Scenario</th>
              <th scope="col" className={TH}>Assumption</th>
              <th scope="col" className={TH_NUM}>Estimate</th>
              <th scope="col" className={TH_NUM}>Range</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className={`${TD} font-normal`}>{r.label}</th>
                <td className={TD}>{r.detail}</td>
                <td className={TD_NUM}>{money(r.value)}</td>
                <td className={TD_NUM}>
                  {money(r.low)} – {money(r.high)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartTable>
    </Panel>
  );
}
