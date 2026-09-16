import type { Metadata } from "next";
import { Banknote, ListChecks, Megaphone, PhoneCall, Target, Trophy, Users } from "lucide-react";
import type { OwnerRole } from "@aura/shared";
import { Card, MonoLabel, StatCard } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import type { TeamRollup as TeamRollupData } from "@/lib/team-rollup";
import { ownerNavItemsFor } from "@/lib/nav";
import { getOwner, ownerGet } from "@/lib/owner-context";
import {
  ActivityChart,
  CallOutcomes,
  CampaignTable,
  PipelineByStage,
  RecentActivity,
  SourceBreakdown,
  TelecallerTable,
  WindowPicker,
} from "./dashboard-panels";
import { NextActions } from "./next-actions";
import { TeamRollup } from "./team-rollup";
import { formatDuration, formatValue, type Overview } from "./types";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The owner console's landing page - five dashboards behind one route
 * (migration 0079).
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
 */
export default async function OwnerDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days: daysParam } = await searchParams;
  const days = Math.min(365, Math.max(1, Number(daysParam) || 30));
  // A6, Milestone 4: same page, same Overview shape - only which table it's
  // read from forks, behind the shadow-read flag. See lib/crm-cutover.ts.
  const crmPrimary = crmShadowReadEnabled();

  // `getPrincipal` is React-cached, so this costs nothing beyond what
  // `ownerGet` already resolves to authenticate the call below.
  const owner = await getOwner();
  const role: OwnerRole = owner?.membership.ownerRole ?? "owner";
  const callIntel = owner?.membership.enabledModules.includes("call_intel") ?? false;

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
  const [data, team] = await Promise.all([
    ownerGet<Overview>(
      crmPrimary ? `/v1/owner/crm-overview?days=${days}` : `/v1/owner/overview?days=${days}`,
    ),
    wantsTeam ? ownerGet<TeamRollupData>(`/v1/reports/team?days=${days}`) : Promise.resolve(null),
  ]);

  if (!data) {
    return (
      <>
        <PageHeader title="Dashboard" context="Instance" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

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

  const view = { data, days, crmPrimary, role, callIntel, tasksVisible, team };

  return (
    <>
      <PageHeader title={data.org.name || "Dashboard"} context={HEADER_CONTEXT[role]} />
      <WindowPicker days={days} />
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
  days: number;
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

/** Won / (won + lost), or null when nothing has closed - never 0%. */
function winRate(leads: Overview["leads"]): number | null {
  const closed = leads.won + leads.lost;
  return closed > 0 ? Math.round((leads.won / closed) * 100) : null;
}

/**
 * THE OWNER — the whole business, unchanged from before personas existed.
 *
 * Deliberately identical to what shipped: an owner's dashboard was never the
 * problem this change set out to solve, and quietly redesigning the page every
 * existing customer already reads would have been an unrequested cost paid by
 * people who did not ask for it.
 */
function OwnerDashboard({ data, days, crmPrimary, callIntel, tasksVisible, team }: ViewProps) {
  const { leads, calls, funnel, telecallers, byDay, stages, recent } = data;
  const l = links(crmPrimary);
  const rate = winRate(leads);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Open leads"
          value={leads.open}
          context={`${leads.created_in_window} new in ${days}d`}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Pipeline value"
          value={formatValue(leads.pipeline_value)}
          context={`across ${leads.open} open ${leads.open === 1 ? "lead" : "leads"}`}
          icon={<Banknote className="h-5 w-5" />}
        />
        <StatCard
          label="Won"
          value={leads.won}
          context={`${rate === null ? "nothing closed yet" : `${rate}% win rate`}${
            leads.won_value > 0 ? ` · ${formatValue(leads.won_value)}` : ""
          }`}
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          label="Calls"
          value={calls.total}
          context={`${formatDuration(calls.total_seconds)} on the phone`}
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

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <CallOutcomes
          calls={calls}
          days={days}
          href={callIntel ? "/owner/calls" : undefined}
        />
        <ActivityChart byDay={byDay} days={days} leadLabel={crmPrimary ? "Deals" : "Leads"} />
      </div>

      <PipelineByStage funnel={funnel} total={leads.total} crmPrimary={crmPrimary} {...l} />

      {team ? <TeamRollup data={team} days={days} /> : null}
      <TelecallerTable telecallers={telecallers} days={days} />
      <RecentActivity recent={recent} stages={stages} {...l} />
    </>
  );
}

/**
 * THE MANAGER — the same data, led by the team rather than by the money.
 *
 * The difference from the owner's page is ORDER and EMPHASIS, not access: a
 * manager sees every record an owner does (their record scope is `all`). What
 * changes is that the leaderboard comes first instead of fourth, and the KPI
 * row swaps "pipeline value" - a number a manager does not control - for the
 * overdue follow-up count, which is the thing they can actually do something
 * about this afternoon.
 */
function ManagerDashboard({ data, days, crmPrimary, callIntel, tasksVisible, team }: ViewProps) {
  const { leads, calls, funnel, telecallers, byDay, stages, recent, tasks } = data;
  const l = links(crmPrimary);
  const rate = winRate(leads);
  const active = telecallers.filter((t) => t.calls > 0).length;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Open leads"
          value={leads.open}
          context={`${leads.created_in_window} new in ${days}d`}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Team on the phone"
          value={`${active}/${telecallers.length}`}
          context={`${formatDuration(calls.total_seconds)} across ${calls.total} calls`}
          icon={<Users className="h-5 w-5" />}
        />
        <StatCard
          label="Win rate"
          // A string, and one the tile has to render as prose rather than as a
          // figure. "Not enough closed yet" is the honest answer when nothing
          // has closed - a "0%" win rate says the team is losing, which is a
          // different and untrue claim.
          value={rate === null ? "Not enough closed yet" : `${rate}%`}
          context={`${leads.won} won · ${leads.lost} lost`}
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          label="Overdue follow-ups"
          value={tasks.overdue}
          context={`${tasks.open} open in total`}
          icon={<ListChecks className="h-5 w-5" />}
        />
      </div>

      {tasksVisible ? <NextActions canViewTeam /> : null}

      {/* The roll-up leads. A manager opens this page to find out who needs
          help today, and that answer was previously three scrolls down. The
          CRM roll-up comes before the call leaderboard because it is about
          PEOPLE and their work; the leaderboard below is about the phone
          lines, which is a different question with a different unit. */}
      {team ? <TeamRollup data={team} days={days} /> : null}

      <TelecallerTable telecallers={telecallers} days={days} title="Who is on the phone" />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <CallOutcomes
          calls={calls}
          days={days}
          href={callIntel ? "/owner/calls" : undefined}
          label="How the floor's calls went"
        />
        <ActivityChart byDay={byDay} days={days} leadLabel={crmPrimary ? "Deals" : "Leads"} />
      </div>

      <PipelineByStage funnel={funnel} total={leads.total} crmPrimary={crmPrimary} {...l} />

      <RecentActivity recent={recent} stages={stages} {...l} label="Latest across the team" />
    </>
  );
}

/**
 * THE TELECALLER — one person's desk.
 *
 * Every number here is already narrowed to them by the API. The composition is
 * built around the question they actually have, which is not "how is the
 * business doing" but "what should I do next": follow-ups first, then their
 * own pipeline, then the calls they made.
 *
 * No pipeline VALUE anywhere on this page, and that is deliberate rather than
 * an omission. A telecaller is measured on activity and conversion; putting a
 * rupee total on their landing page invites them to work the biggest card
 * rather than the next one, and the value of a lead they were handed is not a
 * number they set.
 */
function TelecallerDashboard({ data, days, crmPrimary, tasksVisible }: ViewProps) {
  const { leads, calls, funnel, byDay, stages, recent, tasks } = data;
  const l = links(crmPrimary);
  const rate = winRate(leads);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Your open leads"
          value={leads.open}
          context={`${leads.created_in_window} new in ${days}d`}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Your calls"
          value={calls.total}
          context={`${formatDuration(calls.total_seconds)} on the phone`}
          icon={<PhoneCall className="h-5 w-5" />}
          state={calls.missed > 0 ? "missed" : undefined}
          stateLabel={calls.missed > 0 ? `${calls.missed} missed` : undefined}
        />
        <StatCard
          label="Follow-ups due"
          value={tasks.overdue + tasks.due_today}
          context={`${tasks.overdue > 0 ? `${tasks.overdue} overdue · ` : ""}${tasks.open} open`}
          icon={<ListChecks className="h-5 w-5" />}
        />
        <StatCard
          label="You won"
          value={leads.won}
          context={rate === null ? "nothing closed yet" : `${rate}% win rate`}
          icon={<Trophy className="h-5 w-5" />}
        />
      </div>

      {/* Follow-ups first: "what should I do next" is the question this desk
          opens the console to answer. */}
      {tasksVisible ? <NextActions canViewTeam={false} /> : null}

      <PipelineByStage
        funnel={funnel}
        total={leads.total}
        crmPrimary={crmPrimary}
        scoped
        {...l}
        label="Your leads by stage"
      />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <CallOutcomes calls={calls} days={days} label="How your calls went" />
        <ActivityChart
          byDay={byDay}
          days={days}
          leadLabel={crmPrimary ? "Deals" : "Leads"}
          title={`Your calls and new leads - last ${days} days`}
        />
      </div>

      <RecentActivity
        recent={recent}
        stages={stages}
        {...l}
        label="Your latest activity"
        emptyLabel="Nothing assigned to you yet"
      />
    </>
  );
}

