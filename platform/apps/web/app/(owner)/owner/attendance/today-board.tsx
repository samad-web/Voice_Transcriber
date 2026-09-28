"use client";

import { useState } from "react";
import { Card, EmptyState, StateChip, StatusChip } from "@aura/ui";
import { formatTime } from "@aura/shared";
import { Time } from "@/components/org-time";
import { flagLabel, hmm, liveStateLabel, liveStateTone, type TodayRow } from "@/lib/attendance";
import { DayDrawer, type DayTarget } from "./day-drawer";

/**
 * The live board (doc 33 §7.1): one row per telecaller, their state now, and
 * today's totals so far. Server-rendered props; the realtime provider's
 * `router.refresh()` on the `attendance` topic re-renders it as phones report,
 * so this component holds nothing but which row is open.
 */
export function TodayBoard({
  rows,
  date,
  zone,
  canOverride,
  own,
}: {
  rows: TodayRow[];
  date: string;
  zone: string;
  canOverride: boolean;
  /** A telecaller looking at their own row. */
  own: boolean;
}) {
  const [open, setOpen] = useState<DayTarget | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState
        title={own ? "No schedule for you yet" : "No telecallers on the board"}
        description={
          own
            ? "Once a shift pattern is assigned to you, today's timeline shows here."
            : "Telecallers appear here once a phone is paired for them and a shift pattern is assigned in Attendance settings."
        }
      />
    );
  }

  return (
    <>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[62rem] text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-subtle text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Telecaller</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Now</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Shift</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Worked</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Break</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Technical</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Away</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Flags</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Phone</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted">Requests</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr
                key={r.telecallerId}
                onClick={() => setOpen({ telecallerId: r.telecallerId, name: r.name, date })}
                className="cursor-pointer border-b border-border/60 align-top last:border-0 hover:bg-surface-hover"
              >
                <td className="px-4 py-3">
                  {/* A real button for keyboard and screen-reader users; the
                      row's click is the pointer shortcut to the same thing. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen({ telecallerId: r.telecallerId, name: r.name, date });
                    }}
                    className="text-left font-medium text-text hover:underline"
                  >
                    {r.name}
                  </button>
                </td>
                <td className="px-3 py-3">
                  <StateChip state={liveStateTone(r.liveState)}>{liveStateLabel(r.liveState)}</StateChip>
                  {r.stateSince ? (
                    <span className="mt-1 block text-xs text-text-muted">
                      since <Time iso={r.stateSince} mode="time" />
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-text-muted">
                  {r.shiftStart && r.shiftEnd
                    ? `${formatTime(r.shiftStart, zone)} - ${formatTime(r.shiftEnd, zone)}`
                    : r.dayKind === "holiday"
                      ? "Holiday"
                      : r.dayKind === "leave"
                        ? "On leave"
                        : "No shift today"}
                </td>
                <td className="px-3 py-3 text-right text-text">{hmm(r.workedSeconds)}</td>
                <td className="px-3 py-3 text-right text-text">{hmm(r.breakSeconds)}</td>
                <td className="px-3 py-3 text-right text-text">{hmm(r.technicalSeconds)}</td>
                <td className="px-3 py-3 text-right text-text">{hmm(r.awaySeconds)}</td>
                <td className="px-3 py-3">
                  {r.flags && r.flags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {r.flags.map((f) => (
                        <StatusChip key={f} tone="outline">
                          {flagLabel(f)}
                        </StatusChip>
                      ))}
                    </div>
                  ) : (
                    <span className="text-text-muted">-</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right text-text-muted">
                  {r.batteryPct !== null ? `${r.batteryPct}%` : "-"}
                  {r.networkOk === false ? <span className="block text-xs">no network</span> : null}
                </td>
                <td className="px-4 py-3 text-right">
                  {r.pendingRequests ? (
                    <StatusChip tone="muted">{r.pendingRequests} pending</StatusChip>
                  ) : (
                    <span className="text-text-muted">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <DayDrawer target={open} zone={zone} canOverride={canOverride} onClose={() => setOpen(null)} />
    </>
  );
}
