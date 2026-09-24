import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Banknote, ListChecks, Megaphone, PhoneCall, Target, Trophy, Users } from "lucide-react";
import { resolveTimeZone, todayIn, type OwnerRole } from "@aura/shared";
import { StatCard } from "@aura/ui";
import { DateRangeNotice } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import { inSpan, percentDelta, pointsDelta, rateText, share, windowLabel } from "@/lib/dashboard-charts";
import { DEFAULT_RANGE_DAYS, dateWindowQuery, parseDateWindow, resolveDateWindow } from "@/lib/date-range";
import type { TeamRollup as TeamRollupData } from "@/lib/team-rollup";
import { ownerNavItemsFor } from "@/lib/nav";
import { getOwner, ownerGet, ownerTry } from "@/lib/owner-context";
import { DeltaNote } from "./_dashboard/chart-parts";
import { LeadAging } from "./_dashboard/lead-aging";
import { MissedHeatmap } from "./_dashboard/missed-heatmap";
import { PipelineHealth } from "./_dashboard/pipeline-health";
import { ResponseSpeed } from "./_dashboard/response-speed";
import { SourceEffectiveness } from "./_dashboard/source-effectiveness";
import { TrendChart } from "./_dashboard/trend-chart";
import { CHANNEL_LABELS, CallOutcomes, CampaignTable, RecentActivity, TelecallerTable, WindowPicker } from "./dashboard-panels";
import { NextActions } from "./next-actions";
import { TeamRollup } from "./team-rollup";
import { formatDuration, formatValue, type Overview } from "./types";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The owner console's landing page - five dashboards behind one route
 * (migration 0079), drawn with the redesign's charts (Build docs/29).
 *
 * ── WHY ONE ROUTE AND NOT FIVE ────────────────────────────────────────────
 *
 * `/owner` is where the layout sends everybody after login, and it is the href
 * in the sidebar. Splitting it into `/owner/manager`, `/owner/telecaller` and
 * so on would mean the console's most-linked URL had to know the reader's
 * persona before it could route them - so every link to "the dashboard" would
 * need resolving server-side, and a bookmarked one would send a demoted
 * manager to a page they can no longer read. One route that composes itself
 * from the persona has neither problem: the URL is stable, and a persona
 * change takes effect on the next render.
 *
 * ── THE DATA IS ALREADY NARROWED ──────────────────────────────────────────
 *
 * Nothing below filters anything. `/v1/owner/overview` applies the persona's
 * record scope in SQL (owner-scope.ts), so a telecaller's payload contains
 * only their leads and calls before it reaches this file. What varies here is
 * WHICH numbers are worth showing and what they are called - "Open leads" for
 * an owner is the whole floor, and the same key for a telecaller is their own
 * desk, so the label changes even though the field does not.
 *
 * Rendering is therefore never the control. If this file had a bug that showed
 * a telecaller the manager composition, they would see their own numbers under
 * the wrong headings - not somebody else's data.
 *
 * ── EVERY FIGURE NAMES ITS CLOCK (docs/29 P1) ─────────────────────────────
 *
 * A tile is either NOW (open leads, pipeline value, overdue), or IN THE WINDOW
 * (calls, new leads, closes) - the last N calendar days in the workspace's
 * zone, today included, or a From/To range from the shared date control, as
 * the API echoes them in `window`. "Won" used to be
 * all-time under a 30-day picker, and the sales tile claimed "closed in this
 * window" over an all-time count; it is now the closes in the window, the
 * same predicate Reports uses, compared with the window before it.
 */
