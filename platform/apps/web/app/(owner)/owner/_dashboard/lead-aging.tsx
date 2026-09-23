import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { barPercent, countAxis } from "@/lib/dashboard-charts";
import { PANEL_LINK } from "../dashboard-panels";
import type { Overview } from "../types";
import { AXIS_TEXT, ChartTable, Insight, SwatchKey, TD, TD_NUM, TH, TH_NUM, TOOLTIP, edgeAlign } from "./chart-parts";

/**
 * Open leads by age, never-responded emphasised (Build docs/29 §3.7).
 *
 * The triage block the API had been computing on every load and nobody drew
 * (docs/29 G1). Five ordered columns - the aging report's own buckets - each
 * split into the part nobody has EVER answered (ink, on the baseline) and the
 * part somebody has (the de-emphasis grey, on top).
 *
 * The emphasis form, not two hues: the one sub-population that matters is the
 * untouched one, and it is the only one a person can act on this afternoon.
 * Painting both halves would make them equally loud.
 *
 * Not windowed - the whole point of the 30+ column is the leads that fell out
 * of the reporting window months ago and are still waiting.
 */
export function LeadAging({ triage, buckets, scoped }: { triage: NonNullable<Overview["triage"]>; buckets: NonNullable<Overview["agingBuckets"]>; scoped?: boolean }) {
  const cols = buckets.map((b) => {
    const total = Number(triage[b.key] ?? 0);
    const never = Number(triage[`never_${b.key}` as keyof typeof triage] ?? 0);
    return { key: b.key, label: b.label, total, never, responded: Math.max(0, total - never) };
  });
  const axis = countAxis(Math.max(0, ...cols.map((c) => c.total)));
  const oldest = cols[cols.length - 1];
  const H = 128;

  return (
    <Card elevated className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="space-y-0.5">
          <MonoLabel>{scoped ? "Your open leads by age" : "Open leads by age"}</MonoLabel>
          <p className="text-xs text-text-muted">Days since the lead arrived · now</p>
        </div>
        <Link href="/owner/reports/sla" className={PANEL_LINK}>
          Response report →
        </Link>
      </div>

      {triage.open_total === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">No open leads. Nothing is waiting.</p>
      ) : (
        <>
          <Insight>
            {triage.never_responded === 0 ? (
              <>Every open lead has had a response.</>
            ) : (
              <>
                <span className="font-semibold">{triage.never_responded}</span> of {triage.open_total} open{" "}
                {triage.open_total === 1 ? "lead has" : "leads have"} never had a response
                {oldest && oldest.never > 0 ? (
                  <>
                    {" "}- <span className="font-semibold">{oldest.never}</span> of them for over 30 days
                  </>
                ) : null}
                .
              </>
            )}
          </Insight>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <SwatchKey swatch="bg-text" label="Never responded" />
            <SwatchKey swatch="bg-chart-seq-1" label="Responded, still open" />
          </div>

          <div aria-hidden="true" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
            <div className={`relative w-7 ${AXIS_TEXT}`} style={{ height: H }}>
              <span className="absolute right-0 top-0 -translate-y-1/2">{axis.top}</span>
              {axis.mid !== null ? <span className="absolute right-0 top-1/2 -translate-y-1/2">{axis.mid}</span> : null}
              <span className="absolute right-0 bottom-0 translate-y-1/2">0</span>
            </div>
            <div className="relative" style={{ height: H }}>
              <span className="absolute inset-x-0 top-0 border-t border-border" />
              <span className="absolute inset-x-0 top-1/2 border-t border-border" />
              <span className="absolute inset-x-0 bottom-0 border-t border-border-strong" />
              <div className="absolute inset-0 flex gap-3">
                {cols.map((c, i) => (
                  <div key={c.key} className="group relative flex min-w-0 flex-1 items-end justify-center">
                    {c.total > 0 ? (
                      <span
                        className="flex w-full max-w-6 flex-col-reverse transition-opacity duration-150 ease-out group-hover:opacity-80"
                        style={{ height: `${barPercent(c.total, axis.top)}%` }}
                      >
                        {c.never > 0 ? (
                          <span className={`bg-text ${c.responded === 0 ? "rounded-t" : ""}`} style={{ height: `${(c.never / c.total) * 100}%` }} />
                        ) : null}
                        {c.responded > 0 ? (
                          <span
                            className={`rounded-t bg-chart-seq-1 ${c.never > 0 ? "border-b-2 border-surface" : ""}`}
                            style={{ height: `${(c.responded / c.total) * 100}%` }}
                          />
                        ) : null}
                      </span>
                    ) : null}
                    <span className={`${TOOLTIP} bottom-full mb-1 ${edgeAlign(i, cols.length)}`}>
                      <span className="block font-medium text-text">{c.label} old</span>
                      <span className="mt-1 block tabular-nums">
                        <span className="font-semibold text-text">{c.never}</span> never responded
                      </span>
                      <span className="block tabular-nums">
                        <span className="font-semibold text-text">{c.responded}</span> responded, still open
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

          <ChartTable>
            <table className="w-full min-w-[320px] border-collapse">
              <caption className="sr-only">Open leads by age, split by whether anyone has responded</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Age</th>
                  <th scope="col" className={TH_NUM}>Never responded</th>
                  <th scope="col" className={TH_NUM}>Responded</th>
                  <th scope="col" className={TH_NUM}>Open</th>
                </tr>
              </thead>
              <tbody>
                {cols.map((c) => (
                  <tr key={c.key}>
                    <th scope="row" className={`${TD} font-normal`}>{c.label}</th>
                    <td className={TD_NUM}>{c.never}</td>
                    <td className={TD_NUM}>{c.responded}</td>
                    <td className={TD_NUM}>{c.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ChartTable>
        </>
      )}
    </Card>
  );
}
