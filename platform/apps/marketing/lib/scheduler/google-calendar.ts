import { createSign } from "node:crypto";
import type { FunnelSubmission, Scheduler, Slot } from "./types";
import { zonedDateParts, zonedTimeToUtc } from "./zoned-time";

/* ════════════════════════════════════════════════════════════════════════════
   ⚠️  UNVERIFIED — READ THIS BEFORE TRUSTING ANY OF IT.

   This talks to a Google Cloud project that does not exist yet (doc 16 §0.4:
   the Calendar API and an OAuth consent screen are an external dependency we do
   not have). Nothing below has ever been run against Google. It is written from
   the Calendar v3 and OAuth 2.0 service-account documentation and it typechecks,
   which is a very long way from working.

   It is deliberately NOT the default: `getScheduler()` returns
   `UnavailableScheduler` unless every credential is present, so an untested
   code path cannot reach a live visitor by accident.

   ── What has to be true before flipping this on ──────────────────────────────

   1. A Google Cloud project with the Calendar API enabled.
   2. A service account, with a JSON key, in that project.
   3. The target calendar SHARED with the service account's email, granted
      "Make changes to events".
   4. Attendee invites: a bare service account CANNOT invite attendees. Google
      rejects `events.insert` with attendees unless the account has domain-wide
      delegation. So either
        (a) enable domain-wide delegation for the service account in Workspace
            admin, scope `https://www.googleapis.com/auth/calendar`, and set
            GOOGLE_CALENDAR_IMPERSONATE_SUBJECT to a real human mailbox in the
            domain — then the lead receives a genuine calendar invite; or
        (b) leave it unset, in which case ATTENDEES ARE OMITTED ENTIRELY and the
            lead gets no invite. The event still lands on the team calendar with
            the lead's details in the body. This module picks (b) automatically
            rather than letting the whole booking fail, but it is a materially
            worse experience and someone must decide which one ships.
   5. A first manual run: one `availableSlots` against the real calendar and one
      `book` that is then inspected in the Google Calendar UI. Until that has
      happened, treat every line here as a hypothesis.

   Verify in that order. The most likely failure is (3) — a service account can
   authenticate perfectly and still 404 on a calendar nobody shared with it.
   ════════════════════════════════════════════════════════════════════════════ */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";

export type GoogleCalendarConfig = {
  calendarId: string;
  serviceAccountEmail: string;
  /** PEM private key from the service-account JSON. */
  privateKey: string;
  /** Workspace mailbox to impersonate. Required for attendee invites — see (4). */
  impersonateSubject?: string;
  /**
   * Extra calendars consulted for free/busy but never written to. Lets the
   * team's real calendar govern availability when bookings have to be written
   * somewhere else. Read access is enough.
   */
  busyCalendarIds?: string[];
  /** IANA zone the business hours are expressed in. */
  timeZone: string;
  slotMinutes: number;
  /** Minutes since midnight, local to `timeZone`. */
  dayStartMinutes: number;
  dayEndMinutes: number;
  /** 0 = Sunday. Days the team takes calls. */
  weekdays: number[];
  /** Never offer a slot sooner than this — nobody can take a call in 5 minutes. */
  minNoticeMinutes: number;
  /** Cap on how many slots the picker is handed. */
  maxSlots: number;
};

type BusyInterval = { start: number; end: number };

export class GoogleCalendarScheduler implements Scheduler {
  readonly configured = true;

  /** Access tokens live an hour; minting one per request would triple the
   *  latency of a page the visitor is already waiting on. Module-scoped cache,
   *  refreshed a minute early to cover clock skew and flight time. */
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(private readonly config: GoogleCalendarConfig) {}