export default async function OwnerDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The shared date control (lib/date-range.ts): the last N days, resolved by
  // the API in the org's calendar, or any From/To pair.
  const { window, invalid } = parseDateWindow(await searchParams, { maxDays: 365 });
  // A6, Milestone 4: same page, same Overview shape - only which table it's
  // read from forks, behind the shadow-read flag. See lib/crm-cutover.ts.
  const crmPrimary = crmShadowReadEnabled();

  // `getPrincipal` is React-cached, so this costs nothing beyond what
  // `ownerGet` already resolves to authenticate the call below.
  const owner = await getOwner();
  const role: OwnerRole = owner?.membership.ownerRole ?? "owner";
  const callIntel = owner?.membership.enabledModules.includes("call_intel") ?? false;
  const windowQuery = dateWindowQuery(window);
  // The team roll-up's API resolves `days` against a UTC today, so it is sent
  // the workspace's own dates instead - the same days the overview counts.
  const teamRange = new URLSearchParams(
    resolveDateWindow(window, todayIn(resolveTimeZone(owner?.membership.reportingTimezone))),
  );

  /*
   * Owners and managers also get the per-person roll-up (Phase 8). Fetched in
   * parallel with the overview rather than after it - this page already costs
   * one Mumbai-to-Seoul round trip, and a second in series would be felt.
   *
   * A rep never asks for it: their dashboard is their own desk, the API would
   * refuse an `owned` caller outright (reports.service.ts), and asking anyway
   * would spend a round trip to render nothing.
   */
  const wantsTeam = role === "owner" || role === "manager";
  const [result, team] = await Promise.all([
    ownerTry<Overview>(
      crmPrimary ? `/v1/owner/crm-overview?${windowQuery}` : `/v1/owner/overview?${windowQuery}`,
    ),
    wantsTeam ? ownerGet<TeamRollupData>(`/v1/reports/team?${teamRange}`) : Promise.resolve(null),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Dashboard" context="Instance" />
        <LoadFailure what="the dashboard" failure={result} />
      </>
    );
  }
  const data = result.data;

  // Next actions appears only where this reader can open Tasks at all - the same
  // persona, module and feature rule the rail applies, so the panel never
  // renders a list the API would refuse (tasks are CRM-module objects).
  const tasksVisible = owner
    ? ownerNavItemsFor(
        role,
        crmPrimary,
        owner.membership.enabledModules.includes("crm"),
        callIntel,
        { modules: owner.membership.enabledModules, features: owner.membership.featureOverrides },
      ).some((item) => item.href === "/owner/tasks")
    : false;

  // The zone the numbers were COUNTED in, as the API echoed it; the
  // membership's is the fallback for an older API (Build docs/30).
  const zone = resolveTimeZone(data.window.timezone ?? owner?.membership.reportingTimezone);
  // The window's length as the API counted it, and how the page words it: a
  // preset is "30d" / "last 30 days"; a custom range is its own dates, since
  // "last 30 days" over 1-30 June would be untrue by July.
  const days = data.window.days ?? (window.kind === "relative" ? window.days : 30);
  // "Today" is a one-day preset, and "Won in 1d" says it worse than "won today".
  const rangeWords =
    window.kind === "fixed" ? windowLabel(data.window.from, data.window.to) : days === 1 ? "today" : null;
  const span = rangeWords ?? `${days}d`;
  const period = rangeWords ?? undefined;
  const view = { data, days, span, period, crmPrimary, role, callIntel, tasksVisible, team, zone };

  return (
    <>
      <PageHeader title={data.org.name || "Dashboard"} context={HEADER_CONTEXT[role]} />
      <WindowPicker
        window={window}
        // The API's echo; an API older than the echo gets the same days worked
        // out from the org's today, so the From/To pair never opens empty.
        from={data.window.from ?? teamRange.get("from") ?? undefined}
        to={data.window.to ?? teamRange.get("to") ?? undefined}
        zone={zone}
        canChangeZone={role === "owner" || role === "manager"}
      />
      {invalid ? <DateRangeNotice fallbackDays={DEFAULT_RANGE_DAYS} maxDays={365} /> : null}
      {role === "telecaller" ? <TelecallerDashboard {...view} /> : null}
      {role === "sales" ? <SalesDashboard {...view} /> : null}
      {role === "marketing" ? <MarketingDashboard {...view} /> : null}
      {role === "manager" ? <ManagerDashboard {...view} /> : null}
      {role === "owner" ? <OwnerDashboard {...view} /> : null}
    </>
  );
}

/**
 * The eyebrow above the page title. Small, and the only thing on the page that
 * names the persona outright - which is the point: somebody handed a login
 * should be able to tell what kind of account they have without having to
 * infer it from which sidebar entries are missing.
 */
const HEADER_CONTEXT: Record<OwnerRole, string> = {
  owner: "Instance",
  manager: "Team",
  telecaller: "Your desk",
  sales: "Your pipeline",
  marketing: "Demand",
};

