import { GoogleCalendarScheduler, type GoogleCalendarConfig } from "./google-calendar";
import { UnavailableScheduler } from "./unavailable";
import { parseClock } from "./zoned-time";
import type { Scheduler } from "./types";

export type { Scheduler, Slot, FunnelSubmission } from "./types";
export { GoogleCalendarScheduler } from "./google-calendar";
export { SlotTakenError } from "./google-calendar";
export { UnavailableScheduler } from "./unavailable";

/* ────────────────────────────────────────────────────────────────────────────
   Env selection — doc 16 §0.4.

   SERVER ONLY. None of these are NEXT_PUBLIC_, and they must never become so:
   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in a client bundle is a full compromise of
   the calendar. `getScheduler()` is called from server components and server
   actions; importing it into a client component is a build error waiting to
   happen and should stay that way.

   Required for the real scheduler — ALL of them, or you get UnavailableScheduler:
     GOOGLE_CALENDAR_ID                      calendar to read and write, e.g.
                                             sales@sirahdigital.in
     GOOGLE_SERVICE_ACCOUNT_EMAIL            ...@...iam.gserviceaccount.com
     GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY      PEM from the service-account JSON.
                                             Literal "\n" sequences are unescaped
                                             below, because that is how the key
                                             survives a .env file.

   Optional:
     GOOGLE_CALENDAR_IMPERSONATE_SUBJECT     Workspace mailbox to act as. Without
                                             it the lead gets NO calendar invite
                                             AND NO MEET LINK is requested — a
                                             bare service account has no Meet
                                             entitlement and Google rejects the
                                             whole insert if one is asked for
                                             (see google-calendar.ts note 4).
     GOOGLE_BUSY_CALENDAR_IDS   Comma-separated calendars consulted for
                                availability but never written to. Needed when
                                GOOGLE_CALENDAR_ID is a calendar the service
                                account owns rather than the team's real one:
                                without it the picker knows only about its own
                                empty calendar and offers times the team is
                                already busy. READ ACCESS IS ENOUGH, which is
                                the point — a domain that refuses to share a
                                calendar for writing will usually still share
                                it for reading.
     SCHEDULER_TIMEZONE      default Asia/Kolkata — the sales team's zone, and
                             the only one the business hours below mean anything
                             in. Not the visitor's and not the server's.
     SCHEDULER_SLOT_MINUTES  default 30
     SCHEDULER_DAY_START     default 10:00   (local to SCHEDULER_TIMEZONE)
     SCHEDULER_DAY_END       default 18:00
     SCHEDULER_WEEKDAYS      default 1,2,3,4,5   (0 = Sunday)
     SCHEDULER_MIN_NOTICE_MINUTES  default 120 — nobody takes a sales call in
                             ten minutes, and offering one is how the picker
                             produces a slot that is technically free and
                             practically fake.
     SCHEDULER_MAX_SLOTS     default 12 — a picker with sixty buttons is not a
                             picker.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * An optional env var, treating EMPTY AS ABSENT.
 *
 * ── THE BUG THIS EXISTS TO KILL ────────────────────────────────────────────
 *
 * docker-compose.prod.yml passes the optional scheduler settings as
 * `${SCHEDULER_DAY_START:-}`, which does not leave the variable unset — it sets
 * it to the EMPTY STRING. `process.env.X ?? "10:00"` then keeps the empty
 * string, because `??` only falls back on null and undefined, and
 * `parseClock("")` throws.
 *
 * getScheduler() catches that throw and returns UnavailableScheduler, so a
 * perfectly good Google configuration was discarded because an unrelated
 * OPTIONAL setting was blank. Every booking then recorded
 * calendar_event_id NULL with calendar_error NULL — the fingerprint of "no
 * calendar configured" — while the credentials were sitting right there and
 * working. Found on 2026-08-10 after three bookings failed to reach Google.
 *
 * `||` would have been enough for the strings, but this is explicit so nobody
 * reintroduces `??` later thinking it is the modern spelling of the same thing.
 * For env vars, where "" is what a shell hands you for "not set", they are not
 * the same thing at all.
 */
