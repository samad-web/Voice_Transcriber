import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Banknote, Gauge, Target, TrendingUp, Users } from "lucide-react";
import { Sparkline, StatCard } from "@aura/ui";
import {
  DEFAULT_TIME_ZONE,
  type Attainment,
  type PerformanceOverview,
  conversionRate,
  leadsPerWeek,
  overviewHeadline,
  todayIn,
  winRate,
  winsPerWeek,
} from "@aura/shared";
import { DateRangeBar, DateRangeNotice, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import {
  DEFAULT_RANGE_DAYS,
  parseDateWindow,
  rangePresets,
  resolveDateWindow,
  spanDays,
  windowPhrase,
} from "@/lib/date-range";
import { getOwner, ownerGet, ownerTry, requireFeature } from "@/lib/owner-context";
import {
  CampaignsPanel,
  ChannelsPanel,
  FunnelPanel,
  GoalsPanel,
  StandingChip,
  TeamPanel,
} from "./performance-panels";

export const metadata: Metadata = { title: "Performance" };

/**
 * The command centre - the floor, the sales desk and the marketing spend over
 * one window, read against the period's targets.
 *
 * ── WHY THIS EXISTS BESIDE THE DASHBOARD ────────────────────────────────────
 *
 * `/owner` composes a dashboard per persona and answers "how is my department
 * doing". This answers "are the departments pulling in the same direction",
 * and the difference is not presentational. Every figure here is only
 * meaningful beside one from another department: cost per lead is a marketing
 * number until it sits next to the win rate on the leads it bought, and a
 * rep's call volume is an activity number until it sits next to the pipeline
 * that came out of it. The dashboard shows departments; this shows the seams.
 *
 * ── TWO FETCHES, CONCURRENT, AND ONE OF THEM MAY FAIL ───────────────────────
 *
 * The roll-up comes from `/v1/owner/performance`; the targets come from
 * `/v1/targets/attainment`, which already computes attainment AND pace and is
 * the only implementation of it in the codebase. Targets are fetched with
 * `ownerGet`, which yields null on failure rather than throwing: a workspace
 * that has set no target, or a CRM module that is off, must not take the sales
 * and marketing panels down with it. The roll-up itself uses `ownerTry`,
 * because without it there is no page.
 *
 * ── EVERY FIGURE NAMES ITS CLOCK ────────────────────────────────────────────
 *
 * Leads CREATED in the window, deals CLOSED in the window, pipeline as it
 * stands NOW. The API holds that line (docs/29 A4) and the tiles below say
 * which is which, because "pipeline value" over a 7-day window would otherwise
 * read as "pipeline built this week", which is a different and much smaller
 * number.
 */

interface AttainmentResponse {
  attainment: Attainment[];
  asOf: string;
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10_000_000) return `${(value / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(value) >= 100_000) return `${(value / 100_000).toFixed(1)}L`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return Math.round(value).toLocaleString();
}

function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function days(value: number | null): string {
  return value == null ? "—" : `${value}d`;
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/performance");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const sp = await searchParams;
  const { window, invalid } = parseDateWindow(sp);
  const zone = owner.membership.reportingTimezone ?? DEFAULT_TIME_ZONE;
  const requested = resolveDateWindow(window, todayIn(zone));

  const [result, targets] = await Promise.all([
    ownerTry<PerformanceOverview>(`/v1/owner/performance?${new URLSearchParams(requested)}`),
    // Null rather than a throw - see the header.
    ownerGet<AttainmentResponse>("/v1/targets/attainment"),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Performance" context="Reports" />
        <LoadFailure what="the performance roll-up" failure={result} />
      </>
    );
  }

  // The API returns `goals: []` and says why - attainment is composed here
  // rather than re-derived there, so there is only ever one implementation of
  // "what has been closed against this quarter".
  const data: PerformanceOverview = { ...result.data, goals: targets?.attainment ?? [] };
  const shown = { from: data.from, to: data.to };

  const conversion = conversionRate(data.sales);
  const win = winRate(data.sales);
  // Inclusive calendar days in the org's zone, from the API's own echo - so the
  // per-week figures are counted over the days actually reported rather than over
  // whatever the URL asked for.
  const span = spanDays(shown.from, shown.to);
  const rangeLabel = windowPhrase(window, shown);
  const leadSeries = data.daily.map((d) => d.leads);
  const wonSeries = data.daily.map((d) => d.won);

  return (
    <>
      <PageHeader title="Performance" context="Reports" />

      <DateRangeBar
        path="/owner/performance"
        // Calendar periods belong here most of all: a target is set against a
        // month, and "this month so far" is the range a quarter gets called on.
        presets={rangePresets("/owner/performance", window, { calendar: true })}
        from={shown.from}
        to={shown.to}
        today={todayIn(zone)}
      />
      {invalid ? <DateRangeNotice fallbackDays={DEFAULT_RANGE_DAYS} /> : null}
      <DateRangeSummary from={shown.from} to={shown.to} zone={zone} />

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-text">{overviewHeadline(data)}</p>
        <StandingChip goals={data.goals} />
      </div>

      {/* ── THE HEADLINE BAND ───────────────────────────────────────────────
          Four numbers an owner is answerable for. Won value and pipeline are
          both money and sit next to each other on purpose: one is banked and
          one is hoped for, and a page that shows only the second is how a
          quarter gets called early. */}
      <section aria-label="Headline" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="New leads"
          value={data.sales.leadsCreated}
          icon={<Users aria-hidden="true" className="h-4 w-4" />}
          context="created in this range"
          // The sparkline is DECORATIVE and aria-hidden by construction: the tile
          // already states the total in text and the funnel below carries the
          // shape in a table twin. It earns its place by answering "is that 200
          // steady or is it one good Tuesday", which a single number cannot.
          footer={
            leadSeries.length > 1 ? (
              <>
                <Sparkline values={leadSeries} filled />
                <span>per day</span>
              </>
            ) : undefined
          }
        />
        <StatCard
          label="Closed won"
          value={money(data.sales.wonValue)}
          icon={<Banknote aria-hidden="true" className="h-4 w-4" />}
          context={`${data.sales.won} deal${data.sales.won === 1 ? "" : "s"} closed in this range`}
          footer={
            wonSeries.length > 1 ? (
              <>
                <Sparkline values={wonSeries} filled />
                <span>per day</span>
              </>
            ) : undefined
          }
        />
        <StatCard
          label="Open pipeline"
          value={money(data.sales.pipelineValue)}
          icon={<TrendingUp aria-hidden="true" className="h-4 w-4" />}
          // NOW, not in the window - and it says so, because a pipeline figure
          // under a date range is otherwise read as pipeline built in it.
          context={`${data.sales.velocity.openCount} open right now`}
        />
        <StatCard
          label="Win rate"
          value={pct(win)}
          icon={<Target aria-hidden="true" className="h-4 w-4" />}
          context={
            win == null
              ? "too few closed to say"
              : `of ${data.sales.won + data.sales.lost} closed either way`
          }
        />
      </section>

      {/* ── VELOCITY AND CONVERSION ─────────────────────────────────────────
          `tone="plain"`: a second filled band would compete with the one above,
          and the kit reserves the fill for the headline row. */}
      <section aria-label="Velocity" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          tone="plain"
          label="Lead to win"
          value={pct(conversion)}
          icon={<Gauge aria-hidden="true" className="h-4 w-4" />}
          context={
            conversion == null
              ? "too few leads to say"
              : `of the ${data.sales.leadsCreated} leads created here`
          }
        />
        <StatCard
          tone="plain"
          label="Typical cycle"
          value={days(data.sales.velocity.medianDaysToWin)}
          icon={<Gauge aria-hidden="true" className="h-4 w-4" />}
          // Median leads, mean follows - one large deal drags the mean far
          // enough to make it useless for "how long is our cycle".
          context={
            data.sales.velocity.avgDaysToWin == null
              ? "median days from lead to win"
              : `median · ${days(data.sales.velocity.avgDaysToWin)} average`
          }
        />
        <StatCard
          tone="plain"
          label="Marketing spend"
          value={data.marketing.spendRecorded ? money(data.marketing.totalSpend) : "—"}
          icon={<Banknote aria-hidden="true" className="h-4 w-4" />}
          context={
            data.marketing.spendRecorded
              ? `across ${data.marketing.campaigns.length} campaign${data.marketing.campaigns.length === 1 ? "" : "s"}`
              : "no campaign spend recorded"
          }
        />
        <StatCard
          tone="plain"
          label="On the phones"
          value={data.team.length}
          icon={<Users aria-hidden="true" className="h-4 w-4" />}
          context={`${data.team.reduce((n, m) => n + m.calls, 0)} calls between them`}
        />
      </section>

      {/* Above the campaign tables: the funnel is the answer to "where is the
          pipeline leaking", which is the question this page is opened with, and
          the marketing panels below are about where the leads came from. */}
      <FunnelPanel
        funnel={data.funnel}
        leadsPerWeek={leadsPerWeek(data.sales.leadsCreated, span)}
        winsPerWeek={winsPerWeek(data.sales.won, span)}
        rangeLabel={rangeLabel}
      />

      <GoalsPanel goals={data.goals} />

      <CampaignsPanel marketing={data.marketing} />
      <ChannelsPanel channels={data.marketing.channels} />

      <TeamPanel team={data.team} />
    </>
  );
}
