"use client";

import { useMemo, useState, useTransition } from "react";
import { BrutalButton, Input, Select, useAlert, useToast } from "@aura/ui";
import { generateSlotsAction } from "./actions";

/**
 * Bulk generation - a working week of availability in one action.
 *
 * Adding slots one at a time is fine for filling a one-off gap and hopeless for
 * "I am free 10 to 6, Monday to Friday, for the next month", which is what
 * setting up availability actually looks like.
 *
 * THE BUFFER is the other half. Slots step by `duration + buffer`, so a
 * 30-minute call with a 10-minute gap produces 10:00, 10:40, 11:20 and nobody
 * is ever booked back-to-back. Zero is allowed, because back-to-back is a
 * legitimate choice - just not the default.
 *
 * The count below the fields is arithmetic for the operator, NOT a control:
 * every rule is enforced again by the API (92-day range, 600-slot ceiling,
 * dayEnd after dayStart). It exists so that "that will create 240 slots" is
 * visible BEFORE pressing a button that writes 240 rows to production.
 *
 * Its own file rather than another function in slot-calendar.tsx, which was
 * already carrying the month grid, the day list and the single-slot form.
 */
export function Generator({
  timeZone,
  weekdayLabels,
  onDone,
}: {
  timeZone: string;
  weekdayLabels: string[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]); // Mon-Fri
  const [dayStart, setDayStart] = useState("10:00");
  const [dayEnd, setDayEnd] = useState("18:00");
  const [duration, setDuration] = useState(30);
  const [buffer, setBuffer] = useState(10);
  const [pending, start] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  /**
   * The count, or WHY there is no count.
   *
   * This used to return a bare number and the UI said "0 slots per selected day
   * - check the times against the meeting length" for every possible cause.
   * That sent people to look at the wrong field: the commonest way to get zero
   * is entering 4pm as `04:00`, which is four in the MORNING and therefore
   * before a midday start. The window is the problem and the meeting length is
   * innocent, so the message now names whichever thing is actually wrong.
   *
   * The loop mirrors the server's exactly - a slot counts only if the whole
   * meeting fits before the day ends.
   */
  const preview = useMemo((): { count: number; problem?: string } => {
    const mins = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const a = mins(dayStart);
    const b = mins(dayEnd);

    if (b === a) {
      return { count: 0, problem: "Day starts and day ends are the same time." };
    }
    if (b < a) {
      return {
        count: 0,
        problem:
          `Day ends (${dayEnd}) is before day starts (${dayStart}). ` +
          "These are 24-hour times, so 4pm is 16:00 and 6pm is 18:00.",
      };
    }
    if (b - a < duration) {
      return {
        count: 0,
        problem:
          `A ${duration}-minute meeting does not fit between ${dayStart} and ${dayEnd} - ` +
          `that window is ${b - a} minutes.`,
      };
    }

    let n = 0;
    for (let m = a; m + duration <= b; m += duration + buffer) n += 1;
    return { count: n };
  }, [dayStart, dayEnd, duration, buffer]);

  const perDay = preview.count;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 text-xs font-medium text-accent-text underline underline-offset-4"
      >
        Generate slots across multiple days
      </button>
    );
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-text">Generate slots</p>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-text-muted">
          Close
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          Day starts <span className="font-normal text-text-muted">(24-hour)</span>
          <Input
            type="time"
            step={300}
            value={dayStart}
            onChange={(e) => setDayStart(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          Day ends <span className="font-normal text-text-muted">(24-hour)</span>
          <Input type="time" step={300} value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          Meeting length
          <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[15, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          Buffer between
          <Select value={buffer} onChange={(e) => setBuffer(Number(e.target.value))}>
            {[0, 5, 10, 15, 30].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "No buffer" : `${m} minutes`}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <fieldset className="mt-3">
        <legend className="mb-1.5 text-xs font-medium text-text">Days of the week</legend>
        <div className="flex flex-wrap gap-1.5">
          {weekdayLabels.map((w, i) => {
            const on = days.includes(i);
            return (
              <button
                key={w}
                type="button"
                aria-pressed={on}
                onClick={() => setDays((d) => (on ? d.filter((x) => x !== i) : [...d, i]))}
                className={[
                  "h-9 w-11 rounded-md border text-xs font-medium transition-colors",
                  on
                    ? "border-transparent bg-accent text-accent-fg"
                    : "border-border text-text-muted hover:bg-surface-hover",
                ].join(" ")}
              >
                {w}
              </button>
            );
          })}
        </div>
      </fieldset>

      {preview.problem ? (
        // Not `role="alert"`: this fires on every keystroke while someone is
        // typing a time, and a live region announcing a half-typed value on
        // each character is worse than silence. It is a hint next to the fields
        // that caused it, and the Generate button is disabled regardless.
        <p className="mt-3 text-xs font-medium text-warning-text">{preview.problem}</p>
      ) : (
        <p className="mt-3 text-xs text-text-muted">
          {perDay} slot{perDay === 1 ? "" : "s"} per selected day
          {days.length ? ` · ${perDay * days.length} per week` : ""}.
        </p>
      )}

      <BrutalButton
        shadow
        className="mt-3"
        disabled={pending || !from || !to || days.length === 0 || perDay === 0}
        onClick={() =>
          start(async () => {
            const res = await generateSlotsAction({
              fromDate: from,
              toDate: to,
              weekdays: days,
              dayStart,
              dayEnd,
              durationMinutes: duration,
              bufferMinutes: buffer,
              timeZone,
            });
            if (res.error) {
              await alert({
                title: "Couldn't generate the slots",
                body: res.error,
                tone: "danger",
              });
              return;
            }
            // Reports skipped as well as created. Re-running over a range that
            // already has slots is a no-op per row, and a bare "created 0"
            // would read as a failure when it actually means "already done".
            toast(`Created ${res.created}.${res.skipped ? ` ${res.skipped} already existed.` : ""}`);
            onDone();
          })
        }
      >
        {pending ? "Generating…" : "Generate"}
      </BrutalButton>
    </div>
  );
}
