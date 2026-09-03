import type { Metadata } from "next";
import { Banknote, ListChecks, Megaphone, PhoneCall, Target, Trophy, Users } from "lucide-react";
import type { OwnerRole } from "@aura/shared";
import { Card, MonoLabel, StatCard } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import { getOwner, ownerGet } from "@/lib/owner-context";
import {
  ActivityChart,
  CampaignTable,
  PipelineByStage,
  RecentActivity,
  SourceBreakdown,
  TaskLoad,
  TelecallerTable,
  WindowPicker,
} from "./dashboard-panels";
import { formatDuration, formatValue, type Overview } from "./types";

export const metadata: Metadata = { title: "Dashboard - Aura" };

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

  const data = await ownerGet<Overview>(
    crmPrimary ? `/v1/owner/crm-overview?days=${days}` : `/v1/owner/overview?days=${days}`,
  );

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

  const view = { data, days, crmPrimary, role };

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
function OwnerDashboard({ data, days, crmPrimary }: ViewProps) {
  const { leads, calls, funnel, telecallers, byDay, stages, recent } = data;
  const l = links(crmPrimary);
  const rate = winRate(leads);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Open leads"
          value={String(leads.open)}
          icon={<Target className="h-5 w-5" />}
          footer={<span>{leads.created_in_window} new in {days}d</span>}
        />
        <StatCard
          label="Pipeline value"
          value={formatValue(leads.pipeline_value)}
          icon={<Banknote className="h-5 w-5" />}
          footer={<span>across open leads</span>}
        />
        <StatCard
          label="Won"
          value={String(leads.won)}
          icon={<Trophy className="h-5 w-5" />}
          footer={
            <span>
              {rate === null ? "nothing closed yet" : `${rate}% win rate`}
              {leads.won_value > 0 ? ` · ${formatValue(leads.won_value)}` : ""}
            </span>
          }
        />
        <StatCard
          label="Calls"
          value={String(calls.total)}
          icon={<PhoneCall className="h-5 w-5" />}
          footer={<span>{formatDuration(calls.total_seconds)} on the phone</span>}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <PipelineByStage funnel={funnel} total={leads.total} crmPrimary={crmPrimary} {...l} />
        <ActivityChart byDay={byDay} days={days} leadLabel={crmPrimary ? "Deals" : "Leads"} />
      </div>

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
function ManagerDashboard({ data, days, crmPrimary }: ViewProps) {
  const { leads, calls, funnel, telecallers, byDay, stages, recent, tasks } = data;
  const l = links(crmPrimary);
  const rate = winRate(leads);
  const active = telecallers.filter((t) => t.calls > 0).length;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Open leads"
          value={String(leads.open)}
          icon={<Target className="h-5 w-5" />}
          footer={<span>{leads.created_in_window} new in {days}d</span>}
        />
        <StatCard
          label="Team on the phone"
          value={`${active}/${telecallers.length}`}
          icon={<Users className="h-5 w-5" />}
          footer={<span>{formatDuration(calls.total_seconds)} across {calls.total} calls</span>}
        />
        <StatCard
          label="Win rate"
          value={rate === null ? "-" : `${rate}%`}
          icon={<Trophy className="h-5 w-5" />}
          footer={
            <span>
              {leads.won} won · {leads.lost} lost
            </span>
          }
        />
        <StatCard
          label="Overdue follow-ups"
          value={String(tasks.overdue)}
          icon={<ListChecks className="h-5 w-5" />}
          footer={<span>{tasks.open} open in total</span>}
        />
      </div>

      {/* The leaderboard leads. A manager opens this page to find out who needs
          help today, and that answer was previously three scrolls down. */}
      <TelecallerTable telecallers={telecallers} days={days} title="Who is working what" />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <PipelineByStage funnel={funnel} total={leads.total} crmPrimary={crmPrimary} {...l} />
        <ActivityChart byDay={byDay} days={days} leadLabel={crmPrimary ? "Deals" : "Leads"} />
      </div>

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
function TelecallerDashboard({ data, days, crmPrimary }: ViewProps) {
  const { leads, calls, funnel, byDay, stages, recent, tasks } = data;
  const l = links(crmPrimary);
  const rate = winRate(leads);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        <StatCard
          label="Your open leads"
          value={String(leads.open)}
          icon={<Target className="h-5 w-5" />}
          footer={<span>{leads.created_in_window} new in {days}d</span>}
        />
        <StatCard
          label="Your calls"
          value={String(calls.total)}
          icon={<PhoneCall className="h-5 w-5" />}
          footer={<span>{formatDuration(calls.total_seconds)} on the phone</span>}
        />
        <StatCard
          label="Follow-ups due"
          value={String(tasks.overdue + tasks.due_today)}
          icon={<ListChecks className="h-5 w-5" />}
          footer={
            <span>
              {tasks.overdue > 0 ? `${tasks.overdue} overdue · ` : ""}
              {tasks.open} open
            </span>
          }
        />
        <StatCard
          label="You won"
          value={String(leads.won)}
          icon={<Trophy className="h-5 w-5" />}
          footer={<span>{rate === null ? "nothing closed yet" : `${rate}% win rate`}</span>}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <TaskLoad tasks={tasks} />
        <PipelineByStage
          funnel={funnel}
          total={leads.total}
          crmPrimary={crmPrimary}
          scoped
          {...l}
          label="Your leads by stage"
        />
      </div>

      <ActivityChart
        byDay={byDay}
        days={days}
        leadLabel={crmPrimary ? "Deals" : "Leads"}
        title={`Your calls and new leads - last ${days} days`}
      />

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
function SalesDashboard({ data, days, crmPrimary }: ViewProps) {
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
          icon={<Banknote className="h-5 w-5" />}
          footer={<span>across {leads.open} open {noun}</span>}
        />
        <StatCard
          label="You won"
          value={formatValue(leads.won_value)}
          icon={<Trophy className="h-5 w-5" />}
          footer={<span>{leads.won} closed in this window</span>}
        />
        <StatCard
          label="Win rate"
          value={rate === null ? "-" : `${rate}%`}
          icon={<Target className="h-5 w-5" />}
          footer={
            <span>
              {leads.won} won · {leads.lost} lost
            </span>
          }
        />
        <StatCard
          label="Follow-ups due"
          value={String(tasks.overdue + tasks.due_today)}
          icon={<ListChecks className="h-5 w-5" />}
          footer={
            <span>
              {tasks.overdue > 0 ? `${tasks.overdue} overdue · ` : ""}
              {tasks.open} open
            </span>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <PipelineByStage
          funnel={funnel}
          total={leads.total}
          crmPrimary={crmPrimary}
          scoped
          {...l}
          label={`Your ${noun} by stage`}
        />
        <TaskLoad tasks={tasks} />
      </div>

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
function MarketingDashboard({ data, days, crmPrimary }: ViewProps) {
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
          value={String(leads.created_in_window)}
          icon={<Megaphone className="h-5 w-5" />}
          footer={<span>{channels} {channels === 1 ? "channel" : "channels"} attributed</span>}
        />
        <StatCard
          label="Converted"
          value={rate === null ? "-" : `${rate}%`}
          icon={<Target className="h-5 w-5" />}
          footer={<span>{leads.won} won · {leads.lost} lost</span>}
        />
        <StatCard
          label="Revenue won"
          value={formatValue(leads.won_value)}
          icon={<Banknote className="h-5 w-5" />}
          footer={
            // Names the channel that CLOSED the most, not the one that
            // delivered the most - the whole reason this dashboard exists.
            <span>{best && best.won > 0 ? `best: ${best.channel}` : "nothing closed yet"}</span>
          }
        />
        <StatCard
          label="Open pipeline"
          value={formatValue(leads.pipeline_value)}
          icon={<Trophy className="h-5 w-5" />}
          footer={<span>across {leads.open} open leads</span>}
        />
      </div>

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
