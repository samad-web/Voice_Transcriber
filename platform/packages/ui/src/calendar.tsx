"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";

/*
 * Calendar-date arithmetic, self-contained rather than imported from
 * @aura/shared: this package carries no runtime dependency beyond React (see
 * cx.ts), and a `YYYY-MM-DD` key is cheap enough to shift by hand that pulling
 * in the whole shared package for it would be a worse trade than duplicating
 * five lines. Every function below treats a date key as a plain calendar day -
 * no timezone, no clock - exactly like @aura/shared's own `shiftDateKey`.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function shiftDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 1 (Monday) - 7 (Sunday), ISO weekday. */
function isoWeekday(key: string): number {
  const d = new Date(`${key}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonths(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Same month/day, the target month - clamped so "31 Jan" - 1 month lands on the last day of December, not January 1st via overflow. */
function shiftMonths(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const targetMonth = addMonths(`${y}-${pad(m)}`, delta);
  const [ty, tm] = targetMonth.split("-").map(Number);
  return dateKey(ty, tm, Math.min(d, daysInMonth(targetMonth)));
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Monday-first, matching this app's own weekday convention (@aura/shared's `WEEKDAYS`). */
const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const WEEKDAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/** One of the same chevrons Select draws, rotated - so a prev/next month button reads as the same control language. */
function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className={cx("h-3 w-3", direction === "left" ? "rotate-90" : "-rotate-90")}
      fill="none"
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface CalendarProps {
  /** The range to draw - `null`/`null` when nothing is set yet. */
  from: string | null;
  to: string | null;
  /**
   * Fired on EVERY pick, so the caller always holds what is drawn: the first
   * click is that one day (`from === to`), the second stretches it into a
   * range. `from <= to` always. Committing is the caller's job - an Apply
   * button - so a single day is as easy to choose as a range.
   */
  onChange: (from: string, to: string) => void;
  /** The org's own "today" (`todayIn(zone)` from @aura/shared) - never the browser's. */
  today: string;
  className?: string;
}

/**
 * A month-grid date-RANGE picker, hand-rolled to match the app's own dark
 * theme - a browser's native `<input type="date">` popup cannot be restyled at
 * all, which is the problem this replaces (it looked like a different, unthemed
 * app dropped into the middle of this one).
 *
 * Range selection is two clicks: the first picks one day (reported at once as
 * a one-day range), the second stretches it into a range from that day; a third
 * starts over. Nothing is applied here - the caller shows the pick and commits
 * it with its own button, which is what makes "just today" choosable at all.
 * There is no hover-preview shading of the in-between days while a range is
 * half-picked - a deliberate scope cut, not an oversight.
 *
 * Keyboard follows the WAI-ARIA "grid" pattern with roving tabindex: arrows
 * move by day/week, Home/End jump to the visible week's ends, PageUp/PageDown
 * move by month (Shift+ by year), Enter/Space picks the focused day.
 */
export function Calendar({ from, to, onChange, today, className = "" }: CalendarProps) {
  const [month, setMonth] = useState(() => (from ?? today).slice(0, 7));
  /** The first click of a range still waiting for its second. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focused, setFocused] = useState(() => from ?? today);
  const gridRef = useRef<HTMLDivElement>(null);
  const skipFocusMove = useRef(true);

  // Move real DOM focus to the roving cell after a keyboard move re-renders
  // the grid (a month change needs a render before the new cell exists to
  // focus). Skipped on mount - arriving at the popover should not steal focus
  // into the grid before the reader has touched it.
  useEffect(() => {
    if (skipFocusMove.current) {
      skipFocusMove.current = false;
      return;
    }
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
  }, [focused]);

  function moveTo(key: string) {
    setFocused(key);
    if (key.slice(0, 7) !== month) setMonth(key.slice(0, 7));
  }

  function pick(key: string) {
    if (anchor === null) {
      setAnchor(key);
      onChange(key, key);
      return;
    }
    onChange(key < anchor ? key : anchor, key < anchor ? anchor : key);
    setAnchor(null);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const deltas: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 };
    if (e.key in deltas) {
      e.preventDefault();
      moveTo(shiftDays(focused, deltas[e.key]));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      moveTo(shiftDays(focused, -(isoWeekday(focused) - 1)));
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      moveTo(shiftDays(focused, 7 - isoWeekday(focused)));
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const sign = e.key === "PageUp" ? -1 : 1;
      moveTo(shiftMonths(focused, sign * (e.shiftKey ? 12 : 1)));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(focused);
    }
  }

  const gridStart = shiftDays(`${month}-01`, -(isoWeekday(`${month}-01`) - 1));
  const cells = Array.from({ length: 42 }, (_, i) => shiftDays(gridStart, i));
  const rangeStart = from;
  const rangeEnd = to;

  return (
    <div className={cx("select-none", className)}>
      <div className="flex items-center justify-between px-1 pb-2">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setMonth((m) => addMonths(m, -1))}
          className="rounded-sm p-1.5 text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
        >
          <Chevron direction="left" />
        </button>
        <span className="text-sm font-medium text-text">{monthLabel(month)}</span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setMonth((m) => addMonths(m, 1))}
          className="rounded-sm p-1.5 text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
        >
          <Chevron direction="right" />
        </button>
      </div>

      <div ref={gridRef} role="grid" aria-label={monthLabel(month)}>
        <div role="row" className="grid grid-cols-7">
          {WEEKDAY_LABELS.map((label, i) => (
            <span
              key={label}
              role="columnheader"
              aria-label={WEEKDAY_FULL[i]}
              className="flex h-8 items-center justify-center text-xs text-text-muted"
            >
              {label}
            </span>
          ))}
        </div>

        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} role="row" className="grid grid-cols-7">
            {cells.slice(week * 7, week * 7 + 7).map((key) => {
              const inMonth = key.slice(0, 7) === month;
              const day = Number(key.slice(8, 10));
              const isToday = key === today;
              const isEndpoint = key === rangeStart || key === rangeEnd;
              const isInRange = !!rangeStart && !!rangeEnd && key > rangeStart && key < rangeEnd;

              return (
                <button
                  key={key}
                  type="button"
                  data-date={key}
                  role="gridcell"
                  tabIndex={key === focused ? 0 : -1}
                  aria-selected={isEndpoint || isInRange}
                  aria-label={dayLabel(key)}
                  aria-current={isToday ? "date" : undefined}
                  onClick={() => {
                    moveTo(key);
                    pick(key);
                  }}
                  onKeyDown={onKeyDown}
                  className={cx(
                    "flex h-8 w-8 items-center justify-center text-xs tabular-nums transition-colors duration-150 ease-out",
                    !inMonth && "text-text-subtle",
                    inMonth && !isEndpoint && "text-text hover:bg-surface-hover",
                    isInRange && !isEndpoint && "bg-accent-subtle text-accent-text",
                    isEndpoint && "rounded-full bg-accent font-medium text-accent-fg",
                    isToday && !isEndpoint && "rounded-full font-semibold ring-1 ring-inset ring-border-strong",
                    !isEndpoint && !isInRange && "rounded-full",
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