interface ViewProps {
  data: Overview;
  /** The window's length in days, as the API counted it. */
  days: number;
  /** The window as a tile says it: "30d", or a custom range's dates. */
  span: string;
  /** A custom range's dates for panel subtitles; undefined = "last N days". */
  period: string | undefined;
  crmPrimary: boolean;
  role: OwnerRole;
  /**
   * Whether this tenant has the `call_intel` module, so the call-outcomes
   * panel knows whether "open the call log" is a link it may offer. Resolved
   * on the server like every other entitlement; a persona that can see the
   * OUTCOMES of calls is not necessarily entitled to read what was said in
   * them, which is why this is a separate flag rather than an inference from
   * the numbers being non-zero.
   */
  callIntel: boolean;
  /** Whether the Next actions panel may render - see the page body. */
  tasksVisible: boolean;
  /**
   * The per-person roll-up, for the two personas entitled to it. Null for
   * everyone else, and also when the call failed - a dashboard that still
   * renders its own numbers is a better answer than one that 500s over a
   * panel, so the panel simply does not appear.
   */
  team: TeamRollupData | null;
  /** The workspace zone every time on the page is read in (docs/30). */
  zone: string;
}

/** Links fork on the shadow-read flag, not on the persona. */
function links(crmPrimary: boolean) {
  return {
    pipelineHref: crmPrimary ? "/owner/deals" : "/owner/board",
    pipelineLinkLabel: crmPrimary ? "Open deals board →" : "Open board →",
    // The board/leads pages don't accept a ?stage=/?focus= query yet, so the
    // CRM-primary links point at the plain page rather than a param it would
    // silently ignore - see CRM_STATUS.md, A6 Milestone 4.
    stageHref: (stageKey: string) => (crmPrimary ? "/owner/deals" : `/owner/leads?stage=${stageKey}`),
    allHref: crmPrimary ? "/owner/deals" : "/owner/leads",
    allLinkLabel: crmPrimary ? "All deals →" : "All leads →",
    recordHref: (id: string) => (crmPrimary ? "/owner/deals" : `/owner/leads?focus=${id}`),
    emptyLabel: crmPrimary ? "No deals yet" : "No leads yet",
  };
}

/** The call log for one calendar day - the trend's drill-down, when the reader may open it. */
const callLogDay = (day: string) => `/owner/calls?from=${day}&to=${day}`;

/**
 * Closes IN the window - the redesign's `closed`, falling back to the all-time
 * counts only for an API older than it (the tile then says "all time").
 */
function closes(data: Overview) {
  if (data.closed) return { ...data.closed, windowed: true };
  return { won: data.leads.won, lost: data.leads.lost, won_value: data.leads.won_value, windowed: false };
}

/** Win rate over closes: null when nothing closed - never "0%", which would claim the team loses everything. */
function winShare(won: number, lost: number): number | null {
  return share(won, won + lost);
}

/** A KPI tile's context: the fact on one line, the change on the next. */
function TileContext({ fact, change }: { fact: ReactNode; change?: ReactNode }) {
  return (
    <>
      <span className="block">{fact}</span>
      {change ? <span className="mt-0.5 block">{change}</span> : null}
    </>
  );
}

/** The KPI deltas every persona draws from. */
function deltas(data: Overview) {
  const p = data.previous;
  const c = closes(data);
  if (!p) return { calls: null, created: null, won: null, winRate: null };
  return {
    calls: percentDelta(data.calls.total, p.calls),
    created: percentDelta(data.leads.created_in_window, p.leads_created),
    won: percentDelta(c.won, p.won),
    winRate: pointsDelta(winShare(c.won, c.lost), winShare(p.won, p.lost)),
  };
}

/**
 * THE OWNER — the whole business: money first, then what to do today, then
 * what happened, where it went wrong, and who (docs/29 §2.1). Each band
 * answers the question the band above it raises.
 */
