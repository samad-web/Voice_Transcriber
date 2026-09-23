import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { formatDuration } from "@/lib/report-dashboard";
import { pointsDelta, rateText, share, slaFit, slaPhrase, type SlaFit } from "@/lib/dashboard-charts";
import { PANEL_LINK } from "../dashboard-panels";
import type { Overview } from "../types";
import { ChartTable, DeltaNote, SwatchKey, TD, TD_NUM, TH, TH_NUM } from "./chart-parts";

const FILL: Record<SlaFit, string> = {
  within: "bg-text",
  partial: "bg-chart-seq-2",
  beyond: "bg-chart-seq-1",
  never: "bg-chart-seq-1",
};

/**
 * Speed to first response, against the org's own SLA (Build docs/29 §3.8).
 *
 * ── A HERO FIGURE, THEN THE BARS THAT EXPLAIN IT ────────────────────────────
 *
 * "What share did we answer inside our own target" is the decision number, so
 * it is the big one - computed EXACTLY on the server from minutes, not from
 * buckets. The bars say where the rest went.
 *
 * ── HORIZONTAL, ORDERED, EMPHASISED ─────────────────────────────────────────
 *
 * The buckets are ordered and their names are words that need room, so they
 * run down the page. Buckets wholly inside the SLA are ink and the rest the
 * de-emphasis grey, with a rule between them: the emphasis form says "this
 * much made it" without a second hue. A bucket the SLA falls INSIDE (45 min
 * sits in 30-60) is drawn a middle grey and captioned, rather than guessed.
 *
 * "No response yet" sits apart after a gap: it is open work, not the slowest
 * bucket (sla.ts responseBucket).
 */
export function ResponseSpeed({
  response,
  days,
  period,
}: {
  response: NonNullable<Overview["response"]>;
  days: number;
  /** The window in words when it is not "last N days" - a custom range's dates. */
  period?: string;
}) {
  const r = response;
  const arrived = period ?? `in the last ${days} days`;
  const rows = r.buckets.map((b) => ({ ...b, fit: slaFit(b, r.sla_minutes) }));
  const answered = rows.filter((b) => !b.never);
  const never = rows.find((b) => b.never);
  const max = Math.max(1, ...rows.map((b) => b.count));
  const pct = share(r.within_sla, r.leads);
  const delta = pointsDelta(pct, share(r.prev_within_sla, r.prev_leads));
  const firstBeyond = answered.findIndex((b) => b.fit !== "within");

  return (
    <Card elevated className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="space-y-0.5">
          <MonoLabel>Speed to first response</MonoLabel>
          <p className="text-xs text-text-muted">Leads that arrived {arrived}</p>
        </div>
        <Link href="/owner/reports/sla" className={PANEL_LINK}>
          Response report →
        </Link>
      </div>

      {r.leads === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">No leads arrived in these {days} days.</p>
      ) : (
        <>
          <div className="space-y-1">
            <p className="text-3xl font-semibold text-text">{rateText(r.within_sla, r.leads)}</p>
            <p className="text-sm text-text-muted">
              answered within your {slaPhrase(r.sla_minutes)} target ·{" "}
              <span className="tabular-nums">
                median {r.median_minutes === null ? "-" : formatDuration(r.median_minutes)}
              </span>
            </p>
            {delta ? (
              <p className="text-xs text-text-muted">
                <DeltaNote delta={delta} days={days} unit=" pts" />
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <SwatchKey swatch={FILL.within} label="Within target" />
            <SwatchKey swatch={FILL.beyond} label="Slower, or not yet" />
          </div>

          <ul aria-hidden="true" className="space-y-1.5">
            {answered.map((b, i) => (
              <li key={b.key}>
                {i === firstBeyond && i > 0 ? (
                  <span className="mb-1.5 flex items-center gap-2 text-[11px] text-text-subtle">
                    <span className="h-px flex-1 bg-border-strong" />
                    {slaPhrase(r.sla_minutes)} target
                    <span className="h-px flex-1 bg-border-strong" />
                  </span>
                ) : null}
                <BucketRow label={b.label} count={b.count} max={max} fill={FILL[b.fit]} note={b.fit === "partial" ? "partly within target" : null} />
              </li>
            ))}
            {never ? (
              <li className="pt-2">
                <BucketRow label={never.label} count={never.count} max={max} fill={FILL.never} note={null} />
              </li>
            ) : null}
          </ul>

          <ChartTable>
            <table className="w-full min-w-[320px] border-collapse">
              <caption className="sr-only">Time to first response for leads that arrived {arrived}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>Response time</th>
                  <th scope="col" className={TH_NUM}>Leads</th>
                  <th scope="col" className={TH}>Against the target</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.key}>
                    <th scope="row" className={`${TD} font-normal`}>{b.label}</th>
                    <td className={TD_NUM}>{b.count}</td>
                    <td className={TD}>{b.fit === "within" ? "Within" : b.fit === "partial" ? "Partly within" : b.fit === "never" ? "Not answered" : "Slower"}</td>
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

function BucketRow({ label, count, max, fill, note }: { label: string; count: number; max: number; fill: string; note: string | null }) {
  return (
    <span className="grid grid-cols-[minmax(5.5rem,7.5rem)_minmax(0,1fr)] items-center gap-3">
      <span className="truncate text-xs text-text-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        {count > 0 ? (
          <span className={`h-3.5 shrink-0 rounded-r ${fill}`} style={{ width: `max(3px, calc((100% - 7.5rem) * ${(count / max).toFixed(4)}))` }} />
        ) : (
          <span className="h-3.5 w-px shrink-0 bg-border-strong" />
        )}
        <span className="text-xs whitespace-nowrap text-text-muted tabular-nums">
          <span className="font-medium text-text">{count}</span>
          {note ? ` · ${note}` : ""}
        </span>
      </span>
    </span>
  );
}
