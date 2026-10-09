import Link from "next/link";
import {
  AlertTriangle,
  Banknote,
  Coins,
  Gauge,
  HandCoins,
  Hourglass,
  Receipt,
  TrendingDown,
} from "lucide-react";
import {
  Card,
  MonoLabel,
  SectionHeading,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  type AgingBucket,
  type Comparison,
  type MetricKey,
  formatMoney,
  formatMoneyCompact,
  toMinor,
} from "@aura/shared";

/**
 * §11's finance dashboard, rendered.
 *
 * ── A SERVER COMPONENT, NO CLIENT STATE ────────────────────────────────────
 *
 * Every control on this page is a LINK - the range bar navigates, a tile
 * drills down, the aging rows filter the dues list. Nothing here needs
 * `"use client"`, and keeping it out means the numbers are rendered once on
 * the server and cannot be re-derived differently in the browser. That matters
 * more than usual here: a figure computed twice by two runtimes is exactly
 * what §11's one-metrics-layer rule exists to prevent, and the easiest way to
 * reintroduce it is a `useMemo` that re-does a sum.
 *
 * ── MONEY IS FORMATTED BY ONE FUNCTION ─────────────────────────────────────
 *
 * `formatMoney` from `@aura/shared`, which groups the Indian way and is
 * deliberately NOT `Intl.NumberFormat`: its ICU data differs between a Node
 * build and a browser, so a number reading 1,234,567 on the server and
 * 12,34,567 after hydration is a React hydration mismatch. This console
 * already has one live instance of that class of bug and does not need a
 * second.
 *
 * The API sends MAJOR units (every other controller does), so each value is
 * converted to minor once, here, at the boundary.
 */

export interface FinanceOverviewData {
  period: { from: string; to: string; days: number };
  currency: string;
  metrics: {
    booked: number;
    collected: number;
    billed: number;
    refunded: number;
    fees: number;
    costs: number;
    outstanding: number;
    collectionRate: number | null;
    netMargin: number | null;
    gatewayFeeRate: number | null;
    refundRate: number | null;
    cac: number | null;
    dso: number | null;
    daysToCollect: { median: number | null; p90: number | null };
    dealsClosed: number;
    newCustomers: number;
    cash: number;
    monthlyBurn: number;
    runwayMonths: number | null;
  };
  aging: Record<string, number>;
  comparison: {
    period: { from: string; to: string };
    booked: Comparison;
    collected: Comparison;
    outstanding: Comparison;
    collectionRate: Comparison;
    netMargin: Comparison;
  };
  health: {
    score: number | null;
    weights: Record<string, number>;
    components: {
      key: string;
      label: string;
      value: number | null;
      normalised: number | null;
      weight: number;
    }[];
    unmeasuredWeight: number;
  };
  drillDowns: Record<string, string>;
  definitions: Record<string, string>;
  freshness: { label: string; live: boolean; computedAt: string | null };
  settings: { autoMatchConfidence: number; minimumCash: number; configured: boolean };
}

/** The console's own empty marker, used wherever a rate has no denominator. */
const DASH = "—";

function rupees(major: number, currency: string): string {
  return formatMoney(toMinor(major, currency), { currency });
}

/**
 * The same amount for a KPI TILE: no paise.
 *
 * ── WHY THE HEADLINE DROPS THE PAISE AND THE TABLES DO NOT ────────────────
 *
 * Found by looking at the rendered page rather than the markup.
 * "₹1,96,250.00" at `text-3xl` does not fit a quarter-width tile, and
 * `StatCard` deliberately does not shrink numbers - "shrinking the headline
 * number because the business grew would be a strange thing for a dashboard
 * to do". So the value wrapped mid-number, rendering as "₹1,96,250.0" over
 * "0", which is worse than either shortening it or widening the grid.
 *
 * Paise on a headline tile are noise: nobody reads a dashboard to two decimal
 * places. Every figure that has to RECONCILE - the aging table, the dues list,
 * the ledger, the drill-downs - keeps them, which is the line §11 actually
 * draws: the tile is the summary, the records are the truth.
 */
function bigRupees(major: number, currency: string): string {
  return formatMoney(toMinor(major, currency), { currency, whole: true });
}

function percent(value: number | null): string {
  return value === null ? DASH : `${Math.round(value * 1000) / 10}%`;
}

/**
 * §11's period-over-period comparison, as glyph and WORDS - never colour.
 *
 * Green and red already mean answered and missed everywhere in this console
 * (the colour rule), so a coloured arrow here would lie about state. The
 * direction's MEANING comes from the API's `better` flag, which is derived
 * from the metric's own direction: a 20% rise in collections and a 20% rise in
 * dues are the same number and opposite news, and a console that rendered
 * both the same way trains people to ignore it.
 */
function trendOf(comparison: Comparison): { kind: "up" | "down" | "flat"; text: string } | undefined {
  if (comparison.changePercent === null) return undefined;
  if (comparison.changePercent === 0) return { kind: "flat", text: "No change" };
  const up = comparison.changePercent > 0;
  const magnitude = `${Math.abs(comparison.changePercent)}%`;
  const verdict =
    comparison.better === null ? "" : comparison.better ? " · better" : " · worse";
  return { kind: up ? "up" : "down", text: `${up ? "▲" : "▼"} ${magnitude}${verdict}` };
}

