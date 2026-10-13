import { barPercent, countAxis } from "@/lib/dashboard-charts";
import { AXIS_TEXT, ChartTable, Insight, TD, TD_NUM, TH, TH_NUM, TOOLTIP, edgeAlign } from "../chart-parts";
import type { Overview } from "../../types";
import { Panel, PanelEmpty, PanelHead } from "./panel";

/**
 * Open leads by age (Build docs/46) - the CEO layout's reading of the triage
 * block that `lead-aging.tsx` draws for the other compositions.
 *
 * ── WHY A SECOND COMPONENT AND NOT A PROP ON THE FIRST ──────────────────────
 *
 * They answer different questions and encode differently. `lead-aging.tsx`
 * splits each column by whether anyone has ever responded, because the
 * persona dashboards put it beside response speed and the sub-population is
 * the point. This one does not split at all: it sits beside a funnel and a
 * forecast, where the question is just "how much of the pipeline is going
 * stale", and the stale columns are called out in the danger hue.
 *
 * Trying to serve both from one component meant a `split` flag that changed
 * the legend, the tooltip, the table twin and the insight sentence - four
 * branches through one file to save about forty lines.
 *
 * ── COLOUR HERE IS AGE, AND AGE IS ORDERED ──────────────────────────────────
 *
 * The young buckets are the categorical blue; the buckets past the SLA are
 * danger. That is the one place this page uses danger as a FILL, and it is
 * legitimate: a lead sitting unworked for over a week is the lead-side twin of
 * a call nobody picked up, which is exactly what the console's red means. The
 * axis labels say which bucket is which, so the hue is an accelerator and
 * never the only encoding.
 */

/** Buckets at or past this many days are drawn as stale. */
const STALE_FROM = "d8_15";

export function OpenLeadsAge({
  triage,
  buckets,
  href,
}: {
  triage: NonNullable<Overview["triage"]>;
  buckets: NonNullable<Overview["agingBuckets"]>;
  href?: string;
}) {
  const cols = buckets.map((b) => ({
    key: b.key,
    label: b.label,
    count: Number(triage[b.key] ?? 0),
    stale: b.key === STALE_FROM || b.key === "d16_30" || b.key === "d30_plus",
  }));
  const axis = countAxis(Math.max(0, ...cols.map((c) => c.count)));
  const staleTotal = cols.filter((c) => c.stale).reduce((s, c) => s + c.count, 0);
  const H = 128;

  return (
    <Panel>
      <PanelHead
        title="Open leads by age"
        clock="now"
        link={href ? { label: "All leads", href } : null}
      />

      {triage.open_total === 0 ? (
        <PanelEmpty>No open leads. Nothing is waiting.</PanelEmpty>
      ) : (
        <>
          <div aria-hidden="true" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
            <div className={`relative w-6 ${AXIS_TEXT}`} style={{ height: H }}>
              <span className="absolute right-0 top-0 -translate-y-1/2">{axis.top}</span>
              <span className="absolute right-0 bottom-0 translate-y-1/2">0</span>
            </div>
            <div className="relative" style={{ height: H }}>
              <span className="absolute inset-x-0 bottom-0 border-t border-border-strong" />
              <div className="absolute inset-0 flex gap-3">
                {cols.map((c, i) => (
                  // h-full and an ABSOLUTE bar: in a content-sized column the
                  // bar's `height: n%` resolves against its own content box
                  // rather than the plot, which drew every bucket as a
                  // hairline whatever its count.
                  <div key={c.key} className="group relative h-full min-w-0 flex-1">
                    <span
                      className={`absolute bottom-0 left-1/2 w-full max-w-10 -translate-x-1/2 rounded-t-[2px] ${c.stale ? "bg-danger" : "bg-chart-cat-1"} transition-opacity duration-150 ease-out group-hover:opacity-80`}
                      // A zero bucket keeps a hairline so the axis reads as
                      // five buckets rather than as however many are non-zero.
                      style={{ height: c.count > 0 ? `${barPercent(c.count, axis.top)}%` : "2px" }}
                    />
                    <span
                      className="absolute left-1/2 -translate-x-1/2 text-xs font-medium text-text tabular-nums"
                      style={{ bottom: `calc(${c.count > 0 ? barPercent(c.count, axis.top) : 0}% + 4px)` }}
                    >
                      {c.count}
                    </span>
                    <span className={`${TOOLTIP} bottom-full mb-1 ${edgeAlign(i, cols.length)}`}>
                      <span className="block font-medium text-text">{c.label} old</span>
                      <span className="mt-1 block tabular-nums">
                        <span className="font-semibold text-text">{c.count}</span> open
                        {c.stale ? " · past the week" : ""}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <span />
            <div className={`mt-1.5 flex gap-3 ${AXIS_TEXT}`}>
              {cols.map((c) => (
                <span key={c.key} className="min-w-0 flex-1 truncate text-center">
                  {c.label.replace(" days", "")}
                </span>
              ))}
            </div>
          </div>

          <Insight>
            {staleTotal === 0 ? (
              <>Every open lead arrived in the last week.</>
            ) : (
              <>
                <span className="font-semibold">{staleTotal}</span> of {triage.open_total} open{" "}
                {triage.open_total === 1 ? "lead has" : "leads have"} been waiting over a week.
              </>
            )}
          </Insight>

          <ChartTable>
            <table className="w-full border-collapse">
              <caption className="sr-only">Open leads by how long they have been open</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Age</th>
                  <th scope="col" className={TH_NUM}>Open leads</th>
                </tr>
              </thead>
              <tbody>
                {cols.map((c) => (
                  <tr key={c.key}>
                    <th scope="row" className={`${TD} font-normal`}>{c.label}</th>
                    <td className={TD_NUM}>{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ChartTable>
        </>
      )}
    </Panel>
  );
}
