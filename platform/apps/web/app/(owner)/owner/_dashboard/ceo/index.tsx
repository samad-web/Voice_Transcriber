import type { OwnerRole } from "@aura/shared";
import { formatMoneyCompact, toMinor } from "@aura/shared";
import {
  DEFAULT_SERIES,
  FORECAST_DAYS,
  activeCallers,
  bucketByGrain,
  driverSlices,
  effortPlot,
  forecast,
  funnelInsight,
  funnelSteps,
  pace,
  paceInsight,
  perDayText,
  rankAlerts,
  revenuePerCall,
  scenarios,
  sliceShare,
  yieldSeries,
  type ActorInput,
  type Grain,
  type SeriesKey,
} from "@/lib/ceo-dashboard";
import { share } from "@/lib/dashboard-charts";
import { CallOutcomes, RecentActivity } from "../../dashboard-panels";
import { NextActions } from "../../next-actions";
import { formatDuration, type Overview } from "../../types";
import { MissedHeatmap } from "../missed-heatmap";
import { PipelineHealth } from "../pipeline-health";
import { ResponseSpeed } from "../response-speed";
import { SourceEffectiveness } from "../source-effectiveness";
import { actorPalette } from "./actor-colors";
import { CashCollections } from "./cash-collections";
import { ConversionFunnel } from "./conversion-funnel";
import { EffortYield } from "./effort-yield";
import { KpiRow, type KpiTile } from "./kpi-row";
import { NeedsYou } from "./needs-you";
import { OpenLeadsAge } from "./open-leads-age";
import type { PaneSpec } from "./pace-chart";
import { PaceSection } from "./pace-section";
import { Scenarios } from "./scenarios";
import { SERIES_OPTIONS, type SeriesOption } from "./series-options";
import { TelecallerMetrics, type MetricCard } from "./telecaller-metrics";
import { WhoDrives, type DriverCard } from "./who-drives";

/**
 * The CEO layout (Build docs/46), composed for whichever persona is reading.
 *
 * ── ONE LAYOUT, FIVE READERS ────────────────────────────────────────────────
 *
 * Every persona gets this page. What varies is which bands appear and what
 * the figures are CALLED, never what the reader may see: the payload was
 * already narrowed in SQL by `owner-scope.ts` before it reached this file, so
 * a telecaller's "calls" is their own desk under the same heading. Nothing
 * below filters anything, and a bug here can only mislabel somebody's own
 * numbers - it cannot show them a colleague's. Keep it that way.
 *
 * `BANDS` is the whole of the per-persona difference, in one table, for the
 * same reason the old page kept its five compositions adjacent: a band that
 * silently exists for four personas and not the fifth is a page that changes
 * shape for reasons nobody can find.
 */

interface BandSet {
  /** Attribution and per-person bands: only for a reader who manages people. */
  people: boolean;
  /** Money-denominated bands: revenue tiles, scenarios, cash. */
  money: boolean;
  /** Where demand came from - the marketing reading. */
  sources: boolean;
  /** Call-state bands: the heatmap and the outcome split. */
  calls: boolean;
}

/**
 * ── WHY THE TELECALLER STILL HAS NO RUPEE FIGURE ────────────────────────────
 *
 * Carried over from the layout this replaced, and it is a deliberate
 * omission rather than an oversight. A rep is measured on activity and
 * conversion; putting a money total in front of them invites working the
 * biggest card rather than the next one, and the value of a lead they were
 * handed is not a number they set. The sales persona DOES get money - they
 * own the number.
 */
const BANDS: Record<OwnerRole, BandSet> = {
  owner: { people: true, money: true, sources: true, calls: true },
  manager: { people: true, money: false, sources: false, calls: true },
  telecaller: { people: false, money: false, sources: false, calls: true },
  sales: { people: false, money: true, sources: false, calls: false },
  marketing: { people: false, money: true, sources: true, calls: false },
};

