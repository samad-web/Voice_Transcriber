import { shiftDateKey } from "@aura/shared";
import { parseDateWindow, type RangePreset } from "@/lib/date-range";

/**
 * The Booked calls list's period - the shared date control (lib/date-range.ts)
 * with one difference: a diary looks FORWARD. So besides "Last N days" (the
 * calls to mark as attended or missed) it has "Next N days" (who is coming),
 * and the default is the next fortnight, as it always was.
 *
 *   (nothing)                        the next 14 days
 *   ?next=N                          the next N days, today included
 *   ?days=N                          the last N days, today included
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   exactly those days
 *
 * Every window resolves to calendar DATES in the scheduler's zone before it
 * reaches the API, so the list and the dates printed over it are the same days.
 * "Today" is the scheduler zone's today (`todayIn(timeZone)`), not the server's.
 */

export type BookingWindow =
  | { kind: "next"; days: number }
  | { kind: "last"; days: number }
  | { kind: "fixed"; from: string; to: string };

export const DEFAULT_BOOKING_WINDOW: BookingWindow = { kind: "next", days: 14 };

const PRESETS: readonly BookingWindow[] = [
  { kind: "next", days: 7 },
  { kind: "next", days: 14 },
  { kind: "next", days: 30 },
  { kind: "last", days: 7 },
  { kind: "last", days: 30 },
];

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseBookingWindow(sp: SearchParams): { window: BookingWindow; invalid: boolean } {
  const next = first(sp.next);
  if (next !== undefined && next !== "" && !first(sp.from) && !first(sp.to)) {
    const days = Number(next);
    return Number.isInteger(days) && days >= 1 && days <= 365
      ? { window: { kind: "next", days }, invalid: false }
      : { window: DEFAULT_BOOKING_WINDOW, invalid: true };
  }
  if (first(sp.days) === undefined && !first(sp.from) && !first(sp.to)) {
    return { window: DEFAULT_BOOKING_WINDOW, invalid: false };
  }
  // `days` and `from`/`to` read exactly as every other report reads them.
  const parsed = parseDateWindow(sp, { maxDays: 366 });
  if (parsed.invalid) return { window: DEFAULT_BOOKING_WINDOW, invalid: true };
  return {
    window: parsed.window.kind === "fixed" ? parsed.window : { kind: "last", days: parsed.window.days },
    invalid: false,
  };
}

/** The window as the dates the API is sent, counted from the scheduler zone's today. */
export function bookingRange(window: BookingWindow, today: string): { from: string; to: string } {
  if (window.kind === "fixed") return { from: window.from, to: window.to };
  if (window.kind === "next") return { from: today, to: shiftDateKey(today, window.days - 1) };
  return { from: shiftDateKey(today, -(window.days - 1)), to: today };
}

function same(a: BookingWindow, b: BookingWindow): boolean {
  if (a.kind === "fixed" || b.kind === "fixed") return false;
  return a.kind === b.kind && a.days === b.days;
}

function href(window: BookingWindow): string {
  if (same(window, DEFAULT_BOOKING_WINDOW)) return "/slots";
  if (window.kind === "next") return `/slots?next=${window.days}`;
  if (window.kind === "last") return `/slots?days=${window.days}`;
  return `/slots?from=${window.from}&to=${window.to}`;
}

/** The pills, upcoming first - "who is coming" is what this page is opened for. */
export function bookingPresets(window: BookingWindow): RangePreset[] {
  return PRESETS.map((p) => ({
    key: `${p.kind}-${p.kind === "fixed" ? "" : p.days}`,
    label: p.kind === "next" ? `Next ${p.days} days` : `Last ${p.kind === "last" ? p.days : 0} days`,
    href: href(p),
    active: same(window, p),
  }));
}
