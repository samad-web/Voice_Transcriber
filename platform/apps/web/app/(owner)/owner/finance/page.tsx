import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DEFAULT_TIME_ZONE, todayIn } from "@aura/shared";
import { DateRangeBar, DateRangeNotice, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import {
  DEFAULT_RANGE_DAYS,
  parseDateWindow,
  rangePresets,
  resolveDateWindow,
} from "@/lib/date-range";
import { getOwner, ownerTry, requireFeature } from "@/lib/owner-context";
import { FinanceOverview, type FinanceOverviewData } from "./finance-overview";

export const metadata: Metadata = { title: "Finance" };

/**
 * §11's owner finance dashboard: "booked, collected, costs, margin,
 * outstanding, runway".
 *
 * ── EVERY NUMBER ON THIS PAGE DRILLS DOWN ──────────────────────────────────
 *
 * §11 is a MUST: "every number is clickable and drills down to the underlying
 * payments, schedule items or expenses." The destinations are not decided
 * here - the API returns them from the `FINANCE_METRICS` catalogue, so a
 * metric cannot be rendered on a tile the console has no route for, and adding
 * one without a drill-down fails a test rather than a user's click.
 *
 * ── AND IT SAYS HOW OLD IT IS ──────────────────────────────────────────────
 *
 * The freshness stamp (§11's other MUST) sits under the range bar rather than
 * tucked in a corner: "data as of 15:42; razorpay synced 3 min ago". A
 * dashboard that cannot say how old it is gets believed at the wrong moment -
 * the morning after a connector stopped delivering.
 *
 * ── THE RANGE CONTROL IS THE SHARED ONE ────────────────────────────────────
 *
 * `DateRangeBar` with calendar presets, exactly as `/owner/performance` uses
 * it, and the window resolved against the ORG's today rather than this
 * server's - which is UTC and a day ahead of an Indian floor until 05:30. A
 * finance page that silently reported the wrong day's collections for five and
 * a half hours every morning would be the worst possible version of this bug.
 */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/finance");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  // ── OWNER AND MANAGER ───────────────────────────────────────────────────
  //
  // Not enforced here with `requireOwnerRoles`, because the API already does
  // it and more precisely: `finance:view` is seeded to the three admin roles
  // and deliberately NOT to `workspace_member` (0172), so a telecaller gets a
  // 403 from the route rather than an empty page from a persona check that
  // would also have to guess at the grid. A `LoadFailure` on a 403 is the
  // honest rendering of "you may not read this", and it is what every other
  // grid-gated page in this console does.
  const sp = await searchParams;
  const { window, invalid } = parseDateWindow(sp);
  const zone = owner.membership.reportingTimezone ?? DEFAULT_TIME_ZONE;
  const today = todayIn(zone);
  const requested = resolveDateWindow(window, today);

  const overview = await ownerTry<FinanceOverviewData>(
    `/v1/finance/overview?${new URLSearchParams(requested)}`,
  );

  if (!overview.ok) {
    return (
      <>
        <PageHeader title="Finance" context="Sales" />
        <LoadFailure what="your finance overview" failure={overview} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Finance"
        context="Sales"
        actions={
          <Link
            href="/owner/finance/advisor"
            className="text-xs text-text-muted underline hover:text-text"
          >
            Money-leak inbox
          </Link>
        }
      />

      <DateRangeBar
        path="/owner/finance"
        // Calendar periods belong here most of all: a month is the unit a
        // business closes its books in, and "this month so far" is what
        // somebody asks a finance page for.
        presets={rangePresets("/owner/finance", window, { calendar: true })}
        from={overview.data.period.from}
        to={overview.data.period.to}
        today={today}
      />
      {invalid ? <DateRangeNotice fallbackDays={DEFAULT_RANGE_DAYS} /> : null}
      <DateRangeSummary from={overview.data.period.from} to={overview.data.period.to} zone={zone} />

      <FinanceOverview data={overview.data} />
    </>
  );
}