function OwnerDashboard({ data, days, span, period, crmPrimary, callIntel, tasksVisible, team, zone }: ViewProps) {
  const { leads, calls, telecallers, byDay, stages, recent } = data;
  const l = links(crmPrimary);
  const c = closes(data);
  const d = deltas(data);
  const noun = crmPrimary ? "deals" : "leads";

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label={crmPrimary ? "Open deals" : "Open leads"}
          value={leads.open}
          context={
            <TileContext
              fact={`now · ${leads.created_in_window} new ${inSpan(span)}`}
              change={<DeltaNote delta={d.created} days={days} />}
            />
          }
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Pipeline value"
          value={formatValue(leads.pipeline_value)}
          context={`now · across ${leads.open} open ${leads.open === 1 ? noun.replace(/s$/, "") : noun}`}
          icon={<Banknote className="h-5 w-5" />}
        />
        <StatCard
          label={c.windowed ? `Won ${inSpan(span)}` : "Won (all time)"}
          value={c.won}
          context={
            <TileContext
              fact={`${c.won + c.lost === 0 ? "nothing closed" : `${rateText(c.won, c.won + c.lost)} of ${c.won + c.lost} closed`}${
                c.won_value > 0 ? ` · ${formatValue(c.won_value)}` : ""
              }`}
              change={<DeltaNote delta={d.won} days={days} />}
            />
          }
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          label="Calls"
          value={calls.total}
          context={
            <TileContext
              fact={`${formatDuration(calls.total_seconds)} on the phone`}
              change={<DeltaNote delta={d.calls} days={days} />}
            />
          }
          icon={<PhoneCall className="h-5 w-5" />}
          // The one state a KPI tile carries, and only when there is one to
          // carry. On the fill it renders as a white chip with the slashed
          // ring, not as red - see StatCard's note on why the tile drops the
          // hue. The full breakdown is in CallOutcomes below; this is the
          // flag that sends somebody down to it.
          state={calls.missed > 0 ? "missed" : undefined}
          stateLabel={calls.missed > 0 ? `${calls.missed} missed` : undefined}
        />
      </div>

      {tasksVisible ? <NextActions canViewTeam /> : null}

      <TrendChart
        byDay={byDay}
        days={days}
        title={`Calls and new ${noun}`}
        leadNoun={noun}
        callLogHref={callIntel ? callLogDay : undefined}
      />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <MissedHeatmap cells={data.callHeat ?? []} days={days} period={period} />
        <CallOutcomes calls={calls} previous={data.previous} days={days} period={period} href={callIntel ? "/owner/calls" : undefined} />
      </div>

      <PipelineHealth data={data} crmPrimary={crmPrimary} {...l} />

      <AgingAndResponse data={data} days={days} period={period} />

      {team ? <TeamRollup data={team} days={days} span={span} /> : null}
      <TelecallerTable telecallers={telecallers} days={days} period={period} zone={zone} />
      <RecentActivity recent={recent} stages={stages} zone={zone} {...l} />
    </>
  );
}

/**
 * Lead aging beside response speed - the two "who is waiting" readings. Both
 * exist only on the leads read; on the CRM read (deals carry no first
 * response) neither renders, rather than drawing zeros that mean "cannot
 * answer" as if they meant "none" (the API's `triage: null` contract).
 */
function AgingAndResponse({
  data,
  days,
  period,
  scoped,
  responseFirst,
}: {
  data: Overview;
  days: number;
  period?: string;
  scoped?: boolean;
  responseFirst?: boolean;
}) {
  const aging = data.triage && data.agingBuckets ? <LeadAging triage={data.triage} buckets={data.agingBuckets} scoped={scoped} /> : null;
  const response = data.response ? <ResponseSpeed response={data.response} days={days} period={period} /> : null;
  if (!aging && !response) return null;
  const panels = responseFirst ? [response, aging] : [aging, response];
  return (
    <div className={`grid grid-cols-1 gap-5 sm:gap-6 ${aging && response ? "lg:grid-cols-2" : ""}`}>
      {panels.filter(Boolean).map((panel, i) => (
        // *:h-full: the two cards share a row, so the shorter one stretches to
        // the taller rather than leaving a hole under it.
        <div key={i} className="min-w-0 *:h-full">
          {panel}
        </div>
      ))}
    </div>
  );
}

/**
 * THE MANAGER — the same data, led by the team rather than by the money.
 *
 * The difference from the owner's page is ORDER and EMPHASIS, not access: a
 * manager sees every record an owner does (their record scope is `all`). What
 * changes is that the people come first, then how fast the floor answers, and
 * the KPI row swaps "pipeline value" - a number a manager does not control -
 * for the overdue follow-up count, which is the thing they can actually do
 * something about this afternoon.
 */
