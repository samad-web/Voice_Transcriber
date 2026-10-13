import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveTimeZone, todayIn, type OwnerRole } from "@aura/shared";
import { DateRangeNotice } from "@/components/date-range-bar";
import { JoinedNotice } from "@/components/joined-notice";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import { parseGrain, parseSeries } from "@/lib/ceo-dashboard";
import { windowLabel } from "@/lib/dashboard-charts";
import { DEFAULT_RANGE_DAYS, dateWindowQuery, parseDateWindow, resolveDateWindow } from "@/lib/date-range";
import type { TeamRollup as TeamRollupData } from "@/lib/team-rollup";
import { ownerNavItemsFor } from "@/lib/nav";
import { getOwner, ownerGet, ownerTry } from "@/lib/owner-context";
import { getSessionUser } from "@/lib/supabase/server";
import { CEO_CONTEXT, CeoDashboard } from "./_dashboard/ceo";
import { WindowPicker } from "./dashboard-panels";
import { TeamRollup } from "./team-rollup";
import type { Overview } from "./types";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The owner console's landing page - the CEO analytics layout (Build docs/46),
 * composed per persona behind one route.
 *
 * ── WHAT THIS FILE IS, AFTER THE REBUILD ──────────────────────────────────
 *
 * It fetches, resolves the window and the clock, parses the chart controls out
 * of the query string, and hands all of it to ONE component. The five
 * hand-written persona compositions it used to hold are gone: they were the
 * same fourteen panels in five orders, and every change to the page had to be
 * made five times or it silently applied to four personas. `_dashboard/ceo`
 * now owns the layout and a single `BANDS` table owns the differences.
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
 * only their leads and calls before it reaches this file. What varies is
 * WHICH numbers are worth showing and what they are called.
 *
 * Rendering is therefore never the control. If this file had a bug that showed
 * a telecaller the owner composition, they would see their own numbers under
 * the wrong headings - not somebody else's data.
 *
 * ── EVERY FIGURE NAMES ITS CLOCK (docs/29 P1) ─────────────────────────────
 *
 * A tile is either NOW (open pipeline, open leads by age), IN THE WINDOW
 * (revenue won, calls, new leads) or PROJECTED - and says which in a chip
 * beside its title. The window is the last N calendar days in the workspace's
 * zone, today included, or a From/To range, as the API echoes them.
 */