/**
 * THE SALES REP — one person's pipeline, measured in money.
 *
 * The mirror image of the telecaller page, and the difference is the point: a
 * rep IS measured on value, so pipeline and won value lead, and talk time does
 * not appear at all. Both personas are scoped to their own records; what
 * separates them is which of their own numbers matter.
 */
function SalesDashboard({ data, days, crmPrimary, tasksVisible }: ViewProps) {
  const { leads, funnel, byDay, stages, recent, tasks } = data;
  const l = links(crmPrimary);
  const rate = winRate(leads);
  const noun = crmPrimary ? "deals" : "leads";

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Your pipeline"
          value={formatValue(leads.pipeline_value)}
          context={`across ${leads.open} open ${noun}`}
          icon={<Banknote className="h-5 w-5" />}
        />
        <StatCard
          label="You won"
          value={formatValue(leads.won_value)}
          context={`${leads.won} closed in this window`}
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          label="Win rate"
          value={rate === null ? "Not enough closed yet" : `${rate}%`}
          context={`${leads.won} won · ${leads.lost} lost`}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Follow-ups due"
          value={tasks.overdue + tasks.due_today}
          context={`${tasks.overdue > 0 ? `${tasks.overdue} overdue · ` : ""}${tasks.open} open`}
          icon={<ListChecks className="h-5 w-5" />}
        />
      </div>

      {tasksVisible ? <NextActions canViewTeam={false} /> : null}

      <PipelineByStage
        funnel={funnel}
        total={leads.total}
        crmPrimary={crmPrimary}
        scoped
        {...l}
        label={`Your ${noun} by stage`}
      />

      <ActivityChart
        byDay={byDay}
        days={days}
        leadLabel={crmPrimary ? "Deals" : "Leads"}
        title={`Your new ${noun} - last ${days} days`}
      />

      <RecentActivity
        recent={recent}
        stages={stages}
        {...l}
        label="Your latest activity"
        emptyLabel={`Nothing assigned to you yet`}
      />
    </>
  );
}

