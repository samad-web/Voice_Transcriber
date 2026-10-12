import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, MonoLabel } from "@aura/ui";
import { todayIn } from "@aura/shared";
import { DateRangeBar, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { parseDateWindow, rangePresets, resolveDateWindow } from "@/lib/date-range";
import { getOrgTimeZone } from "@/lib/org-time";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { BandChip, formatKpi, type SummaryView } from "../kpi-cards";

export const metadata: Metadata = { title: "Team performance" };

interface Teams {
  window: { from: string; to: string };
  clampedTo: string | null;
  /** `flat` | `teams` | `org_chart`, from the plan. */
  structure: string | null;
  teams: {
    id: string;
    name: string;
    parentTeamId: string | null;
    headcount: number;
    inactive: number;
    summary: SummaryView;
  }[];
}

/**
 * Reports → Team performance (§8.4, M5).
 *
 * ── THE PLAN DECIDES HOW MUCH STRUCTURE IS SHOWN ────────────────────────────
 *
 * §4's `team_structure` entitlement is graded: `flat` (a list of people),
 * `teams`, then `org_chart` on Scale. This page reads the variant and says
 * which one the tenant has rather than hiding the difference - a locked
 * capability that is simply absent reads as a missing feature, and §9.3 asks
 * for the opposite: name it, say what it does, say which plan has it.
 *
 * ── A TEAM'S NUMBERS ARE COMPUTED, NOT SUMMED ───────────────────────────────
 *
 * `kpi_snapshots` carries `subject_kind = 'team'` rows written by the engine
 * from the facts, not derived from the people's rows. The reason is
 * `leads_worked`: two reps who both rang the same person are two distinct
 * leads each and one for the team, and a sum would double-count them. The
 * integration test pins that specific case.
 */
export default async function TeamPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/kpi/teams");
  await requireOwnerRoles(["owner", "manager"]);

  const sp = await searchParams;
  const zone = await getOrgTimeZone();
  const today = todayIn(zone);
  const parsed = parseDateWindow(sp);
  const window = resolveDateWindow(parsed.window, today);

  const result = await ownerTry<Teams>(`/v1/insights/teams?from=${window.from}&to=${window.to}`);
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Team performance" context="Reports" />
        <LoadFailure failure={result} what="team performance" />
      </>
    );
  }
  const data = result.data;
  const columns = data.teams.find((t) => t.summary.kpis.length > 0)?.summary.kpis ?? [];

  return (
    <>
      <PageHeader title="Team performance" context="Reports" />
      <p className="-mt-2 text-sm text-text-muted">
        Each team&rsquo;s attainment against its own targets, where one is set, and the org&rsquo;s
        otherwise.
      </p>

      <DateRangeBar
        path="/owner/kpi/teams"
        presets={rangePresets("/owner/kpi/teams", parsed.window, { calendar: true })}
        from={data.window.from}
        to={data.window.to}
        today={today}
      />
      <DateRangeSummary from={data.window.from} to={data.window.to} zone={zone} />

      {data.teams.length === 0 ? (
        <EmptyState
          title="No teams yet"
          description="Send teams with PUT /v1/ingest/teams/{your-id}, then put each telecaller in one. Until then every number rolls up to the organization."
          action={
            <Link
              href="/owner/api-platform"
              className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
            >
              API platform
            </Link>
          }
        />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="px-3 py-2 font-medium text-text-muted">
                  Team
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-text-muted">
                  People
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-text-muted">
                  Score
                </th>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    className="px-3 py-2 text-right font-medium text-text-muted"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.teams.map((team) => (
                <tr key={team.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <Link
                      href={`/owner/kpi/leaderboard?team=${team.id}`}
                      className="text-text underline-offset-2 hover:underline"
                    >
                      {team.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-muted">
                    {team.headcount}
                    {team.inactive > 0 ? (
                      <span className="ml-1 text-xs">(+{team.inactive} archived)</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-2">
                      <span className="tabular-nums font-medium text-text">
                        {team.summary.composite.score === null
                          ? "—"
                          : `${team.summary.composite.score.toFixed(0)}%`}
                      </span>
                      <BandChip label={team.summary.bandLabel} tone={team.summary.bandTone} />
                    </span>
                  </td>
                  {team.summary.kpis.map((kpi) => (
                    <td key={kpi.key} className="px-3 py-2 text-right tabular-nums">
                      <span className={kpi.suppressed ? "text-text-muted" : "text-text"}>
                        {formatKpi(kpi.actual, kpi.unit)}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data.structure === "org_chart" ? (
        <Card>
          <MonoLabel>Organization chart</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            Your plan includes the full chart — who reports to whom, what each seat is responsible
            for, and span of control.{" "}
            <Link href="/owner/org-chart" className="underline underline-offset-2">
              Open it
            </Link>
          </p>
        </Card>
      ) : (
        /* §9.3's locked preview: name it, one sentence on what it does, the
           plan that has it, one action. No fake numbers presented as theirs. */
        <Card>
          <MonoLabel>Organization chart — on Scale</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            {data.structure === "flat"
              ? "Your plan shows people as a flat list. Growth adds teams; Scale adds the full organization chart — reporting lines, responsibilities and span of control."
              : "Your plan shows teams. Scale adds the full organization chart — reporting lines, responsibilities and span of control."}{" "}
            <Link href="/owner/plan" className="underline underline-offset-2">
              Compare plans
            </Link>
          </p>
        </Card>
      )}
    </>
  );
}
