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

export const metadata: Metadata = { title: "Leaderboard" };

interface Leaderboard {
  window: { from: string; to: string };
  clampedTo: string | null;
  visibility: "full" | "own_rank";
  total: number;
  rows: (SummaryView & {
    name: string;
    /** The name is still the integration's own id - nobody has named them. */
    unnamed?: boolean;
    teamId: string | null;
    rank: number | null;
    subject: { id: string | null };
  })[];
}

/**
 * Reports → Leaderboard (§8.3, M5).
 *
 * ── VISIBILITY IS THE API'S DECISION, NOT THIS PAGE'S ───────────────────────
 *
 * The owner chooses `hidden`, `own_rank` or `full` (§16's default is
 * `own_rank`). This page renders whatever the API returns and does NOT filter:
 * on `own_rank` a telecaller's response contains exactly one row - their own -
 * and on `hidden` the request 403s. Filtering here instead would mean the
 * whole floor's scores crossed the wire to a browser that was told not to show
 * them, which is not a setting, it is a CSS rule.
 *
 * ── A SUPPRESSED SCORE IS NOT LAST PLACE ────────────────────────────────────
 *
 * Somebody whose composite could not be computed gets no rank and sorts to the
 * bottom WITH THE REASON, rather than being ranked 24th of 24. Ranking them
 * would be a judgement the data does not support - and on a page people read
 * about themselves, that distinction is the whole difference between a fair
 * instrument and an unfair one.
 */
export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/kpi/leaderboard");
  const owner = await requireOwnerRoles([
    "owner",
    "manager",
    "telecaller",
    "sales",
    "marketing",
  ]);

  const sp = await searchParams;
  const zone = await getOrgTimeZone();
  const today = todayIn(zone);
  const parsed = parseDateWindow(sp);
  const window = resolveDateWindow(parsed.window, today);
  const team = typeof sp.team === "string" ? sp.team : undefined;

  const result = await ownerTry<Leaderboard>(
    `/v1/insights/leaderboard?from=${window.from}&to=${window.to}${team ? `&team=${team}` : ""}`,
  );

  const title = owner.membership.ownerRole === "telecaller" ? "My rank" : "Leaderboard";

  if (!result.ok) {
    return (
      <>
        <PageHeader title={title} context="Reports" />
        {/* A 403 here is the owner having switched the leaderboard off, which
            LoadFailure already renders as "you do not have access to this" -
            the honest answer, and better than a bespoke empty state that would
            have to guess why. */}
        <LoadFailure failure={result} what="the leaderboard" />
      </>
    );
  }
  const data = result.data;

  // The KPI columns, taken from the first row that has any - the configured
  // set is the same for everyone, so one row establishes the header.
  const columns = data.rows.find((r) => r.kpis.length > 0)?.kpis.map((k) => k) ?? [];

  return (
    <>
      <PageHeader title={title} context="Reports" />
      <p className="-mt-2 text-sm text-text-muted">
        {data.visibility === "own_rank"
          ? `Where you stand among ${data.total} people this period. Your workspace shows each person their own rank only.`
          : "Everyone ranked by their score against agreed targets."}
      </p>

      <DateRangeBar
        path="/owner/kpi/leaderboard"
        presets={rangePresets("/owner/kpi/leaderboard", parsed.window, { calendar: true })}
        from={data.window.from}
        to={data.window.to}
        today={today}
      />
      <DateRangeSummary from={data.window.from} to={data.window.to} zone={zone} />

      {data.rows.length === 0 ? (
        <EmptyState
          title="No scores in this period"
          description="Either no KPIs are set up, or nothing has arrived for anyone in these dates."
          action={
            <Link
              href="/owner/kpi"
              className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
            >
              Back to performance
            </Link>
          }
        />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="px-3 py-2 font-medium text-text-muted">
                  #
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-text-muted">
                  Person
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
              {data.rows.map((row) => (
                <tr key={row.subject.id ?? row.name} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 tabular-nums text-text-muted">{row.rank ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/owner/kpi/telecaller/${row.subject.id}`}
                      className="text-text underline-offset-2 hover:underline"
                    >
                      {row.name}
                    </Link>
                    {/* Without this the id reads as a person's name, ranked
                        between two real ones. The figures are real, so the row
                        stays - it is the NAME that is missing, not the work. */}
                    {row.unnamed ? (
                      <span className="ml-2 text-xs text-text-muted">unnamed</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-2">
                      <span className="tabular-nums font-medium text-text">
                        {row.composite.score === null
                          ? "—"
                          : `${row.composite.score.toFixed(0)}%`}
                      </span>
                      <BandChip label={row.bandLabel} tone={row.bandTone} />
                    </span>
                    {row.composite.score === null ? (
                      // The reason, on the row, every time. See the header.
                      <p className="mt-0.5 text-xs text-text-muted">
                        {row.composite.reason === "below_coverage_floor"
                          ? `Only ${Math.round(row.composite.coverage * 100)}% measurable`
                          : "No targets set"}
                      </p>
                    ) : null}
                  </td>
                  {row.kpis.map((kpi) => (
                    <td key={kpi.key} className="px-3 py-2 text-right tabular-nums">
                      <span className={kpi.suppressed ? "text-text-muted" : "text-text"}>
                        {formatKpi(kpi.actual, kpi.unit)}
                      </span>
                      {kpi.suppressed ? (
                        <span className="sr-only"> — {kpi.suppressionReason}</span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <MonoLabel>How the score works</MonoLabel>
        <p className="mt-1 text-sm text-text-muted">
          Each KPI is scored as what was achieved against the target agreed for it, capped at 120%,
          then weighted. The result is a score against targets — not a blend of quality measures,
          which would mean averaging numbers that are not comparable. A KPI with too little behind
          it to be worth stating is left out and says so, and a score over less than 60% of the
          configured weight is not shown at all.
        </p>
      </Card>
    </>
  );
}
