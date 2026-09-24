import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, EmptyState, MonoLabel } from "@aura/ui";
import { DEFAULT_TIME_ZONE, todayIn } from "@aura/shared";
import { DateRangeBar, DateRangeNotice, DateRangeSummary } from "@/components/date-range-bar";
import { PageHeader } from "@/components/page-header";
import {
  DEFAULT_RANGE_DAYS,
  dateWindowHref,
  parseDateWindow,
  rangePresets,
  resolveDateWindow,
} from "@/lib/date-range";
import { getOwner, ownerGet, requireFeature } from "@/lib/owner-context";
import type { ProductivityResponse, TelecallerProductivityRow } from "./types";

export const metadata: Metadata = { title: "Team activity" };

const SORTS = [
  { key: "calls", label: "Calls" },
  { key: "talk", label: "Talk time" },
  { key: "gap", label: "Idle gap" },
  { key: "sop", label: "SOP adherence" },
  { key: "name", label: "Name" },
] as const;

function hhmm(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function mins(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)}m`;
}

function ratio(value: string | number | null): string {
  if (value == null) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";
}

/**
 * How this person compares to the floor's midpoint, as a short clause.
 *
 * Deliberately not a red/green chip. "Below median" on a call count is a fact;
 * a red badge is a verdict, and this page is read in performance
 * conversations. The colour would be doing work the data does not support -
 * a rep with fewer, longer calls is not failing at anything.
 */
function versus(value: number | null, median: number | null, moreIsBetter: boolean): string {
  if (value == null || median == null || median === 0) return "";
  const delta = Math.round(((value - median) / median) * 100);
  if (Math.abs(delta) < 10) return "at median";
  const direction = delta > 0 ? "above" : "below";
  void moreIsBetter;
  return `${Math.abs(delta)}% ${direction} median`;
}

export default async function ProductivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/productivity");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const sp = await searchParams;
  const { window, invalid } = parseDateWindow(sp);
  const sort = String(Array.isArray(sp.sort) ? sp.sort[0] : (sp.sort ?? "calls"));

  // The API takes dates only, and compares them with a `date` the worker
  // derived in the org's zone - so they are the org's dates too, counted from
  // its own today rather than this server's UTC one.
  const zone = owner.membership.reportingTimezone ?? DEFAULT_TIME_ZONE;
  const requested = resolveDateWindow(window, todayIn(zone));
  const data = await ownerGet<ProductivityResponse>(
    `/v1/owner/productivity?${new URLSearchParams({ ...requested, sort })}`,
  );
  const shown = { from: data?.from ?? requested.from, to: data?.to ?? requested.to };

  const rows: TelecallerProductivityRow[] = data?.telecallers ?? [];
  const benchmarks = data?.benchmarks;
  const talkAvailable = data?.talk_metrics_available ?? false;

  return (
    <>
      <PageHeader title="Team activity" context="Reports" />

      {/* Sort stays a plain link, not client state: the API already sorts, so
          shipping JavaScript to re-sort a list the server ordered would be a
          bundle for nothing. The range is the shared control; a new range
          keeps the sort, and a new sort keeps the range. */}
      <DateRangeBar
        path="/owner/productivity"
        presets={rangePresets("/owner/productivity", window, { keep: { sort } })}
        from={shown.from}
        to={shown.to}
        keep={{ sort }}
        today={todayIn(zone)}
      />
      {invalid ? <DateRangeNotice fallbackDays={DEFAULT_RANGE_DAYS} /> : null}
      <DateRangeSummary from={shown.from} to={shown.to} zone={zone} />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <MonoLabel>Sort</MonoLabel>
          {SORTS.map((s) => (
            <Link
              key={s.key}
              href={dateWindowHref("/owner/productivity", window, { keep: { sort: s.key } })}
              aria-current={s.key === sort ? "page" : undefined}
              className={
                s.key === sort
                  ? "rounded-md border border-border bg-bg-subtle px-2.5 py-1 text-sm font-medium text-text"
                  : "rounded-md px-2.5 py-1 text-sm text-text-muted hover:text-text"
              }
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {!talkAvailable && rows.length > 0 && (
        <Card className="space-y-1.5">
          <MonoLabel>Talk time is not being measured</MonoLabel>
          <p className="text-sm leading-relaxed text-text-muted">
            Talk time, talk ratio and interruptions need speaker separation on the recording, which
            is a per-instance setting. Without it the columns below stay empty rather than showing a
            number that would treat the whole call as the agent speaking. Call counts and idle gaps
            are unaffected.
          </p>
        </Card>
      )}

      {!(data?.sop_scoring_available ?? false) && rows.length > 0 && (
        <Card className="space-y-1.5">
          <MonoLabel>No calls scored against an SOP</MonoLabel>
          <p className="text-sm leading-relaxed text-text-muted">
            Either no call procedure is active for this workspace, or none of the calls in this
            range had the speaker separation scoring needs. Define one under SOPs to start scoring
            new calls — existing calls are not scored retroactively.
          </p>
        </Card>
      )}

      {data?.scope === "own" && (
        <Card className="space-y-1.5">
          <MonoLabel>Your own numbers</MonoLabel>
          <p className="text-sm leading-relaxed text-text-muted">
            You are seeing your own row. Comparisons to the team median are not shown, because there
            is nothing here to compare against.
          </p>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No calls in this range"
          description="Once calls are attributed to a telecaller they are rolled up here within fifteen minutes."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="pb-2 pr-4 font-medium text-text-muted">Telecaller</th>
                <th className="pb-2 pr-4 text-right font-medium text-text-muted">Calls</th>
                <th className="pb-2 pr-4 text-right font-medium text-text-muted">Connected</th>
                <th className="pb-2 pr-4 text-right font-medium text-text-muted">On calls</th>
                <th className="pb-2 pr-4 text-right font-medium text-text-muted">Talk time</th>
                <th className="pb-2 pr-4 text-right font-medium text-text-muted">Talk ratio</th>
                <th className="pb-2 pr-4 text-right font-medium text-text-muted">Median gap</th>
                <th className="pb-2 pr-4 text-right font-medium text-text-muted">SOP</th>
                <th className="pb-2 text-right font-medium text-text-muted">Days active</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((r) => {
                const callsVs = versus(r.calls_total, benchmarks?.calls_total ?? null, true);
                const gapVs = versus(
                  r.median_gap_seconds,
                  benchmarks?.median_gap_seconds ?? null,
                  false,
                );
                return (
                  <tr key={r.telecaller_id} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pr-4">
                      <span className="font-medium text-text">{r.display_name}</span>
                      {r.status !== "active" && (
                        <span className="ml-2 text-xs text-text-muted">archived</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className="text-text">{r.calls_total}</span>
                      {callsVs && data?.scope !== "own" && (
                        <span className="block text-xs text-text-muted">{callsVs}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-right text-text">{r.calls_connected}</td>
                    <td className="py-2.5 pr-4 text-right text-text">
                      {hhmm(r.total_call_seconds)}
                    </td>
                    {/* The two columns that need diarization. Null renders as a
                        dash, and the card above explains why - never as 0. */}
                    <td className="py-2.5 pr-4 text-right">
                      <span className="text-text">{hhmm(r.agent_talk_seconds)}</span>
                      {r.talk_sample_calls > 0 && r.talk_sample_calls < r.calls_total && (
                        <span className="block text-xs text-text-muted">
                          from {r.talk_sample_calls} of {r.calls_total}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-right text-text">{ratio(r.mean_talk_ratio)}</td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className="text-text">{mins(r.median_gap_seconds)}</span>
                      {gapVs && data?.scope !== "own" && (
                        <span className="block text-xs text-text-muted">{gapVs}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className="text-text">
                        {r.mean_adherence_pct == null ? "—" : `${r.mean_adherence_pct}%`}
                      </span>
                      {r.sop_scored_calls > 0 && (
                        <span className="block text-xs text-text-muted">
                          {r.sop_scored_calls} scored
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right text-text">{r.active_days}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="space-y-1.5">
        <MonoLabel>How to read this</MonoLabel>
        <ul className="space-y-1.5 text-sm leading-relaxed text-text-muted">
          <li>
            <span className="text-text">Median gap</span> is the typical idle time between one call
            ending and the next starting, on a working day. It is a median so a lunch break does not
            read as idleness on every call.
          </li>
          <li>
            <span className="text-text">On calls</span> is total connected duration.{" "}
            <span className="text-text">Talk time</span> is how much of that was this person
            speaking rather than listening.
          </li>
          <li>
            <span className="text-text">SOP</span> is the share of your call procedure&apos;s
            required steps the agent was observed following. Steps the recording could not settle
            are left out of the score rather than counted as misses.
          </li>
          <li>
            An em dash means the number was not measured, not that it was zero. Nothing here is
            estimated.
          </li>
        </ul>
      </Card>
    </>
  );
}