function ManagerDashboard({ data, days, span, period, crmPrimary, callIntel, tasksVisible, team, zone }: ViewProps) {
  const { leads, calls, telecallers, byDay, stages, recent, tasks } = data;
  const l = links(crmPrimary);
  const c = closes(data);
  const d = deltas(data);
  const rate = winShare(c.won, c.lost);
  const active = telecallers.filter((t) => t.calls > 0).length;
  const noun = crmPrimary ? "deals" : "leads";

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label={crmPrimary ? "Open deals" : "Open leads"}
          value={leads.open}
          context={
            <TileContext
              fact={`now · ${leads.created_in_window} new ${inSpan(span)}`}
              change={<DeltaNote delta={d.created} days={days} />}
            />
          }
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Team on the phone"
          value={`${active}/${telecallers.length}`}
          context={
            <TileContext
              fact={`${formatDuration(calls.total_seconds)} across ${calls.total} calls`}
              change={<DeltaNote delta={d.calls} days={days} />}
            />
          }
          icon={<Users className="h-5 w-5" />}
        />
        <StatCard
          label={c.windowed ? `Win rate, ${span}` : "Win rate (all time)"}
          // "Not enough closed yet" is the honest answer when nothing has
          // closed - a "0%" win rate says the team is losing, which is a
          // different and untrue claim.
          value={rate === null ? "Not enough closed yet" : rateText(c.won, c.won + c.lost)}
          context={
            <TileContext fact={`${c.won} won · ${c.lost} lost`} change={<DeltaNote delta={d.winRate} days={days} unit=" pts" />} />
          }
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          label="Overdue follow-ups"
          value={tasks.overdue}
          context={`now · ${tasks.open} open in total`}
          icon={<ListChecks className="h-5 w-5" />}
        />
      </div>

      {tasksVisible ? <NextActions canViewTeam /> : null}

      {/* The roll-up leads. A manager opens this page to find out who needs
          help today, and that answer was previously three scrolls down. The
          CRM roll-up comes before the call leaderboard because it is about
          PEOPLE and their work; the leaderboard below is about the phone
          lines, which is a different question with a different unit. */}
      {team ? <TeamRollup data={team} days={days} span={span} /> : null}

      <TelecallerTable telecallers={telecallers} days={days} period={period} zone={zone} title="Who is on the phone" />

      <AgingAndResponse data={data} days={days} period={period} responseFirst />

      <TrendChart
        byDay={byDay}
        days={days}
        title={`Calls and new ${noun} across the team`}
        leadNoun={noun}
        callLogHref={callIntel ? callLogDay : undefined}
      />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <MissedHeatmap cells={data.callHeat ?? []} days={days} period={period} />
        <CallOutcomes
          calls={calls}
          previous={data.previous}
          days={days}
          period={period}
          href={callIntel ? "/owner/calls" : undefined}
          label="How the floor's calls went"
        />
      </div>

      <PipelineHealth data={data} crmPrimary={crmPrimary} {...l} />

      <RecentActivity recent={recent} stages={stages} zone={zone} {...l} label="Latest across the team" />
    </>
  );
}

/**
 * THE TELECALLER — one person's desk.
 *
 * Every number here is already narrowed to them by the API. The composition is
 * built around the question they actually have, which is not "how is the
 * business doing" but "what should I do next": follow-ups first, then their
 * own pipeline and where it is stuck, then the calls they made and when they
 * missed them.
 *
 * No pipeline VALUE anywhere on this page, and that is deliberate rather than
 * an omission. A telecaller is measured on activity and conversion; putting a
 * rupee total on their landing page invites them to work the biggest card
 * rather than the next one, and the value of a lead they were handed is not a
 * number they set.
 */
