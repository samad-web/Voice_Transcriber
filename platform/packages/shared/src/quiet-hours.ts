/**
 * Quiet hours for the outbound message drains.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * Nothing in this platform has ever checked the time of day before sending.
 * `booking_notifications` drains whatever is due whenever the worker wakes, so
 * a nurture message queued 72 hours earlier fires at whatever hour its timer
 * happens to expire — including 03:00, to a stranger's personal WhatsApp,
 * from a business they enquired at once. That is the kind of thing a person
 * blocks the number over, and it is invisible in testing because a test never
 * runs at 3am.
 *
 * ── WHY IT IS NOT A BLANKET GATE ────────────────────────────────────────
 *
 * The obvious implementation — "hold everything until 09:00" — is wrong for
 * this outbox, because not every template is a marketing nudge. A
 * `reminder_call_1h` deferred past the quiet window arrives AFTER the call it
 * was reminding someone about, which is worse than arriving late at night: it
 * is actively misleading. Time-critical templates are therefore exempt, and
 * the exemption is a named list rather than a heuristic so that adding a
 * template forces a decision about which kind it is.
 *
 * Exempt templates barely encounter the window anyway: they are anchored to a
 * booked slot, and slots are business hours by construction.
 *
 * ── EVERY FUNCTION TAKES THE INSTANT EXPLICITLY ─────────────────────────
 *
 * No hidden `new Date()`. The boundaries are the whole behaviour here, and a
 * boundary you cannot test at 20:59 and 21:00 without fake timers is a
 * boundary nobody tests.
 */

/**
 * Templates that send regardless of the hour, because holding them corrupts
 * their meaning rather than merely delaying it.
 *
 * `call_attended` / `call_no_show` are NOT here on purpose: they are courtesy
 * messages after a call, and a thank-you that waits until morning is still a
 * thank-you.
 */
export const QUIET_HOURS_EXEMPT_TEMPLATES: readonly string[] = [
  "reminder_call_1h",
  "reminder_call_5m",
];

export interface QuietHours {
  /** Local hour sending stops, 0-23. */
  startHour: number;
  /** Local hour sending may resume, 0-23. */
  endHour: number;
  /** IANA zone the hours are expressed in — the business's, not the reader's. */
  timeZone: string;
}

/**
 * The local hour-of-day at `instant` in `timeZone`, as minutes since midnight.
 *
 * Uses Intl rather than a fixed offset. B2 Consultants' version of this file
 * hard-codes +05:30 and says so ("IST is a fixed +05:30 with no DST, so this
 * is exact arithmetic") — true for that business, but this platform ships to
 * whoever sets SCHEDULER_TIMEZONE, and a fixed offset would be silently an
 * hour wrong for half the year in any zone that observes DST.
 */
export function localMinutesOfDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Intl renders midnight as "24" in some locales/engines; normalise it.
  return (hour % 24) * 60 + minute;
}

/**
 * Is `instant` inside the quiet window?
 *
 * Two branches because the window normally WRAPS midnight (21:00 → 09:00): a
 * non-wrapping window is a simple between, a wrapping one is "after start OR
 * before end".
 *
 * A zero-width window (start === end) means "nothing is quiet", not
 * "everything is". The alternative reading would freeze every send the moment
 * somebody typed the same number twice, and a messaging system that silently
 * stops is far worse than one that sends when it was asked to.
 */
export function inQuietWindow(instant: Date, quiet: QuietHours): boolean {
  const { startHour, endHour, timeZone } = quiet;
  if (startHour === endHour) return false;
  const start = startHour * 60;
  const end = endHour * 60;
  const now = localMinutesOfDay(instant, timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * The next instant at which the window ends and sending may resume.
 *
 * Returned as an absolute instant so the caller can write it straight into
 * `next_attempt_at` — the outbox already drains on that column, so deferring
 * is a timestamp update and needs no new state anywhere.
 */
export function quietWindowEndsAt(instant: Date, quiet: QuietHours): Date {
  let delta = quiet.endHour * 60 - localMinutesOfDay(instant, quiet.timeZone);
  if (delta <= 0) delta += 24 * 60; // the window ends tomorrow
  return new Date(instant.getTime() + delta * 60_000);
}

/**
 * Should this message be held?
 *
 * The single question the drain asks. Kept here rather than inlined so the
 * exemption rule and the window rule can never drift apart between the two
 * outboxes that need them.
 */
export function shouldHoldForQuietHours(
  template: string,
  instant: Date,
  quiet: QuietHours | null,
): boolean {
  if (!quiet) return false;
  if (QUIET_HOURS_EXEMPT_TEMPLATES.includes(template)) return false;
  return inQuietWindow(instant, quiet);
}

/**
 * Read the window from the environment, or null when it is not configured.
 *
 * Returns null — not a default window — when the vars are absent. Inventing a
 * quiet window for an existing deployment would silently change when its
 * messages go out, which is a policy decision belonging to whoever runs it.
 *
 * Empty-string handling is explicit for the same reason bookingTimeZone()
 * spells it out: compose passes `${VAR:-}`, so an unset variable arrives as ""
 * rather than undefined, and `??` would keep it. That exact mistake disabled
 * Google Calendar on 2026-08-10.
 */
export function quietHoursFromEnv(env: NodeJS.ProcessEnv = process.env): QuietHours | null {
  const rawStart = env.QUIET_HOURS_START?.trim();
  const rawEnd = env.QUIET_HOURS_END?.trim();
  if (!rawStart || !rawEnd) return null;

  const startHour = Number(rawStart);
  const endHour = Number(rawEnd);
  if (!isHour(startHour) || !isHour(endHour)) return null;

  const tz = env.SCHEDULER_TIMEZONE?.trim();
  return { startHour, endHour, timeZone: tz && tz.length > 0 ? tz : "Asia/Kolkata" };
}

function isHour(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 23;
}
