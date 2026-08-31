import { parseAddress, ProviderHttpError } from "./email-providers";

/**
 * Provider adapters for calendar sync (PRD Layer 1).
 *
 * Same contract as email-providers.ts, deliberately: one interface, one
 * implementation per provider, and nothing above this file knows which
 * provider a connection uses. The two files are siblings rather than one
 * because the shapes genuinely differ - an event has attendees and a
 * duration, a message has a direction and a snippet - and merging them would
 * produce an interface where half the fields are always null.
 *
 * WHAT AN ADAPTER RETURNS: who was there, when, how long, and what it was
 * called. NOT the description. A meeting body holds agendas, interview notes
 * and dial-in codes for calls the CRM has no business storing, and the same
 * reasoning that keeps email bodies out applies here without modification.
 */

export interface NormalisedEvent {
  externalId: string;
  title: string | null;
  /** Lowercased addresses of everyone invited, including the organiser. */
  attendees: string[];
  organizer: string | null;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  /**
   * The provider says this event is gone. Carried rather than filtered out by
   * the adapter, because a meeting that was synced and then cancelled has to
   * be REMOVED from the timeline - leaving it there states that a meeting
   * happened when it did not.
   */
  cancelled: boolean;
}

export interface CalendarFetchResult {
  events: NormalisedEvent[];
  cursor: string | null;
}

export interface CalendarAdapter {
  id: string;
  fetchSince(
    accessToken: string,
    cursor: string | null,
    from: Date,
    to: Date,
    fetchImpl?: typeof fetch,
  ): Promise<CalendarFetchResult>;
}

// ── Google Calendar ─────────────────────────────────────────────────────────

const googleCalendar: CalendarAdapter = {
  id: "google",
  async fetchSince(accessToken, _cursor, from, to, fetchImpl = fetch) {
    // `singleEvents=true` expands a recurring series into its instances. A
    // weekly check-in with a customer is twelve meetings that happened, not
    // one rule - and without expansion the recurrence would land on the
    // timeline once, dated to whenever the series was created.
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
      showDeleted: "true",
    });
    const data = await capi<{
      items?: Array<{
        id: string;
        status?: string;
        summary?: string;
        location?: string;
        organizer?: { email?: string };
        attendees?: Array<{ email?: string }>;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }>;
    }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      accessToken,
      fetchImpl,
    );

    const events: NormalisedEvent[] = [];
    for (const item of data.items ?? []) {
      const startsAt = when(item.start);
      if (!startsAt) continue;
      const organizer = parseAddress(item.organizer?.email);
      events.push({
        externalId: item.id,
        title: item.summary ?? null,
        organizer,
        attendees: addresses([
          item.organizer?.email,
          ...(item.attendees ?? []).map((a) => a.email),
        ]),
        startsAt,
        endsAt: when(item.end),
        location: item.location ?? null,
        cancelled: item.status === "cancelled",
      });
    }
    return { events, cursor: null };
  },
};

// ── Microsoft Graph ─────────────────────────────────────────────────────────

const graphCalendar: CalendarAdapter = {
  id: "microsoft",
  async fetchSince(accessToken, _cursor, from, to, fetchImpl = fetch) {
    // calendarView, not /events: Graph's calendarView expands recurrences
    // over a window, which is the same reason Google gets singleEvents=true.
    const params = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $top: "100",
      $select: "id,subject,location,start,end,organizer,attendees,isCancelled",
    });
    const data = await capi<{
      value?: Array<{
        id: string;
        subject?: string;
        isCancelled?: boolean;
        location?: { displayName?: string };
        organizer?: { emailAddress?: { address?: string } };
        attendees?: Array<{ emailAddress?: { address?: string } }>;
        start?: { dateTime?: string };
        end?: { dateTime?: string };
      }>;
    }>(`https://graph.microsoft.com/v1.0/me/calendarview?${params}`, accessToken, fetchImpl);

    const events: NormalisedEvent[] = [];
    for (const item of data.value ?? []) {
      // Graph returns naive local strings with a separate timeZone field;
      // defaulting to UTC is what the API documents when none is supplied.
      const startsAt = item.start?.dateTime ? new Date(`${item.start.dateTime}Z`) : null;
      if (!startsAt || Number.isNaN(startsAt.getTime())) continue;
      const endsAt = item.end?.dateTime ? new Date(`${item.end.dateTime}Z`) : null;
      events.push({
        externalId: item.id,
        title: item.subject ?? null,
        organizer: parseAddress(item.organizer?.emailAddress?.address),
        attendees: addresses([
          item.organizer?.emailAddress?.address,
          ...(item.attendees ?? []).map((a) => a.emailAddress?.address),
        ]),
        startsAt,
        endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
        location: item.location?.displayName ?? null,
        cancelled: item.isCancelled === true,
      });
    }
    return { events, cursor: null };
  },
};

// ── Stub, for local verification ────────────────────────────────────────────

/**
 * Fixture events instead of a provider call, under CALENDAR_STUB=1 - the same
 * device email-providers.ts uses, and for the same reason: a real Google
 * Calendar round trip needs a registered OAuth app and a populated calendar,
 * and without a stub the whole path (matching, dedupe, cancellation, cursor
 * handling) could only be reasoned about rather than run.
 *
 * CALENDAR_STUB_ADDRESS names the attendee, so a test can point the fixture
 * at a contact that actually exists. CALENDAR_STUB_CANCELLED=1 flips the
 * fixture to cancelled, which is how the removal path gets exercised.
 */
const stub: CalendarAdapter = {
  id: "stub",
  async fetchSince(_accessToken, cursor, from) {
    const attendee = process.env.CALENDAR_STUB_ADDRESS ?? "someone@example.com";
    const round = Number(cursor ?? "0") + 1;
    const startsAt = new Date(from.getTime() + 86_400_000);
    return {
      events: [
        {
          externalId: `stub-event-${round}`,
          title: `Site visit (round ${round})`,
          organizer: "rep@example.com",
          attendees: ["rep@example.com", attendee.toLowerCase()],
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          location: "Client site",
          cancelled: process.env.CALENDAR_STUB_CANCELLED === "1",
        },
      ],
      cursor: String(round),
    };
  },
};

const ADAPTERS: Record<string, CalendarAdapter> = {
  google: googleCalendar,
  microsoft: graphCalendar,
  stub,
};

/**
 * The adapter for a provider, or null when that provider cannot sync yet.
 *
 * `caldav` is offered by the console and not serviced here, exactly as `imap`
 * is on the mail side: CalDAV needs a real client library and a mail/calendar
 * server to test against. Returning null surfaces that to the caller as "not
 * supported" rather than as silence - a connected calendar that never syncs
 * and never says why is the worse failure.
 */
export function calendarAdapter(provider: string): CalendarAdapter | null {
  if (process.env.CALENDAR_STUB === "1") return stub;
  return ADAPTERS[provider] ?? null;
}

/** All-day events carry `date` instead of `dateTime`; both must parse. */
function when(slot: { dateTime?: string; date?: string } | undefined): Date | null {
  const raw = slot?.dateTime ?? (slot?.date ? `${slot.date}T00:00:00Z` : null);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Lowercased, de-duplicated, nulls dropped. */
function addresses(raw: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const value of raw) {
    const address = parseAddress(value);
    if (address) out.add(address);
  }
  return [...out];
}

async function capi<T>(url: string, accessToken: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ProviderHttpError(res.status, detail.slice(0, 200));
  }
  return (await res.json()) as T;
}