function TelecallerDashboard({ data, days, span, period, crmPrimary, tasksVisible, zone }: ViewProps) {
  const { leads, calls, byDay, stages, recent, tasks } = data;
  const l = links(crmPrimary);
  const c = closes(data);
  const d = deltas(data);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Your open leads"
          value={leads.open}
          context={`now · ${leads.created_in_window} new ${inSpan(span)}`}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Your calls"
          value={calls.total}
          context={
            <TileContext
              fact={`${formatDuration(calls.total_seconds)} on the phone`}
              change={<DeltaNote delta={d.calls} days={days} />}
            />
          }
          icon={<PhoneCall className="h-5 w-5" />}
          state={calls.missed > 0 ? "missed" : undefined}
          stateLabel={calls.missed > 0 ? `${calls.missed} missed` : undefined}
        />
        <StatCard
          label="Follow-ups due"
          value={tasks.overdue + tasks.due_today}
          context={`now · ${tasks.overdue > 0 ? `${tasks.overdue} overdue · ` : ""}${tasks.open} open`}
          icon={<ListChecks className="h-5 w-5" />}
        />
        <StatCard
          label={c.windowed ? `You won, ${span}` : "You won (all time)"}
          value={c.won}
          context={c.won + c.lost === 0 ? "nothing closed yet" : `${rateText(c.won, c.won + c.lost)} of ${c.won + c.lost} closed`}
          icon={<Trophy className="h-5 w-5" />}
        />
      </div>

      {/* Follow-ups first: "what should I do next" is the question this desk
          opens the console to answer. */}
      {tasksVisible ? <NextActions canViewTeam={false} /> : null}

      <PipelineHealth data={data} crmPrimary={crmPrimary} scoped showValue={false} {...l} label="Your pipeline" />

      <TrendChart
        byDay={byDay}
        days={days}
        title={`Your calls and new ${crmPrimary ? "deals" : "leads"}`}
        leadNoun={crmPrimary ? "deals" : "leads"}
      />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <MissedHeatmap cells={data.callHeat ?? []} days={days} period={period} label="When your inbound calls go unanswered" />
        <CallOutcomes calls={calls} previous={data.previous} days={days} period={period} label="How your calls went" />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        {data.triage && data.agingBuckets ? <LeadAging triage={data.triage} buckets={data.agingBuckets} scoped /> : null}
        <RecentActivity
          recent={recent}
          stages={stages}
          zone={zone}
          {...l}
          label="Your latest activity"
          emptyLabel="Nothing assigned to you yet"
        />
      </div>
    </>
  );
}

/**
 * THE SALES REP — one person's pipeline, measured in money.
 *
 * The mirror image of the telecaller page, and the difference is the point: a
 * rep IS measured on value, so pipeline and won value lead, and talk time does
 * not appear at all - which is also why their trend draws demand only, not the
 * call-state plot. Both personas are scoped to their own records; what
 * separates them is which of their own numbers matter.
 */
function SalesDashboard({ data, days, span, crmPrimary, tasksVisible, zone }: ViewProps) {
  const { leads, byDay, stages, recent, tasks } = data;
  const l = links(crmPrimary);
  const c = closes(data);
  const d = deltas(data);
  const rate = winShare(c.won, c.lost);
  const noun = crmPrimary ? "deals" : "leads";

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Your pipeline"
          value={formatValue(leads.pipeline_value)}
          context={`now · across ${leads.open} open ${noun}`}
          icon={<Banknote className="h-5 w-5" />}
        />
        <StatCard
          label={c.windowed ? `You won, ${span}` : "You won (all time)"}
          value={formatValue(c.won_value)}
          // TRUE now: `closed` counts closes inside the window. It used to
          // print "closed in this window" over an all-time count (docs/29 A4).
          context={
            <TileContext
              fact={c.windowed ? `${c.won} closed in this window` : `${c.won} closed in all`}
              change={<DeltaNote delta={d.won} days={days} />}
            />
          }
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          label="Win rate"
          value={rate === null ? "Not enough closed yet" : rateText(c.won, c.won + c.lost)}
          context={<TileContext fact={`${c.won} won · ${c.lost} lost`} change={<DeltaNote delta={d.winRate} days={days} unit=" pts" />} />}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Follow-ups due"
          value={tasks.overdue + tasks.due_today}
          context={`now · ${tasks.overdue > 0 ? `${tasks.overdue} overdue · ` : ""}${tasks.open} open`}
          icon={<ListChecks className="h-5 w-5" />}
        />
      </div>

      {tasksVisible ? <NextActions canViewTeam={false} /> : null}

      <PipelineHealth data={data} crmPrimary={crmPrimary} scoped {...l} label={`Your ${noun}`} />

      <TrendChart byDay={byDay} days={days} title={`Your new ${noun}`} leadNoun={noun} showCalls={false} />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        {data.triage && data.agingBuckets ? <LeadAging triage={data.triage} buckets={data.agingBuckets} scoped /> : null}
        <RecentActivity
          recent={recent}
          stages={stages}
          zone={zone}
          {...l}
          label="Your latest activity"
          emptyLabel={`Nothing assigned to you yet`}
        />
      </div>
    </>
  );
}

