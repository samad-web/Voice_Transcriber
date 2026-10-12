import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, MonoLabel } from "@aura/ui";
import { formatReportRange, todayIn } from "@aura/shared";
import { DateRangeBar, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { parseDateWindow, rangePresets, resolveDateWindow } from "@/lib/date-range";
import { getOrgTimeZone } from "@/lib/org-time";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import {
  CompositeCard,
  FreshnessBanner,
  FunnelCard,
  KpiCard,
  type SummaryView,
  BandChip,
} from "./kpi-cards";

export const metadata: Metadata = { title: "Performance" };

interface Overview {
  window: { from: string; to: string };
  clampedTo: string | null;
  windowDays: number;
  org: SummaryView;
  configured: boolean;
  top: (SummaryView & {
    name: string;
    /** The name is still the integration's own id - nobody has named them. */
    unnamed?: boolean;
    rank: number | null;
    subject: { id: string | null };
  })[];
  bottom: Overview["top"];
  unranked: number;
  funnel: { dialed: number; connected: number; peopleWorked: number; converted: number };
  dispositions: { disposition: string; count: number }[];
  freshness: Parameters<typeof FreshnessBanner>[0]["freshness"];
  demoMode: boolean;
}

/**
 * Reports → Performance: the API-only tier's home
 * (`Build docs/no-crm-api-dashboard-build-plan.md` §8.2, M5).
 *
 * ── EVERY NUMBER HERE IS REPRODUCIBLE FROM WHAT THE CUSTOMER SENT ───────────
 *
 * That is the tier's first design principle, and it shapes the page: a KPI card
 * states its numerator and denominator, a suppressed one states why, and the
 * freshness stamp at the top says how current the lot is. There is nothing on
 * this page a customer could not recompute from their own data - which is the
 * difference between a dashboard they trust and one they argue with.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *
 * No AI summary, no "insight", no recommendation. §1 excludes all of it from
 * this tier, and the exclusion is not a limitation to work around: a customer
 * who chose a no-AI product should not find a generated sentence on their
 * overview.
 */
export default async function KpiOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/kpi");
  await requireOwnerRoles(["owner", "manager"]);

  const sp = await searchParams;
  const zone = await getOrgTimeZone();
  const today = todayIn(zone);
  const parsed = parseDateWindow(sp);
  const window = resolveDateWindow(parsed.window, today);

  const result = await ownerTry<Overview>(
    `/v1/insights/overview?from=${window.from}&to=${window.to}`,
  );
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Performance" context="Reports" />
        <LoadFailure failure={result} what="this workspace's performance" />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader
        title="Performance"
        context="Reports"
        actions={
          <Link
            href="/owner/settings/performance"
            className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
          >
            KPI setup
          </Link>
        }
      />
      <p className="-mt-2 text-sm text-text-muted">
        How your floor performed against the KPIs you chose, built from the calls, conversions and
        payments your systems sent us.
      </p>

      {/* First, because every number below is only as true as the last event. */}
      <FreshnessBanner freshness={data.freshness} />

      {data.demoMode ? (
        <Card>
          <MonoLabel>Sample data</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            Demo mode is on, so some figures below are sample data and not your own. Turn it off in
            KPI setup once your own events are arriving.
          </p>
        </Card>
      ) : null}

      <DateRangeBar
        path="/owner/kpi"
        presets={rangePresets("/owner/kpi", parsed.window, { calendar: true })}
        from={data.window.from}
        to={data.window.to}
        today={today}
      />

      {data.clampedTo ? (
        <Card>
          <MonoLabel>Shortened to your plan&rsquo;s history</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            This plan shows history back to {formatReportRange(data.clampedTo, data.clampedTo)}, so
            the range starts there. Nothing older has been deleted — a higher plan brings it back.{" "}
            <Link href="/owner/plan" className="underline underline-offset-2">
              Compare plans
            </Link>
          </p>
        </Card>
      ) : null}

      <DateRangeSummary from={data.window.from} to={data.window.to} zone={zone} />

      {!data.configured ? (
        <EmptyState
          title="No KPIs chosen yet"
          description="Pick four to six things your floor is measured on, set a target for each, and this page fills in."
          action={
            <Link
              href="/owner/settings/performance"
              className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
            >
              Choose your KPIs
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <CompositeCard summary={data.org} title="Organization score" />
            <div className="lg:col-span-2">
              <FunnelCard funnel={data.funnel} dispositions={data.dispositions} />
            </div>
          </div>

          <section className="space-y-3">
            <MonoLabel>Your KPIs</MonoLabel>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.org.kpis.map((kpi) => (
                <KpiCard key={kpi.key} kpi={kpi} />
              ))}
            </div>
          </section>

          {/* On a floor too small to split, the API sends no "Behind" at all
              rather than the same people reversed, so the one card takes the
              width instead of sitting beside an empty twin. */}
          <div className={`grid gap-6 ${data.bottom.length > 0 ? "lg:grid-cols-2" : ""}`}>
            <PerformerCard
              title={data.bottom.length > 0 ? "Ahead" : "Ranked"}
              rows={data.top}
              empty="Nobody has a score yet in this period."
            />
            {data.bottom.length > 0 ? (
              <PerformerCard
                title="Behind"
                rows={data.bottom}
                empty="Nobody has a score yet in this period."
              />
            ) : null}
          </div>

          {data.unranked > 0 ? (
            <p className="text-xs text-text-muted">
              {data.unranked} {data.unranked === 1 ? "person has" : "people have"} no score in this
              period — too little data to say. They are listed on the{" "}
              <Link href="/owner/kpi/leaderboard" className="underline underline-offset-2">
                leaderboard
              </Link>{" "}
              with the reason.
            </p>
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * Top and bottom performers.
 *
 * Note that "Behind" lists people whose score COULD be computed. Somebody with
 * no score is not bottom of the floor - they are unmeasured, and putting them
 * here would be a judgement the data does not support. They are counted
 * separately below the cards instead.
 */
function PerformerCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Overview["top"];
  empty: string;
}) {
  return (
    <Card>
      <MonoLabel>{title}</MonoLabel>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {rows.map((row) => (
            <li key={row.subject.id ?? row.name} className="flex items-center gap-3 py-2">
              <span className="w-6 shrink-0 text-sm tabular-nums text-text-muted">
                {row.rank ?? "—"}
              </span>
              <Link
                href={`/owner/kpi/telecaller/${row.subject.id}`}
                className="flex-1 truncate text-sm text-text underline-offset-2 hover:underline"
              >
                {row.name}
                {row.unnamed ? (
                  <span className="ml-2 text-xs text-text-muted">unnamed</span>
                ) : null}
              </Link>
              <span className="tabular-nums text-sm font-medium text-text">
                {row.composite.score === null ? "—" : `${row.composite.score.toFixed(0)}%`}
              </span>
              <BandChip label={row.bandLabel} tone={row.bandTone} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