function envOr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function readConfig(): GoogleCalendarConfig | { missing: string } {
  const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim();
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  const missing = [
    !calendarId && "GOOGLE_CALENDAR_ID",
    !serviceAccountEmail && "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    !rawKey && "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
  ].filter((x): x is string => typeof x === "string");

  if (missing.length > 0 || !calendarId || !serviceAccountEmail || !rawKey) {
    return { missing: missing.join(", ") };
  }

  const dayStartMinutes = parseClock(envOr("SCHEDULER_DAY_START", "10:00"));
  const dayEndMinutes = parseClock(envOr("SCHEDULER_DAY_END", "18:00"));
  if (dayEndMinutes <= dayStartMinutes) {
    throw new Error("SCHEDULER_DAY_END must be after SCHEDULER_DAY_START");
  }

  const weekdays = envOr("SCHEDULER_WEEKDAYS", "1,2,3,4,5")
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (weekdays.length === 0) throw new Error("SCHEDULER_WEEKDAYS matched no valid day");

  return {
    calendarId,
    serviceAccountEmail,
    // A PEM pasted into a .env keeps its newlines as the two characters \ and n.
    privateKey: rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey,
    impersonateSubject: process.env.GOOGLE_CALENDAR_IMPERSONATE_SUBJECT?.trim() || undefined,
    busyCalendarIds: (process.env.GOOGLE_BUSY_CALENDAR_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    timeZone: process.env.SCHEDULER_TIMEZONE?.trim() || "Asia/Kolkata",
    slotMinutes: positiveInt(process.env.SCHEDULER_SLOT_MINUTES, 30),
    dayStartMinutes,
    dayEndMinutes,
    weekdays,
    minNoticeMinutes: positiveInt(process.env.SCHEDULER_MIN_NOTICE_MINUTES, 120),
    maxSlots: positiveInt(process.env.SCHEDULER_MAX_SLOTS, 12),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

let cached: Scheduler | null = null;

/**
 * The scheduler this deployment actually has.
 *
 * Fails CLOSED in every direction: a missing credential, an unparseable
 * business-hours value, anything at all — you get `UnavailableScheduler`, the
 * qualified path shows the same "our team will reach out" screen the
 * disqualified path shows, and no fake slot ever reaches a page. Doc 16 §0.4
 * says that rule "holds absolutely", so a misconfiguration must degrade to the
 * honest screen rather than throw a 500 into a live lead form.
 *
 * TODAY, IN THIS REPOSITORY, THIS ALWAYS RETURNS `UnavailableScheduler`. No
 * Google credentials exist anywhere in the platform (`.env.production.example`
 * has no GOOGLE_* entry), which is the correct and intended state until the
 * Cloud project is created.
 */
export function getScheduler(): Scheduler {
  if (cached) return cached;

  try {
    const config = readConfig();
    if ("missing" in config) {
      cached = new UnavailableScheduler(`unset: ${config.missing}`);
    } else {
      cached = new GoogleCalendarScheduler(config);
    }
  } catch (err) {
    // Loud in the server log, silent and safe on the page.
    console.error("[scheduler] configuration rejected, falling back to unavailable:", err);
    cached = new UnavailableScheduler("configuration is invalid, see server logs");
  }

  return cached;
}

/** Tests and long-lived dev servers only — module state outlives an env change. */
export function resetSchedulerForTests(): void {
  cached = null;
}

/**
 * The zone slot times must be RENDERED in.
 *
 * The same value the generator uses, read the same way, so a slot cannot be
 * offered at 10:00 and displayed at 04:30. It is the sales team's zone, not the
 * visitor's: showing a Chennai team's 10:00 as the visitor's browser-local time
 * would be friendlier but this is server-rendered with no client JS, and a
 * guessed zone printed with confidence is worse than a correct one printed with
 * its label attached.
 */
export function schedulerTimeZone(): string {
  return process.env.SCHEDULER_TIMEZONE?.trim() || "Asia/Kolkata";
}
