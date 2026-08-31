"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { BrutalButton, Card, Input, MonoLabel, Select } from "@aura/ui";
import { cancelSlotAction, createSlotsAction, listSlotsAction, type Slot } from "./actions";
import { Generator } from "./generator";

/**
 * Slot creation, in the shape the owner asked for: a month grid on the left,
 * the times for the selected day on the right.
 *
 * ── ALL DATE MATHS IS ON THE LOCAL CALENDAR, NEVER ON UTC ───────────────────
 *
 * Every date this component handles is a `YYYY-MM-DD` string plus a `HH:MM`
 * string. It never converts either to a JS Date and back, because
 * `new Date("2026-08-11")` parses as UTC MIDNIGHT - so anywhere west of
 * Greenwich that renders as the 10th, and the operator creates slots on the
 * wrong day. The conversion to an absolute instant happens exactly once, in
 * Postgres, where the zone database lives (see slots.controller.ts).
 *
 * `monthMatrix` therefore does its own arithmetic on (year, month, day) triples
 * rather than incrementing a Date.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Local-calendar YYYY-MM-DD for a (y, m, d) triple. No Date involved. */
function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  // Day 0 of the NEXT month is the last day of this one. This is local-time
  // Date arithmetic on a numeric triple, which is safe - no string parsing.
  return new Date(y, m + 1, 0).getDate();
}