/**
 * THE MARKETER — demand, by where it came from.
 *
 * The only persona whose dashboard is a genuinely different QUESTION rather
 * than a re-cut of the same one. A marketer is not working a pipeline; they
 * are answering "which channel is worth the money", so the page leads with
 * arrivals per source and the conversion rate behind each, and the pipeline
 * appears only as the downstream result.
 *
 * Their record scope is `all`, not `own` (roles.ts): nothing is assigned to a
 * marketer, so narrowing them to their own records would produce an empty page
 * by construction. They are restricted by OBJECT instead - no call transcripts,
 * no invoices, no customer inbox - which the nav and the API guards enforce.
 */
function MarketingDashboard({ data, days, crmPrimary, tasksVisible }: ViewProps) {
  const { leads, funnel, byDay, bySource, byCampaign, stages, recent } = data;
  const l = links(crmPrimary);
  const rate = winRate(leads);
  const channels = bySource.length;
  const best = [...bySource].sort((a, b) => b.won - a.won)[0];

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label={`New leads in ${days}d`}
          value={leads.created_in_window}
          context={`${channels} ${channels === 1 ? "channel" : "channels"} attributed`}
          icon={<Megaphone className="h-5 w-5" />}
        />
        <StatCard
          label="Converted"
          value={rate === null ? "Not enough closed yet" : `${rate}%`}
          context={`${leads.won} won · ${leads.lost} lost`}
          icon={<Target className="h-5 w-5" />}
        />
        <StatCard
          label="Revenue won"
          value={formatValue(leads.won_value)}
          // Names the channel that CLOSED the most, not the one that delivered
          // the most - the whole reason this dashboard exists. A channel name
          // is a string on a tile whose value is a number, which is exactly
          // what the second line is for.
          context={best && best.won > 0 ? `best channel: ${best.channel}` : "nothing closed yet"}
          icon={<Banknote className="h-5 w-5" />}
        />
        <StatCard
          label="Open pipeline"
          value={formatValue(leads.pipeline_value)}
          context={`across ${leads.open} open leads`}
          icon={<Trophy className="h-5 w-5" />}
        />
      </div>

      {tasksVisible ? <NextActions canViewTeam={false} /> : null}

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <SourceBreakdown bySource={bySource} days={days} />
        <ActivityChart
          byDay={byDay}
          days={days}
          leadLabel="Arrivals"
          title={`Arrivals per day - last ${days} days`}
        />
      </div>

      <CampaignTable byCampaign={byCampaign} days={days} />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <PipelineByStage
          funnel={funnel}
          total={leads.total}
          crmPrimary={crmPrimary}
          {...l}
          label="What happened to them"
        />
        <RecentActivity recent={recent} stages={stages} {...l} label="Newest arrivals" />
      </div>
    </>
  );
}
