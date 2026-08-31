/**
 * The two IANA-timezone conversions the slot generator needs, built on `Intl`.
 *
 * Why not a date library: doc 10 §9's performance budget, and doc 16 §4's
 * restatement of it. This is server-only code today, but `apps/marketing` has
 * zero client components and a 170 B/route JS footprint, and adding a date
 * library to reach for two functions is how that stops being true. `Intl` is in
 * the platform already and is the same TZDB the library would bundle.
 *
 * Everything here is UTC-instant-in, UTC-instant-out. No local machine time is
 * ever consulted, because the server's `TZ` is a deployment accident and the
 * business hours belong to the sales team, not to the container.
 */

/**
 * The UTC offset, in milliseconds, that `tz` was at the given instant.
 * Positive east of Greenwich (Asia/Kolkata → +19_800_000).
 */
export function offsetMsAt(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // `hour` comes back as 24 rather than 0 for midnight under hour12:false in
  // some ICU versions; normalise before it becomes a one-day error.
  const hour = get("hour") % 24;

  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );

  // Wall-clock-read-as-UTC minus the true instant is exactly the offset.
  return asIfUtc - instant.getTime();
}

/** The calendar date, in `tz`, that an instant falls on. */
export function zonedDateParts(
  instant: Date,
  tz: string,
): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

/**
 * The UTC instant at which the wall clock in `tz` reads the given date+time.
 *
 * Two passes, because the offset depends on the instant and the instant is what
 * we are solving for. Pass one guesses with the offset at the naive timestamp;
 * pass two re-reads the offset at that corrected instant. That converges for
 * every real zone, and the market this ships to (Asia/Kolkata) has no DST at
 * all, so pass two is a no-op there. For a DST zone the residual ambiguity is
 * the hour that repeats or the hour that does not exist at a transition - the
 * generator only ever asks for business hours, which no jurisdiction schedules
 * a transition inside.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = naive - offsetMsAt(new Date(naive), tz);
  const secondPass = naive - offsetMsAt(new Date(firstPass), tz);
  return new Date(secondPass);
}

/** `10:30` → minutes since midnight. Throws on anything else - a malformed
 *  business-hours env var must fail at boot, not silently open the calendar. */
export function parseClock(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Invalid time "${value}", expected HH:MM`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${value}"`);
  return hours * 60 + minutes;
}
