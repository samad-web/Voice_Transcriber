import type { FunnelStep } from "@/lib/ceo-dashboard";
import { ChartTable, Insight, TD, TD_NUM, TH, TH_NUM } from "../chart-parts";
import { Panel, PanelHead } from "./panel";

/**
 * Calls → leads → deals won → revenue → collected (Build docs/46).
 *
 * ── THE STEP LABELS ARE THE CHART; THE BARS ARE ORIENTATION ─────────────────
 *
 * The five quantities span four orders of magnitude and three different units
 * - 389 calls, 2 deals, ₹1,500 - so no bar length comparison between them
 * means anything at all. The bars are drawn on a LOG scale (said so in the
 * header) purely so each row has a readable magnitude; the reading the panel
 * is actually for is the rate between consecutive rows, which is printed in
 * words in the gap, with an arrow pointing down the funnel.
 *
 * ── RED ON A STEP IS NOT THE MISSED-CALL RED ────────────────────────────────
 *
 * A bad step is set in `danger-text` on the surface - type, not a fill - and
 * always with words that say what is bad ("1.3% become leads"). The console's
 * rule reserves red FILLS for the missed-call state; a red word in a sentence
 * about conversion cannot be mistaken for a call that nobody answered, and
 * nothing on this panel is a call state.
 *
 * ── "COLLECTED" IS BLANK, NOT ZERO ──────────────────────────────────────────
 *
 * A tenant with no deal template records no collections, so the true value is
 * unknown. Drawing it as 0 would tell an owner they collected nothing of what
 * they earned. The row renders an empty track and an em-dash, and the step
 * above it says "collections not tracked".
 */
export function ConversionFunnel({
  steps,
  insight,
  clock,
  money,
}: {
  steps: readonly FunnelStep[];
  insight: string | null;
  clock: string;
  /** Formats a money row's value in the workspace's own currency. */
  money: (value: number) => string;
}) {
  const fillFor = (key: FunnelStep["key"]) =>
    key === "calls"
      ? "bg-chart-cat-1"
      : key === "leads"
        ? "bg-chart-cat-2"
        : "bg-chart-cat-3";

  return (
    <Panel>
      <PanelHead title="Conversion funnel" clock={clock} note="log scale" />

      <div>
        {steps.map((s, i) => (
          <div key={s.key}>
            {s.drop && i > 0 ? (
              <p
                className={`py-1 pl-[7.5rem] text-xs font-medium ${
                  s.drop.tone === "bad"
                    ? "text-danger-text"
                    : s.drop.tone === "good"
                      ? "text-success-text"
                      : "text-text-muted"
                }`}
              >
                <span aria-hidden="true">↓</span>{" "}
                <span className="sr-only">then</span>
                {s.drop.text}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-sm text-text">{s.label}</span>
              <span className="h-6 min-w-0 flex-1 overflow-hidden rounded-sm bg-bg-subtle">
                {s.value !== null && s.at > 0 ? (
                  <span className={`block h-full rounded-sm ${fillFor(s.key)}`} style={{ width: `${s.at * 100}%` }} />
                ) : null}
              </span>
              <span className="w-20 shrink-0 text-right text-sm font-semibold text-text tabular-nums">
                {s.value === null ? "–" : s.money ? money(s.value) : s.value.toLocaleString()}
              </span>
            </div>
          </div>
        ))}
      </div>

      {insight ? <Insight>{insight}</Insight> : null}

      <ChartTable>
        <table className="w-full border-collapse">
          <caption className="sr-only">The conversion funnel, with the rate between each step</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>Stage</th>
              <th scope="col" className={TH_NUM}>Value</th>
              <th scope="col" className={TH}>Step from above</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={s.key}>
                <th scope="row" className={`${TD} font-normal`}>{s.label}</th>
                <td className={TD_NUM}>
                  {s.value === null ? "not tracked" : s.money ? money(s.value) : s.value.toLocaleString()}
                </td>
                <td className={TD}>{i > 0 ? (s.drop?.text ?? "–") : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartTable>
    </Panel>
  );
}