/** The eyebrow each persona reads under the org name. */
export const CEO_CONTEXT: Record<OwnerRole, string> = {
  owner: "CEO analytics",
  manager: "Team analytics",
  telecaller: "Your desk",
  sales: "Your pipeline",
  marketing: "Demand",
};

export interface CeoViewProps {
  data: Overview;
  days: number;
  /** The window as a chip says it: "30d", or a custom range's dates. */
  span: string;
  period: string | undefined;
  role: OwnerRole;
  crmPrimary: boolean;
  callIntel: boolean;
  /**
   * Does this workspace have the finance module?
   *
   * `BANDS.money` is a PERSONA question - may this reader see money at all -
   * and it was doing duty as both. Cash & collections is the one band that
   * needs the second question too: its tiles are finance figures and its one
   * action opens `/owner/finance`, which `requireFeature` bounces a tenant
   * without the module off before it renders. Persona alone advertised a
   * module they had not bought behind a link that went nowhere.
   */
  finance: boolean;
  tasksVisible: boolean;
  zone: string;
  /** The workspace's today, for every "how long ago" on the page. */
  today: string;
  currency: string;
  /**
   * The chart controls' INITIAL values, parsed from the query string so a
   * shared link opens on the right series. They are client state from then
   * on - see pace-section.tsx.
   */
  series: SeriesKey[];
  grain: Grain;
  compare: boolean;
}

