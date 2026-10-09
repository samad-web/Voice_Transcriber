import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { formatMoney, formatMoneyCompact, toMinor } from "@aura/shared";
import { Card, MonoLabel, SectionHeading, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Cash forecast" };

interface Scenario {
  key: "low" | "base" | "high";
  trough: number;
  troughOn: string | null;
  points: { date: string; inflow: number; outflow: number; balance: number }[];
}

interface ForecastData {
  from: string;
  horizonDays: number;
  openingBalance: number;
  lowConfidence: boolean;
  inputsHash: string;
  scenarios: Scenario[];
  assumptions: {
    collectionProbabilities: Record<string, number>;
    learnedBuckets: string[];
    priors: Record<string, number>;
    newSalesPerWeek: number;
    recurringOutflows: number;
    minimumCash: number;
  };
  breachesMinimum: boolean;
}

const BUCKET_LABEL: Record<string, string> = {
  current: "Not due yet",
  "0_30": "1–30 days late",
  "31_60": "31–60 days late",
  "61_90": "61–90 days late",
  "90_plus": "Over 90 days late",
};

/**
 * §12.2's cash-flow forecast: 30/60/90 days, three scenarios, and the table of
 * assumptions it was built from.
 *
 * ── THE CONFIDENCE LABEL IS THE MOST IMPORTANT THING ON THE PAGE ───────────
 *
 * §12.2 requires the forecast to be labelled "low confidence" when the
 * organization's own collection history is thin, and that label is rendered
 * first — above the numbers, not under them. A forecast an owner acts on is
 * worse than no forecast when its confidence is fictional, and a badge in a
 * corner is a badge nobody reads before spending.
 *
 * ── THE CHART IS A BAND, NOT A LINE ────────────────────────────────────────
 *
 * §12.2 asks for "a line chart with a shaded low-high band". This draws it as
 * an inline SVG rather than reaching for a charting library: three series over
 * ninety points is a path and a polygon, and the console has no chart
 * dependency to spend on it. The low and high scenarios are the band; the base
 * case is the line.
 *
 * ── AND IT SHOWS ITS WORKING ───────────────────────────────────────────────
 *
 * The assumptions table is the whole of §12's "reproducible from data": the
 * collection probability per aging bucket, which of them were learned from
 * this workspace rather than taken from a prior, the sales run rate, and the
 * `inputsHash` that identifies the run. Two forecasts with the same hash used
 * the same inputs.
 */
export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/finance/forecast");

  const sp = await searchParams;
  const raw = Number(Array.isArray(sp.horizon) ? sp.horizon[0] : sp.horizon);
  const horizon = [30, 60, 90].includes(raw) ? raw : 90;

  const forecast = await ownerTry<ForecastData>(
    `/v1/finance/advisor/forecast?horizonDays=${horizon}`,
  );

  if (!forecast.ok) {
    return (
      <>
        <PageHeader title="Cash forecast" context="Sales" />
        <LoadFailure what="the cash forecast" failure={forecast} />
      </>
    );
  }

  const data = forecast.data;
  const money = (major: number) => formatMoney(toMinor(major, "INR"), { currency: "INR" });
  const base = data.scenarios.find((s) => s.key === "base");
  const low = data.scenarios.find((s) => s.key === "low");
  const high = data.scenarios.find((s) => s.key === "high");

  return (
    <>
      <PageHeader
        title="Cash forecast"
        context="Sales"
        description="What is scheduled to arrive, discounted by how reliably money in each age actually arrives here."
        actions={
          <Link href="/owner/finance" className="text-xs text-text-muted underline hover:text-text">
            Finance overview
          </Link>
        }
      />

      {/* First, above everything. See the header. */}
      {data.lowConfidence ? (
        <Card className="flex items-start gap-3 border-border p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="space-y-1 text-sm">
            <p className="text-text">Low confidence.</p>
            <p className="text-xs text-text-muted">
              This workspace does not yet have enough collection history for every age band, so
              some of the figures below come from deliberately cautious defaults rather than from
              what actually happens here. The bands that ARE learned are named in the assumptions.
            </p>
          </div>
        </Card>
      ) : null}

      <nav aria-label="Horizon" className="flex flex-wrap gap-2 text-xs">
        {[30, 60, 90].map((days) => (
          <Link
            key={days}
            href={`/owner/finance/forecast?horizon=${days}`}
            aria-current={horizon === days ? "page" : undefined}
            className={`rounded-md border px-2.5 py-1.5 ${
              horizon === days
                ? "border-accent text-text"
                : "border-border text-text-muted hover:text-text"
            }`}
          >
            {days} days
          </Link>
        ))}
      </nav>

      <div className="grid gap-3 sm:grid-cols-3">
        {data.scenarios.map((s) => (
          <Card key={s.key} className="space-y-1 p-4">
            <MonoLabel>{s.key === "base" ? "Base case" : s.key === "low" ? "Low" : "High"}</MonoLabel>
            <p className="font-mono text-2xl tabular-nums">{money(s.trough)}</p>
            {/* ── SAY WHEN, OR SAY IT NEVER DIPS ───────────────────────────
                `troughOn` is null when the balance never falls below where it
                started, and then all three scenarios report the same number -
                the opening balance. Three identical cards labelled "lowest
                point" read as a broken page; they are in fact the correct
                answer to a question nobody asked. Saying so is the fix. */}
            <p className="text-xs text-text-muted">
              {s.troughOn
                ? `lowest point · ${s.troughOn}`
                : "never dips below today's balance"}
            </p>
          </Card>
        ))}
      </div>

      {base && low && high ? (
        <section className="space-y-3">
          <SectionHeading
            title="Projected balance"
            description={`From ${money(data.openingBalance)} on ${data.from}. The shaded band is the low-to-high range.`}
          />
          <Card className="p-4">
            <ForecastBand base={base} low={low} high={high} minimum={data.assumptions.minimumCash} />
          </Card>
        </section>
      ) : null}

      {data.breachesMinimum ? (
        <Card className="flex items-start gap-3 p-4">
          <StatusChip tone="danger">below your floor</StatusChip>
          <p className="text-sm text-text-muted">
            The base case drops below the {money(data.assumptions.minimumCash)} minimum you set.
            The Advisor raises this as an alert too — it does not act on it.
          </p>
        </Card>
      ) : null}

      <section className="space-y-3">
        <SectionHeading
          title="What this assumes"
          description="Every figure the forecast was built from. Change any of them and the run hash changes."
        />
        <Card className="space-y-3 p-4 text-sm">
          <div>
            <p className="text-text-muted">
              How much of what is owed actually arrives, by how late it already is:
            </p>
            <ul className="mt-1.5 space-y-1">
              {Object.entries(data.assumptions.collectionProbabilities).map(([bucket, p]) => (
                <li key={bucket} className="flex items-baseline gap-3">
                  <span className="w-40 shrink-0 text-text-muted">
                    {BUCKET_LABEL[bucket] ?? bucket}
                  </span>
                  <span className="font-mono text-xs tabular-nums">{Math.round(p * 100)}%</span>
                  <span className="text-xs text-text-muted">
                    {data.assumptions.learnedBuckets.includes(bucket)
                      ? "from this workspace's own history"
                      : `cautious default (${Math.round((data.assumptions.priors[bucket] ?? 0) * 100)}%)`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-text-muted">
            New sales run rate:{" "}
            <span className="font-mono tabular-nums text-text">
              {money(data.assumptions.newSalesPerWeek)}
            </span>{" "}
            a week, weighted toward recent weeks.
          </p>
          <p className="text-text-muted">
            {data.assumptions.recurringOutflows} scheduled outgoing payment
            {data.assumptions.recurringOutflows === 1 ? "" : "s"} over the horizon, from recurring
            fixed costs.
          </p>
          <p className="text-xs text-text-muted">
            Run {data.inputsHash}. The low case scales expected arrivals down and leaves costs
            alone — rent is paid whatever happens, and a &ldquo;low&rdquo; case that assumed cheap
            costs would never warn anybody.
          </p>
        </Card>
      </section>
    </>
  );
}

/**
 * The band, as inline SVG.
 *
 * `preserveAspectRatio="none"` with a viewBox in arbitrary units, so it scales
 * to any width without the geometry needing to know the rendered size — which
 * a server component cannot know. The path is built from the scenarios'
 * balances only; nothing here re-derives a number.
 */
function ForecastBand({
  base,
  low,
  high,
  minimum,
}: {
  base: Scenario;
  low: Scenario;
  high: Scenario;
  minimum: number;
}) {
  const n = base.points.length;
  if (n < 2) return <p className="text-xs text-text-muted">Not enough horizon to draw.</p>;

  const all = [
    ...low.points.map((p) => p.balance),
    ...high.points.map((p) => p.balance),
    minimum,
    0,
  ];
  const max = Math.max(...all);
  const min = Math.min(...all);
  const span = max - min || 1;
  const x = (i: number) => (i / (n - 1)) * 1000;
  const y = (v: number) => 200 - ((v - min) / span) * 200;

  const bandPath = [
    `M ${x(0)} ${y(high.points[0].balance)}`,
    ...high.points.map((p, i) => `L ${x(i)} ${y(p.balance)}`),
    ...[...low.points].reverse().map((p, i) => `L ${x(n - 1 - i)} ${y(p.balance)}`),
    "Z",
  ].join(" ");
  const line = base.points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(p.balance)}`).join(" ");

  return (
    <figure className="space-y-2">
      <svg
        viewBox="0 0 1000 200"
        preserveAspectRatio="none"
        className="h-48 w-full"
        role="img"
        aria-label={`Projected balance over ${n} days. Base case lowest point ${base.trough}.`}
      >
        {/* The zero line, and the owner's floor. Both dashed so neither reads
            as data. */}
        <line x1="0" y1={y(0)} x2="1000" y2={y(0)} className="stroke-border" strokeDasharray="4 4" />
        {minimum !== 0 ? (
          <line
            x1="0"
            y1={y(minimum)}
            x2="1000"
            y2={y(minimum)}
            className="stroke-text-muted"
            strokeDasharray="2 6"
          />
        ) : null}
        <path d={bandPath} className="fill-accent/15" />
        <path d={line} className="stroke-accent" strokeWidth="2" fill="none" />
      </svg>
      <figcaption className="flex justify-between text-xs text-text-muted">
        <span>{base.points[0].date}</span>
        <span>
          {formatMoneyCompact(toMinor(min, "INR"), "INR")} –{" "}
          {formatMoneyCompact(toMinor(max, "INR"), "INR")}
        </span>
        <span>{base.points[n - 1].date}</span>
      </figcaption>
    </figure>
  );
}