export default async function OwnerDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // The shared date control (lib/date-range.ts): the last N days, resolved by
  // the API in the org's calendar, or any From/To pair.
  const { window, invalid } = parseDateWindow(params, { maxDays: 365 });
  // Set by /auth/callback on the ONE redirect that follows accepting an invite
  // (0137), and read nowhere until 0152. Nothing is granted by it: the session
  // is what gives access, and this only acknowledges that it exists.
  const joined = params.joined === "1";
  // A6, Milestone 4: same page, same Overview shape - only which table it's
  // read from forks, behind the shadow-read flag. See lib/crm-cutover.ts.
  const crmPrimary = crmShadowReadEnabled();

  // The pace chart's controls. Held in the URL for the same reason the date
  // range is (series-strip.tsx): a configured dashboard is one you can send to
  // somebody, and a reload keeps what you were looking at.
  const series = parseSeries(params.series);
  const grain = parseGrain(params.grain);
  const compare = params.compare === "1";

  // `getPrincipal` is React-cached, so this costs nothing beyond what
  // `ownerGet` already resolves to authenticate the call below.
  const owner = await getOwner();
  // ── A TENANT WITH NO LEAD SOURCE DOES NOT LAND HERE ──────────────────────
  //
  // Everything below counts leads, pipeline value, deals won and recorded
  // calls. On the API-only tier (migration 0192) none of those tables is ever
  // written: its facts arrive over /v1/ingest and live in `insights_calls`.
  // So this page greeted a tenant with 2,182 calls and 94 conversions with
  // "Open leads 0 · Pipeline value 0 · Calls 0" - the first screen after
  // signing in, telling them their business did nothing.
  //
  // The honest landing page for that tenant is the one computed from what
  // they actually send. Redirect rather than compose a sixth variant here:
  // /owner/kpi IS their dashboard, and two dashboards that have to agree is
  // the thing worth not building. Same condition as the rail's
  // LEAD_SURFACE_HREFS gate, so the rail and the landing page cannot disagree.
  //
  // Conditioned on `api_insights` as well, and that part is not belt-and-
  // braces: /owner/kpi is gated on that module, so redirecting a tenant that
  // lacks it would send them from an unhelpful page to a forbidden one.
  //
  // It sits directly under getOwner() and above every other await on
  // purpose. Redirecting further down - after the session read and the
  // window parsing - threw "Rendered more hooks than during the previous
  // render" on the client transition into it: the router had already begun
  // reconciling this page's tree when the redirect replaced it.
  const modules = owner?.membership.enabledModules;
  const makesLeads =
    (modules?.includes("crm") ?? true) || (modules?.includes("call_intel") ?? false);
  const hasInsights = modules?.includes("api_insights") ?? false;
  if (owner && !makesLeads && hasInsights) redirect("/owner/kpi");

  // Only on the one render that follows an acceptance: the claims are already
  // in the cookie, but there is no reason to read them on every dashboard load.
  const session = joined ? await getSessionUser() : null;
  const role: OwnerRole = owner?.membership.ownerRole ?? "owner";
  const callIntel = owner?.membership.enabledModules.includes("call_intel") ?? false;
  // Cash & collections, and the collections alert, are finance figures behind
  // a link into `/owner/finance`. Resolved the same way as `call_intel`, from
  // the modules on the membership - defaulting FALSE, so a render that cannot
  // resolve an owner hides the band rather than advertising it.
  const finance = owner?.membership.enabledModules.includes("finance") ?? false;

  const windowQuery = dateWindowQuery(window);
  const zoneBefore = resolveTimeZone(owner?.membership.reportingTimezone);
  // The team roll-up's API resolves `days` against a UTC today, so it is sent
  // the workspace's own dates instead - the same days the overview counts.
  const teamRange = new URLSearchParams(resolveDateWindow(window, todayIn(zoneBefore)));

  /*
   * Owners and managers also get the per-person CRM roll-up. Fetched in
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
        <PageHeader title="Dashboard" context="CEO analytics" />
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
  // preset is "30d"; a custom range is its own dates, since "last 30 days"
  // over 1-30 June would be untrue by July.
  const days = data.window.days ?? (window.kind === "relative" ? window.days : 30);
  const rangeWords =
    window.kind === "fixed" ? windowLabel(data.window.from, data.window.to) : days === 1 ? "today" : null;
  const span = rangeWords ?? `${days}d`;

  return (
    <>
      <PageHeader title={data.org.name || "Dashboard"} context={CEO_CONTEXT[role]} />
      {joined ? (
        <JoinedNotice
          email={session?.email || null}
          activityHref="/owner/account/login-activity"
          workspace={data.org.name || null}
          announced
        />
      ) : null}
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

      <CeoDashboard
        data={data}
        days={days}
        span={span}
        period={rangeWords ?? undefined}
        role={role}
        crmPrimary={crmPrimary}
        callIntel={callIntel}
        finance={finance}
        tasksVisible={tasksVisible}
        zone={zone}
        today={todayIn(zone)}
        currency={owner?.membership.baseCurrency || "INR"}
        series={series}
        grain={grain}
        compare={compare}
      />

      {/*
        The CRM roll-up, for the two personas entitled to it. It stays below
        the CEO layout rather than inside it because it answers a different
        question with a different unit: the bands above are about the PHONE -
        who dialled, who converted, what it was worth - and this is about the
        CRM work queue per person. Folding it into the attribution band would
        put "calls made" and "tasks overdue" under one heading.

        Null when the call failed as well as when the reader is not entitled:
        a dashboard that still renders its own numbers is a better answer than
        one that 500s over a panel, so the panel simply does not appear.
      */}
      {team ? <TeamRollup data={team} days={days} span={span} /> : null}
    </>
  );
}
