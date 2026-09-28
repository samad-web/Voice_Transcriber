"use client";

import { useState } from "react";
import { Card, EmptyState, StateChip, StatusChip } from "@aura/ui";
import { formatDateKey, formatTime, weekdayOfDateKey } from "@aura/shared";
import { dayStatusLabel, dayStatusTone, flagLabel, hmm, type TimesheetRow } from "@/lib/attendance";
import { DayDrawer, type DayTarget } from "./day-drawer";

/** Per telecaller per day (doc 33 §7.1); a row opens that day's timeline. */
export function TimesheetTable({
  rows,
  zone,
  canOverride,
  showName,
}: {
  rows: TimesheetRow[];
  zone: string;
  canOverride: boolean;
  showName: boolean;
}) {
  const [open, setOpen] = useState<DayTarget | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No timesheet days in this range"
        description="Days appear once somebody on a shift pattern has a working day in the range."
      />
    );
  }

  const openRow = (r: TimesheetRow) => setOpen({ telecallerId: r.telecallerId, name: r.name, date: r.workDate });

  return (
    <>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[64rem] text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-subtle text-left">
              {showName ? <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Telecaller</th> : null}
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Date</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Status</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">In</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Out</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Worked</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Breaks taken / booked</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Technical</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Away</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Late</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Overtime</th>
              <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Flags</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr
                key={`${r.telecallerId}:${r.workDate}`}
                onClick={() => openRow(r)}
                className="cursor-pointer border-b border-border/60 align-top last:border-0 hover:bg-surface-hover"
              >
                {showName ? <td className="px-4 py-2.5 font-medium text-text">{r.name}</td> : null}
                <td className="px-3 py-2.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRow(r);
                    }}
                    className="text-left text-text hover:underline"
                    aria-label={`Open ${r.name}'s day, ${formatDateKey(r.workDate)}`}
                  >
                    {weekdayOfDateKey(r.workDate)} {formatDateKey(r.workDate, { year: false })}
                  </button>
                </td>
                <td className="px-3 py-2.5">
                  <StateChip state={dayStatusTone(r.status)}>{dayStatusLabel(r.status)}</StateChip>
                </td>
                <td className="px-3 py-2.5 text-text">{r.checkInAt ? formatTime(r.checkInAt, zone) : "-"}</td>
                <td className="px-3 py-2.5 text-text">{r.checkOutAt ? formatTime(r.checkOutAt, zone) : "-"}</td>
                <td className="px-3 py-2.5 text-right text-text">{hmm(r.workedSeconds)}</td>
                <td className="px-3 py-2.5 text-right text-text">
                  {hmm(r.breakSeconds)} <span className="text-text-muted">/ {hmm(r.bookedBreakSeconds)}</span>
                </td>
                <td className="px-3 py-2.5 text-right text-text">{hmm(r.technicalSeconds)}</td>
                <td className="px-3 py-2.5 text-right text-text">{hmm(r.awaySeconds)}</td>
                <td className="px-3 py-2.5 text-right text-text">{r.lateSeconds ? hmm(r.lateSeconds) : "-"}</td>
                <td className="px-3 py-2.5 text-right text-text">{r.overtimeSeconds ? hmm(r.overtimeSeconds) : "-"}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {r.reviewCount ? <StatusChip tone="muted">{r.reviewCount} to review</StatusChip> : null}
                    {(r.flags ?? []).map((f) => (
                      <StatusChip key={f} tone="outline">
                        {flagLabel(f)}
                      </StatusChip>
                    ))}
                    {!r.reviewCount && !(r.flags ?? []).length ? <span className="text-text-muted">-</span> : null}
                  </div>
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
