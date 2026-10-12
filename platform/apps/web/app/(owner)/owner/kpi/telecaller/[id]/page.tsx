import type { Metadata } from "next";
import Link from "next/link";
import { Card, MonoLabel, Sparkline } from "@aura/ui";
import { todayIn, weekdayName } from "@aura/shared";
import { DateRangeBar, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { parseDateWindow, rangePresets, resolveDateWindow } from "@/lib/date-range";
import { getOrgTimeZone } from "@/lib/org-time";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { CompositeCard, KpiCard, type SummaryView } from "../../kpi-cards";

export const metadata: Metadata = { title: "Telecaller performance" };

interface Drilldown {
  window: { from: string; to: string };
  clampedTo: string | null;
  telecaller: { id: string; display_name: string; team: string | null };
  summary: SummaryView;
  stats: {
    calls: number;
    avgDurationSec: number | null;
    medianDurationSec: number | null;
    p90DurationSec: number | null;
    avgTalkSec: number | null;
    medianTalkSec: number | null;
    p90TalkSec: number | null;
  };
  byHour: { hour: number; count: number }[];
  byWeekday: { weekday: number; count: number }[];
  trend: { kpiKey: string; day: string; numerator: number; denominator: number | null }[];
  dispositions: { disposition: string; count: number }[];
}

/**
 * One person's numbers (§8.3's drill-down, M5).
 *
 * ── THE MEDIANS ARE NOT KPIs, AND THAT IS WHY THEY ARE HERE ─────────────────
 *
 * §8.3 asks for "median and 90th percentile for durations and time-to-
 * conversion, not just averages". They are computed from the facts for this
 * one person and this one window, not read from a snapshot - because a
 * percentile is not additive over days and so cannot be stored daily and
 * summed. `kpi-catalog.ts`'s header has the full argument.
 *
 * They are therefore STATISTICS rather than KPIs: nobody's score depends on
 * them, which is exactly what makes it safe not to have them summable.
 *
 * ── A TELECALLER MAY OPEN THIS PAGE, FOR THEMSELVES ─────────────────────────
 *
 * The API refuses a telecaller any id but their own. That check is not here,
 * deliberately: a route is the product and a page is a courtesy, and the one
 * that matters has to be the one a bookmark hits.
 */
export default async function TelecallerPerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/kpi/leaderboard");
  await requireOwnerRoles(["owner", "manager", "telecaller", "sales", "marketing"]);

  const { id } = await params;
  const sp = await searchParams;
  const zone = await getOrgTimeZone();
  const today = todayIn(zone);
  const parsed = parseDateWindow(sp);
  const window = resolveDateWindow(parsed.window, today);

  const result = await ownerTry<Drilldown>(
    `/v1/insights/telecallers/${id}?from=${window.from}&to=${window.to}`,
  );
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Telecaller performance" context="Reports" />
        <LoadFailure failure={result} what="this person's performance" />
      </>
    );
  }
  const data = result.data;
  const path = `/owner/kpi/telecaller/${id}`;

  // One sparkline per KPI, from the per-day series. Rates are plotted as the
  // day's own rate; a count as the count. Both are honest at day grain - it is
  // only SUMMING stored rates across days that is wrong.
  const series = new Map<string, number[]>();
  for (const point of data.trend) {
    const list = series.get(point.kpiKey) ?? [];
    list.push(
      point.denominator && point.denominator > 0
        ? point.numerator / point.denominator
        : point.numerator,
    );
    series.set(point.kpiKey, list);
  }

  const busiestHour = data.byHour.reduce(
    (best, h) => (h.count > (best?.count ?? -1) ? h : best),
    null as { hour: number; count: number } | null,
  );

  return (
    <>
      <PageHeader
        title={data.telecaller.display_name}
        context={data.telecaller.team ? `Reports · ${data.telecaller.team}` : "Reports"}
        actions={
          <Link
            href="/owner/kpi/leaderboard"
            className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
          >
            Leaderboard
          </Link>
        }
      />

      <DateRangeBar
        path={path}
        presets={rangePresets(path, parsed.window, { calendar: true })}
        from={data.window.from}
        to={data.window.to}
        today={today}
      />
      <DateRangeSummary from={data.window.from} to={data.window.to} zone={zone} />

      <div className="grid gap-6 lg:grid-cols-3">
        <CompositeCard summary={data.summary} title="Score" />
        <Card>
          <MonoLabel>Call lengths</MonoLabel>
          {/* Median AND 90th percentile, because an average hides both the
              quick hangups and the long ones - and a floor's coaching
              conversation is usually about one or the other. */}
          <dl className="mt-2 space-y-1 text-sm">
            <Row label="Calls" value={data.stats.calls.toLocaleString("en-IN")} />
            <Row label="Median" value={secs(data.stats.medianDurationSec)} />
            <Row label="90th percentile" value={secs(data.stats.p90DurationSec)} />
            <Row label="Average" value={secs(data.stats.avgDurationSec)} />
          </dl>
        </Card>
        <Card>
          <MonoLabel>Talk time</MonoLabel>
          <dl className="mt-2 space-y-1 text-sm">
            <Row label="Median" value={secs(data.stats.medianTalkSec)} />
            <Row label="90th percentile" value={secs(data.stats.p90TalkSec)} />
            <Row label="Average" value={secs(data.stats.avgTalkSec)} />
          </dl>
          {data.stats.medianTalkSec === null ? (
            <p className="mt-2 text-xs text-text-muted">
              No talk time sent for these calls. It is never inferred from duration — a ten-minute
              call on hold has ten minutes of duration and no conversation.
            </p>
          ) : null}
        </Card>
      </div>

      <section className="space-y-3">
        <MonoLabel>KPIs</MonoLabel>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.summary.kpis.map((kpi) => (
            <div key={kpi.key} className="space-y-1">
              <KpiCard kpi={kpi} />
              {(series.get(kpi.key)?.length ?? 0) > 1 ? (
                <Sparkline values={series.get(kpi.key) as number[]} />
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <MonoLabel>When they call</MonoLabel>
          {data.byHour.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">No calls in this period.</p>
          ) : (
            <>
              <ul className="mt-3 flex items-end gap-1" aria-label="Calls by hour of day">
                {Array.from({ length: 24 }, (_, hour) => {
                  const found = data.byHour.find((h) => h.hour === hour);
                  const max = Math.max(...data.byHour.map((h) => h.count), 1);
                  const height = found ? Math.max(2, (found.count / max) * 56) : 2;
                  return (
                    <li key={hour} className="flex-1">
                      <div
                        className="w-full rounded-sm bg-accent-soft"
                        style={{ height: `${height}px` }}
                        title={`${hour}:00 — ${found?.count ?? 0} calls`}
                      />
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-text-muted">
                Midnight to 11pm in your workspace&rsquo;s own timezone.
                {busiestHour
                  ? ` Busiest hour: ${String(busiestHour.hour).padStart(2, "0")}:00.`
                  : ""}
              </p>
            </>
          )}
        </Card>

        <Card>
          <MonoLabel>Which days</MonoLabel>
          {data.byWeekday.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">No calls in this period.</p>
          ) : (
            <dl className="mt-2 space-y-1 text-sm">
              {data.byWeekday.map((d) => (
                <Row
                  key={d.weekday}
                  label={weekdayName(d.weekday)}
                  value={d.count.toLocaleString("en-IN")}
                />
              ))}
            </dl>
          )}
        </Card>
      </div>

      {data.dispositions.length > 0 ? (
        <Card>
          <MonoLabel>Outcomes</MonoLabel>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {data.dispositions.map((d) => (
              <li
                key={d.disposition}
                className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-muted"
              >
                {d.disposition}
                <span className="ml-1.5 tabular-nums text-text">{d.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className="tabular-nums text-text">{value}</dd>
    </div>
  );
}

/** `null` is an em dash, never "0s" — a person with no calls has no median. */
function secs(value: number | null): string {
  if (value === null) return "—";
  const total = Math.round(value);
  if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${total}s`;
}
