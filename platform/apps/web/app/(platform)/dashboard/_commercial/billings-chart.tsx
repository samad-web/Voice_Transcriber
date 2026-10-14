import { Card, MonoLabel } from "@aura/ui";
import { TOOLTIP, edgeAlign } from "@/app/(owner)/owner/_dashboard/chart-parts";
import { moneyShort, money } from "./money";
import type { Commercial } from "./types";

/**
 * BILLINGS BY MONTH, STACKED BY PLAN (doc 49 P13c, Row 2 chart 1).
 *
 * ── IT IS NOT CALLED MRR, AND THAT IS THE WHOLE POINT ───────────────────────
 *
 * Doc 49 asks for "MRR by month, stacked by plan". That chart cannot be drawn
 * from this database: `org_subscriptions` holds one row per org with the
 * CURRENT plan and no history, and nothing records what a tenant's price was in
 * a past month. A 12-month MRR series would have to be invented from today's
 * prices applied backwards - which would redraw history every time somebody
 * upgraded, and would show a tenant who joined last week as having paid us for
 * a year.
 *
 * What `billing_orders` genuinely holds is cash we invoiced and were paid, with
 * the plan it was for. That answers most of what the chart was wanted for -
 * doc 49's own phrasing, "is Growth growing, or is Starter churning into it" -
 * and the panel says in its own subtitle that an annual payment lands as one
 * tall month. An honest billings chart beats a fabricated MRR one.
 *
 * ── STACKED, WITH THE 2px SURFACE GAP ───────────────────────────────────────
 *
 * Segments are separated by a 2px gap in the surface colour, not by a border:
 * a border grows the bar, and at a 6px-tall segment a 1px border on each side
 * is a third of the mark. The gap is why two adjacent plans never read as one
 * block even when their hues are close.
 *
 * ── ONE CURRENCY PER CHART ──────────────────────────────────────────────────
 *
 * The API groups by currency and never sums across. This panel draws the
 * currency with the most revenue and names the others underneath rather than
 * stacking them together, because a bar whose height is INR + AED is not a
 * height of anything.
 */

/** Fixed hue order, assigned by PLAN and never cycled. */
const PLAN_FILL: Record<string, string> = {
  capture_enterprise: "bg-chart-cat-1",
  capture_growth: "bg-chart-cat-2",
  capture_starter: "bg-chart-cat-3",
  record: "bg-chart-cat-4",
};
const OTHER_FILL = "bg-chart-cat-5";

/**
 * A plan's colour.
 *
 * Keyed on the plan, not on its rank in the month - a filter or a quiet month
 * that changes which plans appear must not repaint the survivors, or a reader
 * comparing two months is comparing two different legends. Anything outside
 * the four capture tiers (an insights plan, an unknown) takes slot 5 and is
 * named in the legend as itself.
 */
function fillFor(planKey: string): string {
  return PLAN_FILL[planKey] ?? OTHER_FILL;
}