/** Leading blanks then the days, so the grid lines up under the weekday header. */
function monthMatrix(y: number, m: number): Array<number | null> {
  const lead = new Date(y, m, 1).getDay();
  const count = daysInMonth(y, m);
  return [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
}

export function SlotCalendar({ timeZone }: { timeZone: string }) {
  const today = useMemo(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
  }, []);

  const [cursor, setCursor] = useState({ y: today.y, m: today.m });
  const [selected, setSelected] = useState<string>(iso(today.y, today.m, today.d));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // New-slot controls
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(30);

  const monthFrom = iso(cursor.y, cursor.m, 1);
  const monthTo = iso(cursor.y, cursor.m, daysInMonth(cursor.y, cursor.m));

  const refresh = useCallback(() => {
    start(async () => {
      const res = await listSlotsAction(monthFrom, monthTo, timeZone);
      if (res.error) setError(res.error);
      else {
        setError(null);
        setSlots(res.slots ?? []);
      }
    });
  }, [monthFrom, monthTo, timeZone]);

  useEffect(refresh, [refresh]);

  const byDate = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots) {
      const list = map.get(s.local_date) ?? [];
      list.push(s);
      map.set(s.local_date, list);
    }
    return map;
  }, [slots]);

  const daySlots = byDate.get(selected) ?? [];
  const todayIso = iso(today.y, today.m, today.d);

  function shiftMonth(delta: number) {
    setCursor((c) => {
      const m = c.m + delta;
      return { y: c.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
    });
  }

  function addSlot() {
    start(async () => {
      const res = await createSlotsAction({
        date: selected,
        times: [time],
        durationMinutes: duration,
        timeZone,
      });
      if (res.error) setError(res.error);
      else {
        setError(null);
        setNotice(res.created ? `Added ${time}.` : `${time} already exists on this day.`);
        refresh();
      }
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card>
        {/* ── Month navigation ── */}
        <div className="mb-5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
            className="grid h-9 w-9 place-items-center rounded-full border border-border text-text hover:bg-surface-hover"
          >
            ‹
          </button>
          <p className="text-base font-semibold text-text">
            {MONTHS[cursor.m]} {cursor.y}
          </p>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label="Next month"
            className="grid h-9 w-9 place-items-center rounded-full border border-border text-text hover:bg-surface-hover"
          >
            ›
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center">
          {WEEKDAYS.map((w) => (
            <div key={w} className="pb-2 text-xs font-medium text-text-muted">
              {w}
            </div>
          ))}

          {monthMatrix(cursor.y, cursor.m).map((d, i) => {
            if (d === null) return <div key={`b${i}`} />;
            const date = iso(cursor.y, cursor.m, d);
            const count = byDate.get(date)?.length ?? 0;
            const isSel = date === selected;
            const isPast = date < todayIso;
            return (
              <button
                key={date}
                type="button"
                onClick={() => {
                  setSelected(date);
                  setNotice(null);
                }}
                aria-pressed={isSel}
                aria-label={`${date}${count ? `, ${count} slots` : ""}`}
                className={[
                  "relative grid h-11 w-full place-items-center rounded-full text-sm transition-colors",
                  isSel
                    ? "bg-accent font-semibold text-accent-fg"
                    : count
                      ? "bg-accent/10 font-medium text-text hover:bg-accent/20"
                      : isPast
                        ? "text-text-muted/50"
                        : "text-text hover:bg-surface-hover",
                ].join(" ")}
              >
                {d}
                {/* A dot for days that have slots, so availability is visible on
                    the grid without selecting each day in turn. */}
                {count && !isSel ? (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-1.5 h-1 w-1 rounded-full bg-accent"
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        <p className="mt-5 text-xs text-text-muted">
          Time zone <span className="font-medium text-text">{timeZone}</span> · slots are stored as
          absolute instants, so this stays correct across daylight saving.
        </p>

        <Generator timeZone={timeZone} weekdayLabels={WEEKDAYS} onDone={refresh} />
      </Card>

      {/* ── Times for the selected day ── */}
      <Card>
        <MonoLabel>{selected}</MonoLabel>

        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger-text">
            {error}
          </p>
        ) : null}
        {notice ? <p className="mt-3 text-xs text-text-muted">{notice}</p> : null}

        <div className="mt-4 flex flex-col gap-2">
          {daySlots.length === 0 ? (
            <p className="text-sm text-text-muted">No slots on this day yet.</p>
          ) : (
            daySlots.map((s) => (
              <div
                key={s.id}
                className={[
                  "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5",
                  s.status === "booked" ? "border-border bg-bg-subtle" : "border-accent/40",
                ].join(" ")}
              >
                <div className="min-w-0">
                  <p
                    className={`text-sm font-semibold ${s.status === "booked" ? "text-text-muted" : "text-accent-text"}`}
                  >
                    {s.local_time}
                    <span className="ml-2 font-normal text-text-muted">
                      {Math.round(Number(s.duration_minutes))} min
                    </span>
                  </p>
                  {s.status === "booked" ? (
                    <p className="truncate text-xs text-text-muted">
                      Booked{s.booked_name ? ` - ${s.booked_name}` : ""}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await cancelSlotAction(s.id);
                      if (res.error) setError(res.error);
                      else refresh();
                    })
                  }
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-text-muted hover:text-danger-text"
                  // Cancel, not delete: a booked slot carries someone's
                  // expectation, and the row is the only record it existed.
                  aria-label={`Cancel ${s.local_time}`}
                >
                  Cancel
                </button>
              </div>
            ))
          )}
        </div>

        <div className="mt-5 border-t border-border pt-4">
          <p className="mb-2 text-xs font-medium text-text">Add a slot</p>
          <div className="flex gap-2">
            {/* @aura/ui primitives, not hand-rolled inputs. The design system
                already solves the thing that looked wrong here: Select is
                `appearance-none` with its own chevron, so it matches Input and
                the rest of the console instead of rendering the operating
                system's grey menu button beside them. */}
            <Input
              type="time"
              value={time}
              step={300}
              onChange={(e) => setTime(e.target.value)}
              className="min-w-0 flex-1"
              aria-label="Start time"
            />
            <Select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-24"
              aria-label="Duration in minutes"
            >
              {[15, 20, 30, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m}m
                </option>
              ))}
            </Select>
          </div>
          <BrutalButton className="mt-2 w-full justify-center" disabled={pending} onClick={addSlot}>
            {pending ? "Saving…" : "Add slot"}
          </BrutalButton>
        </div>
      </Card>
    </div>
  );
}