export function CeoDashboard(props: CeoViewProps) {
  const {
    data,
    days,
    span,
    period,
    role,
    crmPrimary,
    callIntel,
    finance,
    tasksVisible,
    zone,
    today,
    currency,
  } = props;
  const bands = BANDS[role];
  const money = (major: number) => formatMoneyCompact(toMinor(major, currency), currency);
  const noun = crmPrimary ? "deals" : "leads";

  // ── the floor, as one roster every band shares ────────────────────────────
  //
  // Sorted by calls, descending: that order fixes each person's colour
  // (actor-colors.ts) and the row order in the small-multiple band, so the
  // same person is in the same place and the same hue in six panels.
  const actors: ActorInput[] = [...data.telecallers]
    .map((t) => ({
      id: t.id,
      name: t.telecaller_name || t.label || "Unnamed handset",
      calls: t.calls,
      talkSeconds: t.talk_seconds,
      leads: t.leads,
      won: t.won,
      wonValue: t.won_value,
      lastCallAt: t.last_call_at,
    }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const palette = actorPalette(actors);

  const closed = data.closed ?? {
    won: data.leads.won,
    lost: data.leads.lost,
    won_value: data.leads.won_value,
  };
  const revenue = closed.won_value;
  const perCall = revenuePerCall(revenue, data.calls.total);
  const leadWin = share(closed.won, data.leads.created_in_window);
  const callers = activeCallers(actors, today, 7);

  // ── the series ────────────────────────────────────────────────────────────
  const paceDays = data.byDay.map((d) => ({
    day: d.day,
    calls: d.calls,
    leads: d.leads,
    missed: d.missed,
  }));
  const p = pace(paceDays);
  const future = forecast(p, data.byDay.at(-1)?.day ?? today, FORECAST_DAYS);
  const rolling = yieldSeries(paceDays);
  const earlyHalf = paceDays.slice(0, Math.floor(paceDays.length / 2));

  /*
   * EVERY series, at BOTH grains, computed here and handed down.
   *
   * The toggles are client state (pace-section.tsx), so the browser must
   * already hold anything they can reveal - otherwise "instant" would mean a
   * fetch. It costs nothing worth counting: a 30-day window is eight short
   * arrays, and they are numbers the page has already loaded in `byDay`.
   *
   * The alternative - recomputing in the client component - would put the
   * bucketing and the rolling-rate logic on both sides of the wire, and
   * `lib/ceo-dashboard.ts` is the tested copy.
   */
  const buckets = {
    daily: bucketByGrain(paceDays, "daily"),
    weekly: bucketByGrain(paceDays, "weekly"),
  };

  const panesFor = (grain: Grain): Record<SeriesKey, PaneSpec> => {
    const rows = buckets[grain];
    const perBucket = grain === "weekly" ? 7 : 1;
    // The rolling rate is computed per DAY and then read at each bucket's last
    // day - a weekly mean of a rolling mean would be a different statistic.
    const endIndex = rows.map((b) => paceDays.findIndex((d) => d.day === b.endDay));
    const earlierOf = (pick: (d: { calls: number; leads: number; missed: number }) => number) =>
      p ? mean(earlyHalf.map(pick)) * perBucket : null;
    return {
      calls: {
        key: "calls",
        label: SERIES_OPTIONS.calls.label,
        fill: SERIES_OPTIONS.calls.fill,
        text: "text-outgoing",
        values: rows.map((b) => b.calls),
        projected: bucketedProjection(
          future.map((f) => f.calls),
          grain,
        ),
        earlier: earlierOf((d) => d.calls),
      },
      leads: {
        key: "leads",
        label: SERIES_OPTIONS.leads.label,
        fill: SERIES_OPTIONS.leads.fill,
        text: "text-kpi",
        values: rows.map((b) => b.leads),
        projected: bucketedProjection(
          future.map((f) => f.leads),
          grain,
        ),
        earlier: earlierOf((d) => d.leads),
      },
      missed: {
        key: "missed",
        label: SERIES_OPTIONS.missed.label,
        fill: SERIES_OPTIONS.missed.fill,
        text: "text-danger",
        values: rows.map((b) => b.missed),
        projected: [],
        earlier: earlierOf((d) => d.missed),
      },
      yield: {
        key: "yield",
        label: SERIES_OPTIONS.yield.label,
        fill: SERIES_OPTIONS.yield.fill,
        text: "text-chart-cat-3",
        rate: true,
        values: endIndex.map((i) => (i >= 0 ? (rolling[i] ?? null) : null)),
        projected: [],
        earlier: null,
      },
    };
  };
  const panesByGrain = { daily: panesFor("daily"), weekly: panesFor("weekly") };

  const seriesOptions: SeriesOption[] = [
    {
      key: "calls",
      ...SERIES_OPTIONS.calls,
      value: data.calls.total.toLocaleString(),
      context: data.previous
        ? deltaWords(data.calls.total, data.previous.calls, days)
        : `${perDayText(p?.late.perDay ?? 0)} a day lately`,
    },
    {
      key: "leads",
      ...SERIES_OPTIONS.leads,
      value: data.leads.created_in_window.toLocaleString(),
      context: data.previous
        ? deltaWords(data.leads.created_in_window, data.previous.leads_created, days)
        : "new in the window",
    },
    {
      key: "yield",
      ...SERIES_OPTIONS.yield,
      value:
        data.calls.total > 0
          ? ((data.leads.created_in_window / data.calls.total) * 100).toFixed(1)
          : "–",
      context: "7-day rolling",
    },
    {
      key: "missed",
      ...SERIES_OPTIONS.missed,
      value: data.calls.missed.toLocaleString(),
      context: inboundWords(data.calls.missed, data.calls.missed + data.calls.answered),
    },
  ];

  // ── the KPI row ───────────────────────────────────────────────────────────
  const tiles: KpiTile[] = [];
  if (bands.money) {
    tiles.push({
      key: "revenue",
      label: "Revenue won",
      clock: span,
      value: money(revenue),
      context:
        closed.won === 0
          ? "nothing closed in this window"
          : `${closed.won} ${closed.won === 1 ? "deal" : "deals"} · avg ${money(revenue / closed.won)}`,
      concern: closed.won === 0,
    });
  }
  tiles.push({
    key: "leadwin",
    label: `Lead → win`,
    clock: span,
    value: leadWin === null ? "–" : `${Math.round(leadWin * 100)}%`,
    context: `${closed.won} of ${data.leads.created_in_window} ${noun}`,
  });
  if (bands.money) {
    tiles.push({
      key: "percall",
      label: "Revenue per call",
      clock: span,
      value: perCall === null ? "–" : money(perCall),
      context:
        perCall === null
          ? "no calls to divide by"
          : `${money(revenue)} ÷ ${data.calls.total.toLocaleString()} calls`,
    });
  }
  tiles.push({
    key: "pipeline",
    label: crmPrimary ? "Open deals value" : "Open pipeline",
    clock: "now",
    value: money(data.leads.pipeline_value),
    context: `${data.leads.open} open ${data.leads.open === 1 ? noun.replace(/s$/, "") : noun}${data.leads.pipeline_value === 0 && data.leads.open > 0 ? ", unvalued" : ""}`,
    concern: data.leads.open > 0 && data.leads.pipeline_value === 0,
  });
  if (bands.people) {
    tiles.push({
      key: "callers",
      label: "Active callers",
      clock: "7d",
      value: `${callers.active} of ${callers.total}`,
      context: callers.idlest
        ? `top caller idle ${callers.idlest.idleDays} days`
        : callers.active === 0
          ? "nobody dialled this week"
          : "dialled in the last 7 days",
      concern: callers.idlest !== null || callers.active === 0,
    });
  }
  if (bands.money) {
    const projected =
      (p?.late.perDay ?? 0) *
      30 *
      (data.calls.total > 0 ? data.leads.created_in_window / data.calls.total : 0) *
      (share(closed.won, closed.won + closed.lost) ?? 0) *
      (closed.won > 0 ? revenue / closed.won : 0);
    tiles.push({
      key: "forecast",
      label: "Next 30d forecast",
      clock: "proj.",
      value: money(projected),
      context:
        p && p.kind === "fell"
          ? `${money((p.early.perDay / Math.max(p.late.perDay, 0.0001)) * projected)} if the earlier pace returns`
          : "at the current pace",
      concern: projected === 0,
    });
  }

  // ── what needs you ────────────────────────────────────────────────────────
  const untranscribed = Math.max(0, data.calls.total - data.calls.complete);
  const unmapped = data.telecallers.filter((t) => !t.telecaller_name && t.calls > 0).length;
  const topShare = actors[0] && data.calls.total > 0 ? actors[0].calls / data.calls.total : 0;
  const alerts = rankAlerts({
    pace: p,
    revenuePerCall: perCall ?? 0,
    neverContacted: data.triage?.never_responded ?? 0,
    neverContactedAge: oldestNeverBucket(data),
    winRate: share(closed.won, closed.won + closed.lost),
    dealValue: closed.won > 0 ? revenue / closed.won : 0,
    untranscribed,
    totalCalls: data.calls.total,
    unmappedHandsets: unmapped,
    topActor:
      callers.idlest && actors[0]
        ? { name: callers.idlest.name, idleDays: callers.idlest.idleDays, shareOfCalls: topShare }
        : null,
    untrackedRevenue: revenue,
    tracksCollections: false,
    collectionsAvailable: finance,
    hrefs: {
      people: bands.people ? "/owner/telecallers" : undefined,
      leads: crmPrimary ? "/owner/deals" : "/owner/leads",
      finance: bands.money && finance ? "/owner/finance" : undefined,
      devices: bands.people ? "/owner/devices" : undefined,
    },
    money,
  });

  // ── who drives the business ───────────────────────────────────────────────
  const driverCards: DriverCard[] = [
    {
      key: "revenue",
      title: "Revenue won",
      centre: money(revenue),
      centreUnit: `${closed.won} ${closed.won === 1 ? "deal" : "deals"}`,
      ...driverSlices(actors, "revenue", revenue),
      format: money,
      // The VERB is the information. "Revenue won · brindha · 60%" is the
      // legend rearranged; "brindha closed ₹1.5K of won deals" is what the
      // slice means.
      measureSentence: (who, value) => `${who} closed ${value} of won deals.`,
      insight: null,
    },
    {
      key: "leads",
      title: crmPrimary ? "Deals created" : "Leads created",
      centre: data.leads.created_in_window.toLocaleString(),
      centreUnit: noun,
      ...driverSlices(actors, "leads", data.leads.created_in_window),
      format: (v) => v.toLocaleString(),
      measureSentence: (who, value) =>
        `${who} created ${value} ${noun} in this window.`,
      insight: null,
    },
    {
      key: "calls",
      title: "Calls made",
      centre: data.calls.total.toLocaleString(),
      centreUnit: "calls",
      ...driverSlices(actors, "calls", data.calls.total),
      format: (v) => v.toLocaleString(),
      measureSentence: (who, value) => `${who} made ${value} calls.`,
      insight: null,
    },
    {
      key: "talk",
      title: "Talk time",
      centre: formatDuration(data.calls.total_seconds),
      centreUnit: "on the phone",
      ...driverSlices(actors, "talk", data.calls.total_seconds),
      format: (v) => formatDuration(v),
      measureSentence: (who, value) => `${who} spent ${value} on the phone.`,
      insight:
        data.calls.answered > 0
          ? `Average call ${Math.round(data.calls.total_seconds / data.calls.total)} s.`
          : null,
    },
  ];
  // Each donut's own sentence. Written from the slices rather than hardcoded,
  // so a floor where nobody dominates reads differently from one where
  // somebody does - which is the finding the band exists to surface.
  const topOf = (i: number) => driverCards[i]!.slices.find((x) => !x.unattributed) ?? null;
  const unattributedOf = (i: number) => driverCards[i]!.slices.find((x) => x.unattributed) ?? null;

  const revTop = topOf(0);
  const revRest = unattributedOf(0);
  driverCards[0]!.insight = !driverCards[0]!.attributable
    ? null
    : revenue === 0
      ? "Nothing closed in this window."
      : revRest && revRest.fraction >= 0.4
        ? `${Math.round(revRest.fraction * 100)}% of revenue has no owner${revTop ? ` — ${revTop.name} closed the rest` : ""}.`
        : revTop
          ? `${revTop.name} closed ${sliceShare(revTop.fraction)} of the revenue.`
          : null;

  const leadTop = topOf(1);
  driverCards[1]!.insight =
    data.leads.created_in_window === 0
      ? `No new ${noun} in this window.`
      : leadTop
        ? `${leadTop.name} found ${sliceShare(leadTop.fraction)} of the ${noun}.`
        : null;

  const callTop = topOf(2);
  if (callTop) {
    driverCards[2]!.insight =
      callTop.fraction >= 0.8
        ? "One person carries the floor — a single point of failure."
        : `${callTop.name} makes ${sliceShare(callTop.fraction)} of the calls.`;
  }

  // ── per-person metrics ────────────────────────────────────────────────────
  const metricCards: MetricCard[] = [
    {
      key: "calls",
      title: "Calls",
      clock: span,
      fill: "bg-chart-cat-1",
      rows: actors.map((a) => ({
        id: a.id,
        name: a.name,
        value: a.calls,
        text: a.calls.toLocaleString(),
      })),
    },
    {
      key: "talk",
      title: "Talk time",
      note: "total",
      fill: "bg-chart-cat-1",
      rows: actors.map((a) => ({
        id: a.id,
        name: a.name,
        value: a.talkSeconds,
        text: formatDuration(a.talkSeconds),
      })),
    },
    {
      key: "leads",
      title: crmPrimary ? "Deals" : "Leads",
      clock: span,
      fill: "bg-chart-cat-2",
      rows: actors.map((a) => ({
        id: a.id,
        name: a.name,
        value: a.leads,
        text: a.leads.toLocaleString(),
      })),
    },
    {
      key: "won",
      title: "Deals won",
      clock: span,
      fill: "bg-chart-cat-3",
      rows: actors.map((a) => ({
        id: a.id,
        name: a.name,
        value: a.won,
        text: a.won.toLocaleString(),
      })),
    },
    {
      key: "yield",
      title: "Leads per 100 calls",
      note: "higher is better",
      fill: "bg-chart-cat-3",
      rows: actors.map((a) => ({
        id: a.id,
        name: a.name,
        value: a.calls > 0 ? (a.leads / a.calls) * 100 : 0,
        text: a.calls > 0 ? ((a.leads / a.calls) * 100).toFixed(1) : "–",
      })),
    },
  ];

  const plot = effortPlot(actors, data.calls.total, data.leads.created_in_window);
  const silent = actors.filter((a) => a.calls === 0).map((a) => ({ id: a.id, name: a.name }));

  const funnel = {
    calls: data.calls.total,
    leads: data.leads.created_in_window,
    won: closed.won,
    revenue,
    collected: null,
  };

  const sc = scenarios({
    pace: p,
    leadsPerCall: data.calls.total > 0 ? data.leads.created_in_window / data.calls.total : 0,
    winRate: share(closed.won, closed.won + closed.lost),
    dealValue: closed.won > 0 ? revenue / closed.won : 0,
    wins: closed.won,
    leads: data.leads.created_in_window,
  });

  return (
    <>
      <KpiRow tiles={tiles} />

      <PaceSection
        options={seriesOptions}
        initialSeries={props.series.length > 0 ? props.series : [...DEFAULT_SERIES]}
        initialGrain={props.grain}
        initialCompare={props.compare}
        panesByGrain={panesByGrain}
        bucketsByGrain={buckets}
        forecastDays={future}
        insight={paceInsight(p)}
        clock={span}
      />

      <NeedsYou alerts={alerts} />

      {tasksVisible ? <NextActions canViewTeam={bands.people} /> : null}

      {bands.people ? (
        <>
          <WhoDrives
            cards={driverCards}
            palette={palette}
            legend={actors.slice(0, 5)}
            clock={span}
          />
          <TelecallerMetrics cards={metricCards} heading="Telecaller performance" />
        </>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {bands.people ? (
          <EffortYield
            plot={plot}
            palette={palette}
            clock={span}
            insight={effortInsight(plot)}
            silent={silent}
          />
        ) : null}
        <ConversionFunnel
          steps={funnelSteps(funnel, money)}
          insight={funnelInsight(funnel)}
          clock={span}
          money={money}
        />
      </div>

      {bands.calls ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <MissedHeatmap cells={data.callHeat ?? []} days={days} period={period} />
          <CallOutcomes
            calls={data.calls}
            previous={data.previous}
            days={days}
            period={period}
            href={callIntel ? "/owner/calls" : undefined}
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {data.response ? (
          <ResponseSpeed response={data.response} days={days} period={period} />
        ) : null}
        {data.triage && data.agingBuckets ? (
          <OpenLeadsAge
            triage={data.triage}
            buckets={data.agingBuckets}
            href={crmPrimary ? "/owner/deals" : "/owner/leads"}
          />
        ) : null}
      </div>

      <PipelineHealth
        data={data}
        crmPrimary={crmPrimary}
        pipelineHref={crmPrimary ? "/owner/deals" : "/owner/board"}
        pipelineLinkLabel={crmPrimary ? "Open deals board →" : "Open board →"}
        stageHref={(stageKey: string) =>
          crmPrimary ? "/owner/deals" : `/owner/leads?stage=${stageKey}`
        }
        showValue={bands.money}
      />

      {bands.sources ? (
        <SourceEffectiveness bySource={data.bySource} days={days} period={period} />
      ) : null}

      {bands.money ? (
        <>
          <Scenarios
            rows={sc.rows}
            lowConfidence={sc.lowConfidence}
            basis={`${data.leads.created_in_window} ${noun}, ${closed.won} ${closed.won === 1 ? "win" : "wins"}`}
            money={money}
            insight={scenarioInsight(sc.rows, money)}
          />
          {/* Only where the tenant HAS the finance module. The panel is
              deliberately empty (see cash-collections.tsx) to teach that
              revenue is not cash banked - but that lesson is for somebody who
              can act on it. Without the module it is six figures they cannot
              have behind a link `requireFeature` bounces. */}
          {finance ? (
            <CashCollections
              figures={[
                { key: "booked", label: "Booked", value: null },
                { key: "collected", label: "Collected", value: null },
                { key: "outstanding", label: "Outstanding", value: null },
                { key: "overdue", label: "Overdue 30+ d", value: null },
                { key: "days", label: "Days to collect", value: null },
                { key: "margin", label: "Margin", value: null },
              ]}
              note={`${money(revenue)} won · nothing recorded as collected — collections start with a deal template.`}
              setup={{ label: "Create a deal template to switch this on", href: "/owner/finance" }}
            />
          ) : null}
        </>
      ) : null}

      <RecentActivity
        recent={data.recent}
        stages={data.stages}
        zone={zone}
        allHref={crmPrimary ? "/owner/deals" : "/owner/leads"}
        allLinkLabel={crmPrimary ? "All deals →" : "All leads →"}
        recordHref={(id: string) => (crmPrimary ? "/owner/deals" : `/owner/leads?focus=${id}`)}
        emptyLabel={crmPrimary ? "No deals yet" : "No leads yet"}
      />
    </>
  );
}

// ── small helpers the composition reads better without ──────────────────────

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/**
 * The daily projection, re-bucketed to the chart's grain. A weekly chart gets
 * weekly totals, so its forecast columns are the same height as the actual
 * ones beside them rather than a seventh of them.
 */
function bucketedProjection(daily: readonly number[], grain: Grain): number[] {
  if (grain === "daily") return [...daily];
  const out: number[] = [];
  for (let i = 0; i < daily.length; i += 7) {
    out.push(daily.slice(i, i + 7).reduce((s, v) => s + v, 0));
  }
  return out;
}

function deltaWords(current: number, previous: number, days: number): string {
  if (previous === 0)
    return current === 0 ? "none in either window" : `none in the previous ${days} days`;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return `no change vs the previous ${days} days`;
  return `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs prev ${days}d`;
}

function inboundWords(missed: number, inbound: number): string {
  if (inbound === 0) return "no inbound calls";
  return `${Math.round((missed / inbound) * 100)}% of ${inbound} inbound`;
}

/** The oldest aging bucket that still holds an unanswered lead, in words. */
function oldestNeverBucket(data: Overview): string | null {
  const t = data.triage;
  if (!t || !data.agingBuckets) return null;
  for (const b of [...data.agingBuckets].reverse()) {
    const never = Number(t[`never_${b.key}` as keyof typeof t] ?? 0);
    if (never > 0) return b.label;
  }
  return null;
}

function effortInsight(plot: ReturnType<typeof effortPlot>): string | null {
  if (plot.points.length < 2) return null;
  const busiest = plot.points[0]!;
  const best = [...plot.points].sort((a, b) => (b.yield ?? 0) - (a.yield ?? 0))[0]!;
  if (best.id === busiest.id) return `${best.name} both dials most and converts best.`;
  if ((busiest.yield ?? 0) <= 0 || (best.yield ?? 0) <= 0) return null;
  const times = (best.yield ?? 0) / (busiest.yield ?? 1);
  if (times < 1.5) return null;
  return `${best.name} converts ${times.toFixed(times < 10 ? 1 : 0)}× better per call than ${busiest.name} but barely dials. Pair that approach with this volume.`;
}

function scenarioInsight(
  rows: readonly { key: string; value: number }[],
  money: (v: number) => string,
): string {
  const [nothing, restore, improve] = rows;
  if (!nothing || !restore || !improve) return "";
  const volume = restore.value - nothing.value;
  const quality = improve.value - restore.value;
  if (volume <= 0 && quality <= 0) return "Nothing in this window supports a projection yet.";
  if (quality > volume) {
    return `Restoring call volume is worth ~${money(volume)} a month; improving call → lead quality adds ~${money(quality)} more on top.`;
  }
  return `Restoring call volume is the bigger lever here — worth ~${money(volume)} a month against ~${money(quality)} from better conversion.`;
}