function planLabel(planKey: string): string {
  if (planKey === "(unknown)") return "No plan recorded";
  return planKey
    .replace(/^capture_/, "")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function BillingsChart({ data }: { data: Commercial["billingsByMonth"] }) {
  const months = data.months;

  // The currency with the most revenue across the window. Everything drawn is
  // that one.
  const byCurrency = new Map<string, number>();
  for (const m of months) {
    for (const t of m.totalsByCurrency) {
      byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) + t.minor);
    }
  }
  const currencies = [...byCurrency.entries()].sort((a, b) => b[1] - a[1]);
  const primary = currencies[0]?.[0] ?? "INR";
  const others = currencies.slice(1);

  const series = months.map((m) => ({
    month: m.month,
    segments: m.byPlan.filter((p) => p.currency === primary),
    total: m.byPlan.filter((p) => p.currency === primary).reduce((a, p) => a + p.minor, 0),
  }));
  const peak = Math.max(0, ...series.map((s) => s.total));

  // Every plan that appears anywhere in the window, in catalogue order, so the
  // legend is stable across months.
  const plans = [
    ...new Set(series.flatMap((s) => s.segments.map((g) => g.planKey))),
  ].sort((a, b) => {
    const order = ["capture_enterprise", "capture_growth", "capture_starter", "record"];
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <Card className="space-y-4">
      <div>
        <MonoLabel>Billings by month</MonoLabel>
        <p className="mt-1 text-xs text-text-muted">
          Cash invoiced and paid, by the plan it was for. <strong className="text-text">Not
          MRR</strong> &mdash; nothing records a subscription&rsquo;s price over time, so an annual
          payment lands as one tall month rather than spread across twelve.
        </p>
      </div>

      {peak === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">
          No payments recorded in the last twelve months.
        </p>
      ) : (
        <>
          {/* The legend is always present for two or more series, and each
              segment is also direct-labelled in its tooltip - identity is
              never carried by colour alone. */}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {plans.map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-[2px] ${fillFor(p)}`} />
                {planLabel(p)}
              </span>
            ))}
          </div>

          <div className="flex items-end gap-1.5" style={{ height: "10rem" }}>
            {series.map((s, i) => (
              <div key={s.month} className="group relative flex h-full flex-1 flex-col justify-end">
                <div
                  className="flex w-full flex-col justify-end"
                  style={{ height: `${peak > 0 ? (s.total / peak) * 100 : 0}%` }}
                >
                  {s.segments.map((g) => (
                    <div
                      key={g.planKey}
                      // The 2px surface gap, as a bottom margin on every
                      // segment but the lowest: a border would grow the mark.
                      className={`${fillFor(g.planKey)} w-full first:rounded-t-[4px] [&:not(:last-child)]:mb-[2px]`}
                      style={{ height: `${s.total > 0 ? (g.minor / s.total) * 100 : 0}%` }}
                    />
                  ))}
                </div>
                <span className={`${TOOLTIP} ${edgeAlign(i, series.length)} bottom-full mb-2`}>
                  <strong className="block text-sm text-text">
                    {money(s.total, primary)}
                  </strong>
                  {s.month}
                  {s.segments.map((g) => (
                    <span key={g.planKey} className="mt-1 block">
                      {planLabel(g.planKey)}: {money(g.minor, primary)}
                      {g.orders > 1 ? ` (${g.orders} orders)` : ""}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <div className="flex gap-1.5">
            {series.map((s) => (
              <span
                key={s.month}
                className="flex-1 text-center text-[10px] text-text-subtle tabular-nums"
              >
                {/* Just the month number: twelve "2026-10" labels at this width
                    collide, and the year is in the panel's own window. */}
                {s.month.slice(5)}
              </span>
            ))}
          </div>

          <p className="text-[11px] text-text-subtle">
            Peak month {moneyShort(peak, primary)} &middot; {primary}
            {others.length > 0 ? (
              <>
                {" "}
                &middot; not drawn:{" "}
                {others.map(([c, minor]) => `${moneyShort(minor, c)} in ${c}`).join(", ")}, because
                two currencies added together is not a height
              </>
            ) : null}
          </p>

          {/* The table twin. Every chart has one: it is how a keyboard reader,
              a screen-reader user and a touch reader (who gets no tooltip at
              all) reach the same numbers. */}
          <details className="text-xs">
            <summary className="cursor-pointer text-text-muted hover:text-text">
              Show as table
            </summary>
            <table className="mt-2 w-full text-left">
              <caption className="sr-only">
                Billings by month and plan, in {primary}
              </caption>
              <thead>
                <tr className="border-b border-border text-[10px] font-mono uppercase text-text-muted">
                  <th className="py-1">Month</th>
                  {plans.map((p) => (
                    <th key={p} className="py-1 text-right">
                      {planLabel(p)}
                    </th>
                  ))}
                  <th className="py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {series.map((s) => (
                  <tr key={s.month} className="border-b border-border-subtle">
                    <td className="py-1">{s.month}</td>
                    {plans.map((p) => (
                      <td key={p} className="py-1 text-right">
                        {(() => {
                          const seg = s.segments.find((g) => g.planKey === p);
                          return seg ? money(seg.minor, primary) : "—";
                        })()}
                      </td>
                    ))}
                    <td className="py-1 text-right font-bold">{money(s.total, primary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}

      <p className="border-t border-border-subtle pt-3 text-[11px] text-text-subtle">
        {data.evidence}
      </p>
    </Card>
  );
}