  async availableSlots(from: Date, to: Date): Promise<Slot[]> {
    const now = Date.now();
    const windowStart = Math.max(from.getTime(), now + this.config.minNoticeMinutes * 60_000);
    if (windowStart >= to.getTime()) return [];

    const busy = await this.freeBusy(new Date(windowStart), to);
    const candidates = this.candidateSlots(new Date(windowStart), to);

    // A candidate survives only if it overlaps NOTHING busy. Half-open
    // comparison ([start, end)) so a slot that begins exactly when a meeting
    // ends is still offered — back-to-back is normal, overlapping is not.
    return candidates
      .filter((slot) => {
        const s = slot.start.getTime();
        const e = slot.end.getTime();
        return !busy.some((b) => s < b.end && e > b.start);
      })
      .slice(0, this.config.maxSlots);
  }

  async book(
    slot: Slot,
    submission: FunnelSubmission,
  ): Promise<{ eventId: string; meetingUrl?: string | null }> {
    /**
     * Re-check free/busy immediately before inserting.
     *
     * Calendar v3 has no conditional insert and no ETag precondition on create,
     * so two visitors who load the picker at the same moment CAN both book the
     * same slot. This narrows that window from "however long the picker was on
     * screen" to one round trip. It does not close it. If double-booking ever
     * matters more than it does at this volume, the fix is a uniqueness
     * constraint on `funnel_submissions.booking_slot` in our own database —
     * which is Dev C's table, not this module's call to make.
     */
    const busy = await this.freeBusy(slot.start, slot.end);
    const s = slot.start.getTime();
    const e = slot.end.getTime();
    if (busy.some((b) => s < b.end && e > b.start)) {
      throw new SlotTakenError("That time was booked while you were choosing.");
    }

    const attendees = this.config.impersonateSubject
      ? [{ email: submission.email, displayName: submission.name, responseStatus: "needsAction" }]
      : undefined;

    /**
     * A Meet link is only requested when we are acting as a real Workspace
     * mailbox, because only a real mailbox can mint one.
     *
     * VERIFIED AGAINST GOOGLE, 2026-08-09. A bare service account creating an
     * event on its own calendar with `conferenceSolutionKey: hangoutsMeet` is
     * rejected outright:
     *
     *     400  "Invalid conference type value."
     *
     * That is a hard failure of the whole insert, not a missing link on an
     * otherwise good event — so sending it unconditionally would turn EVERY
     * booking into an error for any deployment without domain-wide delegation.
     * The service account has no Meet entitlement; there is nothing to
     * configure that changes this short of delegation.
     */
    const wantsMeet = Boolean(this.config.impersonateSubject);

    const body = {
      summary: `Aura intro call, ${submission.name}`,
      description: [
        `Booked from the Aura funnel.`,
        ``,
        `Name:     ${submission.name}`,
        `Email:    ${submission.email}`,
        `Phone:    ${submission.phone_e164}`,
        submission.business_type ? `Business: ${submission.business_type}` : null,
        submission.team_size ? `Team:     ${submission.team_size}` : null,
        submission.crm_name ? `CRM:      ${submission.crm_name}` : null,
        ``,
        `Submission: ${submission.id}`,
      ]
        .filter((line) => line !== null)
        .join("\n"),
      start: { dateTime: slot.start.toISOString(), timeZone: this.config.timeZone },
      end: { dateTime: slot.end.toISOString(), timeZone: this.config.timeZone },
      ...(attendees ? { attendees } : {}),
      // Ask Google to mint a Meet link for this event.
      //
      // `createRequest` is the only way to get one: a Meet URL cannot be
      // constructed or guessed, and setting `hangoutLink` directly is ignored.
      // The requestId is idempotency — repeating it returns the SAME conference
      // rather than creating a second one, which matters because this event id
      // is itself a dedupe key and a retry must not produce two links for one
      // meeting.
      ...(wantsMeet
        ? {
            conferenceData: {
              createRequest: {
                requestId: eventIdFor(submission.id, slot.start),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : {}),
      // Google's own dedupe key. If our retry logic ever re-sends the same
      // booking, this makes the second insert a 409 rather than a duplicate
      // meeting. Must be base32hex-ish and 5-1024 chars; the submission id with
      // the hyphens stripped satisfies that.
      id: eventIdFor(submission.id, slot.start),
    };

    // `conferenceDataVersion=1` is REQUIRED whenever a conference is requested.
    // Without it Google silently drops the conferenceData block and returns a
    // perfectly valid event with no Meet link — the failure that looks like the
    // feature simply not working.
    const params = new URLSearchParams();
    if (wantsMeet) params.set("conferenceDataVersion", "1");
    if (attendees) params.set("sendUpdates", "all");

    type EventResponse = {
      id?: string;
      hangoutLink?: string;
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
    };

    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(this.config.calendarId)}/events?${params}`;

    let res: EventResponse;
    try {
      res = await this.fetchJson<EventResponse>(url, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (err) {
      /**
       * Last resort: if Google rejected the CONFERENCE rather than the event,
       * book the meeting without a video link instead of losing it.
       *
       * The guard above already prevents the known case, but Meet availability
       * depends on the acting mailbox's licence, which can be changed in the
       * Workspace admin console long after this is configured and without
       * anyone touching this repository. A booking that has already been
       * confirmed to a person must not fail over a video URL, so this trades
       * the link for the meeting — and only when the error names the
       * conference, so a genuine failure still surfaces.
       */
      const message = err instanceof Error ? err.message : String(err);
      if (!wantsMeet || !/conference/i.test(message)) throw err;

      const { conferenceData: _dropped, ...withoutConference } = body as typeof body & {
        conferenceData?: unknown;
      };
      const retryParams = new URLSearchParams();
      if (attendees) retryParams.set("sendUpdates", "all");

      res = await this.fetchJson<EventResponse>(
        `${CALENDAR_API}/calendars/${encodeURIComponent(this.config.calendarId)}/events?${retryParams}`,
        { method: "POST", body: JSON.stringify(withoutConference) },
      );
    }

    if (!res.id) {
      // Never fabricate an id: the caller's success path renders a confirmation
      // to a human who will then show up.
      throw new Error("Calendar accepted the insert but returned no event id");
    }

    // `hangoutLink` is the convenient field but is not always populated on the
    // insert response, so the entryPoints array is the fallback. A missing link
    // is NOT an error: the meeting is real and in the calendar either way, and
    // failing the booking over a video URL would be the tail wagging the dog.
    const entry = res.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video");
    const meetingUrl = res.hangoutLink ?? entry?.uri ?? null;

    return { eventId: res.id, meetingUrl };
  }

  /* ── Google plumbing ─────────────────────────────────────────────────── */

  /**
   * Busy intervals across the booking calendar AND every extra calendar the
   * deployment names.
   *
   * Why extras exist: where the domain forbids sharing a real calendar with
   * write access, bookings land on a calendar the service account owns — which
   * starts empty and knows nothing about the sales team's actual day. Consulted
   * alone it would cheerfully offer 3pm while 3pm is already a customer call.
   *
   * Read-only free/busy is usually grantable even where write access is not, so
   * the real calendar can still be consulted for availability while the events
   * are written somewhere else. `GOOGLE_BUSY_CALENDAR_IDS` is that list.
   *
   * A slot is offered only if EVERY calendar here is free, and all their busy
   * intervals are merged into one list to make that a single check.
   */
  private async freeBusy(from: Date, to: Date): Promise<BusyInterval[]> {
    // Deduped: naming the booking calendar in the extras list too is an easy
    // mistake and would otherwise ask Google about it twice.
    const ids = [...new Set([this.config.calendarId, ...(this.config.busyCalendarIds ?? [])])];

    const res = await this.fetchJson<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown }>;
    }>(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        timeZone: this.config.timeZone,
        items: ids.map((id) => ({ id })),
      }),
    });

    const busy: BusyInterval[] = [];
    for (const id of ids) {
      const calendar = res.calendars?.[id];
      if (!calendar || calendar.errors) {
        // Fail CLOSED, and for the extras too. An unreadable calendar means we
        // do not know what is free, and the one thing we must never do is offer
        // a slot we cannot vouch for. A silently-skipped extra would double-book
        // the team while looking like it worked.
        throw new Error(
          `freeBusy did not return a readable calendar for ${id}, ` +
            "check it is shared with the service account",
        );
      }
      for (const b of calendar.busy ?? []) {
        busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
      }
    }
    return busy;
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      // This is a server-side call inside a request the visitor is waiting on.
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google Calendar ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs > Date.now()) return this.token.value;

    const nowSec = Math.floor(Date.now() / 1000);
    const claims: Record<string, string | number> = {
      iss: this.config.serviceAccountEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    };
    // `sub` is what turns a service-account token into "acting as this human".
    // Without it Google refuses to send attendee invites — see note (4) above.
    if (this.config.impersonateSubject) claims.sub = this.config.impersonateSubject;

    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify(claims));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(this.config.privateKey).toString("base64url");
    const assertion = `${header}.${payload}.${signature}`;

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google token exchange ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Google token exchange returned no access_token");

    this.token = {
      value: json.access_token,
      // 60s early, to cover clock skew and the flight time of the next call.
      expiresAtMs: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
    };
    return this.token.value;
  }

  /* ── Slot generation ─────────────────────────────────────────────────── */

  /**
   * Every business-hours slot between `from` and `to`, before free/busy is
   * applied. Generated in the business timezone, not the server's, so a
   * container running UTC and one running IST produce identical calendars.
   */
  private candidateSlots(from: Date, to: Date): Slot[] {
    const { timeZone, slotMinutes, dayStartMinutes, dayEndMinutes, weekdays } = this.config;
    const slots: Slot[] = [];
    const lengthMs = slotMinutes * 60_000;

    // Walk local calendar days. Start one day early: `from` in UTC can still be
    // the previous local day (or the next one) depending on the offset, and
    // dropping that day would silently hide this morning's slots for a
    // west-of-Greenwich zone.
    const dayMs = 86_400_000;
    for (let t = from.getTime() - dayMs; t <= to.getTime() + dayMs; t += dayMs) {
      const { year, month, day, weekday } = zonedDateParts(new Date(t), timeZone);
      if (!weekdays.includes(weekday)) continue;

      for (let m = dayStartMinutes; m + slotMinutes <= dayEndMinutes; m += slotMinutes) {
        const start = zonedTimeToUtc(year, month, day, Math.floor(m / 60), m % 60, timeZone);
        const end = new Date(start.getTime() + lengthMs);
        if (start.getTime() < from.getTime() || end.getTime() > to.getTime()) continue;
        // The ±1 day walk can revisit a local date; dedupe on the instant.
        if (slots.some((s) => s.start.getTime() === start.getTime())) continue;
        slots.push({ start, end });
      }
    }

    slots.sort((a, b) => a.start.getTime() - b.start.getTime());
    return slots;
  }
}

/** Thrown when the chosen slot went away between render and submit. The caller
 *  should re-render the picker with fresh slots, not show an error page. */
export class SlotTakenError extends Error {
  readonly slotTaken = true;
}

/**
 * A deterministic Calendar event id, so a retried booking collides in Google
 * instead of duplicating. Calendar ids must be base32hex (lowercase a-v and
 * 0-9), 5–1024 chars — a uuid with hyphens stripped contains w-z never, but
 * DOES contain hex only, so it is already legal; the timestamp suffix keeps a
 * rebooking by the same person distinct.
 */
function eventIdFor(submissionId: string, start: Date): string {
  const id = submissionId.replace(/[^0-9a-v]/g, "");
  return `aura${id}${start.getTime().toString(32)}`.slice(0, 1024);
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
