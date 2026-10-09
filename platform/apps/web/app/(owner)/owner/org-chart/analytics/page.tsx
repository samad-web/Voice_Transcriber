import type { Metadata } from "next";
import Link from "next/link";
import { Card, StatCard, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import type { AnalyticsPayload } from "../types";

export const metadata: Metadata = { title: "Organization analytics" };

/**
 * §11's owner analytics (milestone M8).
 *
 * ── OWNER AND MANAGER ONLY, UNLIKE THE CHART ITSELF ────────────────────────
 *
 * The chart is open to every persona (§7), and this page is not. The
 * difference is what the numbers are ABOUT: "span of control, with outliers
 * flagged" and "vacancy rate" are judgements on how the business is organized,
 * and the flagged outlier is a named manager whose team is too big or too
 * small. That is a conversation between an owner and a manager, not floor
 * information - and §14's "leaderboard-style comparisons on chart: not shown"
 * is the same instinct applied one level up.
 *
 * ── EVERY FIGURE COMES FROM ONE READ ───────────────────────────────────────
 *
 * M8's acceptance is that "analytics numbers reconcile with underlying rows".
 * The API computes all of this from the same `loadChartRows` the chart draws
 * from, through the same shared functions - so there is no arrangement in
 * which this page says 42 vacancies and the chart shows 43. A second set of
 * SQL aggregates would have been faster to write and would have been a second
 * definition of "vacant".
 */
export default async function OrgChartAnalyticsPage() {
  await requireFeature("/owner/org-chart");
  await requireOwnerRoles(["owner", "manager"]);

  const analytics = await ownerTry<AnalyticsPayload>("/v1/org-chart/analytics");

  if (!analytics.ok) {
    return (
      <>
        <PageHeader title="Organization analytics" context="Settings" />
        <LoadFailure what="your organization analytics" failure={analytics} />
      </>
    );
  }

  const data = analytics.data;
  const flagged = new Map(data.spanOfControl.flags.map((f) => [f.positionId, f]));

  return (
    <>
      <PageHeader
        title="Organization analytics"
        context="Settings"
        description="Headcount, how wide each manager's team is, what is empty, and how long people stay."
      />

      <div className="flex flex-wrap gap-2">
        <Link
          href="/owner/org-chart"
          className="text-sm text-accent-text underline-offset-2 hover:underline"
        >
          Back to the chart
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Positions" value={data.headcount.positions} />
        <StatCard label="Filled" value={data.headcount.filled} />
        {/*
          `people` is not `filled`, and the label says so. One person can hold
          a seat and act in another, so a business counting staff from the
          chart needs the distinct-people number - reporting only "filled"
          would overcount them.
        */}
        <StatCard
          label="People"
          value={data.headcount.people}
          context="Distinct people, so somebody acting in a second position is counted once."
        />
        <StatCard
          label="Vacant"
          value={data.headcount.vacant}
          context={`${Math.round(data.vacancyRate * 100)}% of all positions`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-sm font-medium text-text">Shape of the organization</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-text-muted">Layers of hierarchy</dt>
              <dd className="text-text">{data.layers}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-text-muted">Frozen positions</dt>
              <dd className="text-text">{data.headcount.frozen}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-text-muted">Median time in a position</dt>
              <dd className="text-text">
                {data.tenure.medianMonths === null
                  ? "—"
                  : data.tenure.medianMonths < 12
                    ? `${data.tenure.medianMonths} months`
                    : `${(data.tenure.medianMonths / 12).toFixed(1)} years`}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-text-muted">Average time to fill a position</dt>
              <dd className="text-text">
                {data.timeToFill.averageDays === null ? (
                  // Honest about an empty sample rather than printing a zero
                  // that reads as "instantly".
                  <span className="text-text-muted">Nothing filled yet</span>
                ) : (
                  <>
                    {data.timeToFill.averageDays} days
                    <span className="text-text-muted"> · {data.timeToFill.sample} filled</span>
                  </>
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-text-muted">
            Median, not average, for time in a position: one long-serving founder in a team of new
            joiners makes an average that describes nobody.
          </p>
        </Card>

        <Card>
          <h2 className="text-sm font-medium text-text">How long people have been in their position</h2>
          <ul className="mt-3 space-y-2">
            {data.tenure.buckets.map((bucket) => {
              const total = data.tenure.buckets.reduce((sum, b) => sum + b.count, 0);
              const share = total === 0 ? 0 : (bucket.count / total) * 100;
              return (
                <li key={bucket.label} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">{bucket.label}</span>
                    <span className="text-text">{bucket.count}</span>
                  </div>
                  {/* A bar, not a chart library: one dimension, four rows. The
                      width is the only encoding and the number is beside it,
                      so the bar is never the only carrier of meaning. */}
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${share}%` }}
                      role="presentation"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card>
        <h2 className="text-sm font-medium text-text">Team sizes</h2>
        <p className="mt-1 text-xs text-text-muted">
          Flagged above {data.settings.spanOfControlMax} direct reports or below{" "}
          {data.settings.spanOfControlMin}. A manager with one report is usually a layer that
          exists for a title; one with fifteen cannot give any of them much time.
        </p>
        {data.spanOfControl.managers.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">Nobody has any direct reports yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {[...data.spanOfControl.managers]
              .sort((a, b) => b.directReports - a.directReports)
              .map((manager) => {
                const flag = flagged.get(manager.positionId);
                return (
                  <li
                    key={manager.positionId}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <Link
                      href={`/owner/org-chart?position=${manager.positionId}`}
                      className="truncate text-sm text-accent-text underline-offset-2 hover:underline"
                    >
                      {manager.title}
                    </Link>
                    <span className="flex items-center gap-2 text-sm text-text">
                      {manager.directReports}
                      {flag ? (
                        <StatusChip tone="danger">
                          {flag.flag === "too_wide" ? "Wide" : "Narrow"}
                        </StatusChip>
                      ) : null}
                    </span>
                  </li>
                );
              })}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-medium text-text">Headcount by department</h2>
        {data.byDepartment.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">No positions yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {data.byDepartment.map((department) => (
              <li
                key={department.departmentId ?? "none"}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="truncate text-text">{department.name}</span>
                <span className="text-text-muted">
                  {department.filled} filled
                  {department.vacant > 0 ? ` · ${department.vacant} vacant` : ""}
                  {department.frozen > 0 ? ` · ${department.frozen} frozen` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {data.vacancies.length > 0 ? (
        <Card>
          <h2 className="text-sm font-medium text-text">What is empty</h2>
          <p className="mt-1 text-xs text-text-muted">
            A vacancy with people reporting to it is the one to fill first: anything escalated
            there currently reaches nobody.
          </p>
          <ul className="mt-3 divide-y divide-border">
            {[...data.vacancies]
              // Reports first, then alphabetically - the ordering IS the advice.
              .sort((a, b) => b.directReports - a.directReports || a.title.localeCompare(b.title))
              .map((vacancy) => (
                <li
                  key={vacancy.positionId}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <Link
                    href={`/owner/org-chart?position=${vacancy.positionId}`}
                    className="truncate text-accent-text underline-offset-2 hover:underline"
                  >
                    {vacancy.title}
                    {vacancy.department ? (
                      <span className="text-text-muted"> · {vacancy.department}</span>
                    ) : null}
                  </Link>
                  {vacancy.directReports > 0 ? (
                    <span className="shrink-0 text-orange-text">
                      {vacancy.directReports} waiting
                    </span>
                  ) : (
                    <span className="shrink-0 text-text-muted">no reports</span>
                  )}
                </li>
              ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