/**
 * THE MARKETER — demand, by where it came from.
 *
 * The only persona whose dashboard is a genuinely different QUESTION rather
 * than a re-cut of the same one. A marketer is not working a pipeline; they
 * are answering "which channel is worth the money", so the page leads with
 * arrivals per source and the conversion behind each, then how fast the floor
 * picked those arrivals up, and the pipeline appears only as the downstream
 * result.
 *
 * Their record scope is `all`, not `own` (roles.ts): nothing is assigned to a
 * marketer, so narrowing them to their own records would produce an empty page
 * by construction. They are restricted by OBJECT instead - no call transcripts,
 * no invoices, no customer inbox - which the nav and the API guards enforce.
 */
function MarketingDashboard({ data, days, span, period, crmPrimary, tasksVisible, zone }: ViewProps) {
  const { leads, byDay, bySource, byCampaign, stages, recent } = data;
  const l = links(crmPrimary);
  const c = closes(data);
  const d = deltas(data);
  const rate = winShare(c.won, c.lost);
  const channels = bySource.length;
  const best = [...bySource].sort((a, b) => b.won - a.won)[0];

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label={`New leads ${inSpan(span)}`}
          value={leads.created_in_window}
          context={
            <TileContext
              fact={`${channels} ${channels === 1 ? "channel" : "channels"} attributed`}
              change={<DeltaNote delta={d.created} days={days} />}
            />
          }
          icon={<Megaphone className="h-5 w-5" />}
        />
        <StatCard
          // "Win rate", as on every other persona: won ÷ CLOSED in the window.
          // The source panel below reports won ÷ ARRIVED as "won so far" - two
          // numbers both called "converted" would look like a contradiction.
          label={c.windowed ? `Win rate, ${span}` : "Win rate (all time)"}
          value={rate === null ? "Not enough closed yet" : rateText(c.won, c.won + c.lost)}
          context={<TileContext fact={`${c.won} won · ${c.lost} lost`} change={<DeltaNote delta={d.winRate} days={days} unit=" pts" />} />}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label={c.windowed ? `Revenue won, ${span}` : "Revenue won (all time)"}
          value={formatValue(c.won_value)}
          // Names the channel that CLOSED the most, not the one that delivered
          // the most - the whole reason this dashboard exists. A channel name
          // is a string on a tile whose value is a number, which is exactly
          // what the second line is for.
          context={best && best.won > 0 ? `best channel: ${CHANNEL_LABELS[best.channel] ?? best.channel}` : "nothing closed yet"}
          icon={<Banknote className="h-5 w-5" />}
        />
        <StatCard
          label="Open pipeline"
          value={formatValue(leads.pipeline_value)}
          context={`now · across ${leads.open} open leads`}
          icon={<Trophy className="h-5 w-5" />}
        />
      </div>

      {tasksVisible ? <NextActions canViewTeam={false} /> : null}

      <SourceEffectiveness bySource={bySource} days={days} period={period} />

      <div className={`grid grid-cols-1 gap-5 sm:gap-6 ${data.response ? "lg:grid-cols-2" : ""}`}>
        <TrendChart byDay={byDay} days={days} title="Arrivals per day" leadNoun="leads" showCalls={false} />
        {data.response ? <ResponseSpeed response={data.response} days={days} period={period} /> : null}
      </div>

      <CampaignTable byCampaign={byCampaign} days={days} period={period} />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <PipelineHealth data={data} crmPrimary={crmPrimary} {...l} label="What happened to them" />
        <RecentActivity recent={recent} stages={stages} zone={zone} {...l} label="Newest arrivals" />
      </div>
    </>
  );
}