/** Every tile is a link. §11's MUST, applied by construction. */
function Drill({
  data,
  metric,
  children,
}: {
  data: FinanceOverviewData;
  metric: MetricKey;
  children: React.ReactNode;
}) {
  const href = data.drillDowns[metric];
  if (!href) return <>{children}</>;
  const withPeriod = `${href}${href.includes("?") ? "&" : "?"}from=${data.period.from}&to=${data.period.to}`;
  return (
    <Link
      href={withPeriod}
      className="block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      title={data.definitions[metric]}
    >
      {children}
    </Link>
  );
}

export function FinanceOverview({ data }: { data: FinanceOverviewData }) {
  const m = data.metrics;
  const currency = data.currency;

  return (
    <div className="space-y-6">
      {/* §11's freshness stamp. Under the range bar, where a reader looking at
          a number can see how old it is without hunting for it. */}
      <p className="text-xs text-text-muted" data-testid="finance-freshness">
        {data.freshness.label}
        {data.freshness.live ? " · today is live" : null}
      </p>

      {/* ── THE HEADLINE BAND ─────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Drill data={data} metric="collected">
          <StatCard
            label="Collected"
            value={bigRupees(m.collected, currency)}
            context={`of ${rupees(m.billed, currency)} billed`}
            icon={<Banknote className="size-4" aria-hidden="true" />}
            trend={trendOf(data.comparison.collected)}
            footer={<span className="text-xs">Collection rate {percent(m.collectionRate)}</span>}
          />
        </Drill>
        <Drill data={data} metric="booked">
          <StatCard
            label="Booked"
            value={bigRupees(m.booked, currency)}
            context={`${m.dealsClosed} deal${m.dealsClosed === 1 ? "" : "s"} closed`}
            icon={<HandCoins className="size-4" aria-hidden="true" />}
            trend={trendOf(data.comparison.booked)}
          />
        </Drill>
        <Drill data={data} metric="outstanding">
          <StatCard
            label="Outstanding"
            value={bigRupees(m.outstanding, currency)}
            context={
              m.dso === null ? "No billing in this period" : `${Math.round(m.dso)} days sales outstanding`
            }
            icon={<Hourglass className="size-4" aria-hidden="true" />}
            trend={trendOf(data.comparison.outstanding)}
          />
        </Drill>
        <Drill data={data} metric="net_margin">
          <StatCard
            label="Net margin"
            value={percent(m.netMargin)}
            context={`${rupees(m.costs, currency)} of costs`}
            icon={<Gauge className="size-4" aria-hidden="true" />}
            trend={trendOf(data.comparison.netMargin)}
            // A NEGATIVE margin is a real answer and the tile says so in
            // words rather than relying on a minus sign in a right-aligned
            // column, which is the easiest character on a screen to miss.
            footer={
              m.netMargin !== null && m.netMargin < 0 ? (
                <span className="text-xs">Costs exceeded collections</span>
              ) : undefined
            }
          />
        </Drill>
      </div>

      {/* ── CASH, FEES AND WHAT THEY COST ─────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Drill data={data} metric="runway">
          <StatCard
            label="Runway"
            tone="plain"
            value={
              m.runwayMonths === null
                ? "Cash positive"
                : `${Math.round(m.runwayMonths * 10) / 10} mo`
            }
            // Null runway means the business is making money - the tile says
            // that rather than printing a negative number of months.
            context={
              m.runwayMonths === null
                ? `${rupees(m.cash, currency)} on hand`
                : `${rupees(m.cash, currency)} ÷ ${rupees(m.monthlyBurn, currency)} a month`
            }
            icon={<Coins className="size-4" aria-hidden="true" />}
          />
        </Drill>
        <Drill data={data} metric="cac">
          <StatCard
            label="Cost to win a customer"
            tone="plain"
            value={m.cac === null ? DASH : bigRupees(m.cac, currency)}
            context={
              m.newCustomers === 0
                ? "No first payments in this period"
                : `${m.newCustomers} new customer${m.newCustomers === 1 ? "" : "s"}`
            }
            icon={<Receipt className="size-4" aria-hidden="true" />}
          />
        </Drill>
        <Drill data={data} metric="gateway_fee_rate">
          <StatCard
            label="Gateway fees"
            tone="plain"
            value={percent(m.gatewayFeeRate)}
            context={rupees(m.fees, currency)}
            icon={<TrendingDown className="size-4" aria-hidden="true" />}
          />
        </Drill>
        <Drill data={data} metric="days_to_collect">
          <StatCard
            label="Days to collect"
            tone="plain"
            value={m.daysToCollect.median === null ? DASH : `${Math.round(m.daysToCollect.median)}d`}
            // §11 asks for the median AND the p90, "not just the mean" -
            // collection times are heavily right-skewed, so the p90 is the
            // number a collections team plans around.
            context={
              m.daysToCollect.p90 === null
                ? "No payments against a due date yet"
                : `median · 9 in 10 within ${Math.round(m.daysToCollect.p90)}d`
            }
            icon={<Hourglass className="size-4" aria-hidden="true" />}
          />
        </Drill>
      </div>

      {/* ── §11's AGING ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeading title="What is owed, by how late it is" />
        <Card className="overflow-hidden p-0">
          {/* The caption is required by the kit and hidden by default: a
              table whose only heading is a <SectionHeading> beside it is
              unnavigable to a screen reader, which is why the prop is not
              optional. */}
          <Table caption="Outstanding money by how overdue it is">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Age</TableHeaderCell>
                <TableHeaderCell className="text-right">Outstanding</TableHeaderCell>
                <TableHeaderCell className="text-right">Share</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {AGING_BUCKETS.map((bucket: AgingBucket) => {
                const amount = data.aging[bucket] ?? 0;
                const total = AGING_BUCKETS.reduce((s, b) => s + (data.aging[b] ?? 0), 0);
                return (
                  <TableRow key={bucket}>
                    <TableCell>
                      <Link
                        href={`/owner/finance/dues?bucket=${bucket}`}
                        className="underline decoration-dotted hover:text-text"
                      >
                        {AGING_BUCKET_LABELS[bucket]}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {amount === 0 ? DASH : rupees(amount, currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-text-muted">
                      {total === 0 ? DASH : `${Math.round((amount / total) * 100)}%`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* ── §12.6's HEALTH SCORE, WITH ITS PARTS SHOWN ────────────────────── */}
      <section className="space-y-3">
        <SectionHeading
          title="Finance health"
          // §12.6 requires that "weights and each component are visible on
          // screen". A single number nobody can take apart is a number nobody
          // can act on: an owner seeing 62 needs to know whether it is the DSO
          // or the leakage.
          description="Weighted from collection rate, margin, runway, money at risk and days to collect."
        />
        <Card className="space-y-4">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-4xl tabular-nums">
              {data.health.score === null ? DASH : data.health.score}
            </span>
            <MonoLabel>out of 100</MonoLabel>
            {data.health.unmeasuredWeight > 0.01 ? (
              <span className="text-xs text-text-muted">
                {Math.round(data.health.unmeasuredWeight * 100)}% of the score could not be measured
                yet and is left out rather than counted as zero
              </span>
            ) : null}
          </div>
          <ul className="space-y-2">
            {data.health.components.map((component) => (
              <li key={component.key} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 text-text-muted">{component.label}</span>
                <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-text-muted">
                  {Math.round(component.weight * 100)}%
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-subtle">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{
                      width:
                        component.normalised === null
                          ? "0%"
                          : `${Math.round(component.normalised * 100)}%`,
                    }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
                  {component.normalised === null
                    ? "not measured"
                    : `${Math.round(component.normalised * 100)}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {/* ── WHERE TO GO NEXT ─────────────────────────────────────────────── */}
      <nav aria-label="Finance sections" className="flex flex-wrap gap-2 text-xs">
        {/* ── ONLY PAGES THAT EXIST ────────────────────────────────────────
            This strip is how the four finance pages without a rail entry are
            reached, so a link here to a route that does not exist is a 404 a
            person finds rather than a test does - and nothing in typecheck or
            lint catches a `Link` to a missing route (doc 37 recorded the same
            trap for `/owner/deals/[id]`).

            The matching queue, the incentive payouts, the connector health
            page and the ledger are API surfaces with no console page yet.
            They are deliberately absent rather than linked-and-broken; the
            routes are documented in the module's README. */}
        {[
          ["/owner/finance/dues", "Dues to chase"],
          ["/owner/finance/payments", "All payments"],
          ["/owner/finance/expenses", "Expenses"],
          ["/owner/finance/forecast", "Cash forecast"],
          ["/owner/finance/advisor", "Money leaks"],
        ].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="rounded-md border border-border px-2.5 py-1.5 text-text-muted hover:border-accent hover:text-text"
          >
            {label}
          </Link>
        ))}
      </nav>

      {/* The compact figure is used nowhere above, deliberately: a dashboard
          an owner makes decisions from shows exact rupees. `formatMoneyCompact`
          is for a chart axis, and the one place it belongs on this page is the
          period's own summary line. */}
      <p className="text-xs text-text-muted">
        {data.period.days} day{data.period.days === 1 ? "" : "s"} ·{" "}
        {formatMoneyCompact(toMinor(m.collected, currency), currency)} collected ·{" "}
        {formatMoneyCompact(toMinor(m.costs, currency), currency)} spent
        {data.settings.configured ? null : (
          <>
            {" · "}
            <Link href="/owner/settings/finance" className="underline">
              set your approval limit and minimum cash
            </Link>
          </>
        )}
      </p>

      {data.metrics.refundRate !== null && data.metrics.refundRate > 0.05 ? (
        <p className="flex items-center gap-2 text-xs text-text-muted">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          {percent(data.metrics.refundRate)} of what was captured has been refunded or disputed.
        </p>
      ) : null}
    </div>
  );
}
