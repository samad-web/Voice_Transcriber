import { decryptSecret, encryptSecret, getAdminPool, withOrgContext } from "@aura/db";
import type { DbClient } from "./crm-dispatch";
import { calendarAdapter, type NormalisedEvent } from "./calendar-providers";
import { needsReconnect, oauthAppFor, refreshAccessToken } from "./email-sync";

/**
 * Pull each connected calendar onto the interaction timeline (PRD Layer 1).
 *
 * ── THE SAME RULE THAT SHAPES THE MAIL SYNC ───────────────────────────────
 *
 * An event is recorded ONLY when somebody on its guest list is already a
 * contact in this org's CRM. A rep's calendar holds their dentist, their
 * kids' parents' evening, their therapy appointment and their interview with
 * a competitor; copying it wholesale into a system their manager reads would
 * be surveillance with a CRM logo on it. Matching first means the calendar
 * contributes the meetings the CRM already had a reason to know about, and
 * nothing else. Only the title, time and location are stored - never the
 * description, which is where agendas and dial-in details live.
 *
 * ── A MEETING IS NOT ONLY A PAST EVENT ────────────────────────────────────
 *
 * The window runs BACKWARDS AND FORWARDS. A meeting next Thursday with a
 * customer is the single most useful thing a rep can see on a deal, and a
 * timeline that only knows about the past would refuse to show it. Future
 * rows are ordinary interactions whose occurred_at has not happened yet; the
 * console labels them Scheduled by comparing against now, which needs no
 * extra column and stays correct as time passes.
 *
 * ── CANCELLATION ──────────────────────────────────────────────────────────
 *
 * A cancelled event is DELETED from the timeline, not left in place. It is
 * the one case where removing CRM data is the honest act: the row asserts
 * that a meeting happened, and if the meeting was called off that assertion
 * is simply false. Only rows this sync itself wrote are ever removed -
 * matched on connection_id AND external_id - so a note somebody typed by hand
 * is never in scope.
 */

/** How far back to look. Beyond this, a meeting is history nobody is acting on. */
const LOOKBACK_DAYS = 30;
/** How far forward. Far enough to cover "what's coming up", short enough to stay small. */
const LOOKAHEAD_DAYS = 60;
const MAX_FAILURES = 5;

interface ConnectionRow {
  id: string;
  org_id: string;
  user_id: string;
  provider: string;
  account_email: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: Date | null;
  calendar_cursor: string | null;
  calendar_failures: number;
  oauth_client_id: string | null;
}

export interface CalendarSyncOutcome {
  connectionId: string;
  fetched: number;
  matched: number;
  written: number;
  removed: number;
  reason?: string;
}

/**
 * Which contact this event is about, or null if it is none of the CRM's
 * business.
 *
 * Exported so the rule can be tested directly rather than only through a
 * database. `self` is excluded before matching for the same reason the mail
 * sync excludes it: a rep who is themselves a contact in the CRM (it happens
 * - test data, or a colleague who was once a customer) must not turn every
 * private appointment into a CRM record.
 */
export function attendeeContact(
  event: NormalisedEvent,
  accountEmail: string,
  contactsByEmail: Map<string, string>,
): string | null {
  const self = accountEmail.toLowerCase();
  for (const address of event.attendees) {
    if (address === self) continue;
    const contactId = contactsByEmail.get(address);
    if (contactId) return contactId;
  }
  return null;
}

/** Seconds between start and end, or null when the provider gave no end. */
export function durationSeconds(event: NormalisedEvent): number | null {
  if (!event.endsAt) return null;
  const seconds = Math.round((event.endsAt.getTime() - event.startsAt.getTime()) / 1000);
  // An end before its start is a provider bug, not a negative meeting.
  return seconds > 0 ? seconds : null;
}

/** Sync one connection's calendar. Exported so a test can drive it without the timer. */
export async function syncCalendar(
  client: DbClient,
  connection: ConnectionRow,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarSyncOutcome> {
  const base: CalendarSyncOutcome = {
    connectionId: connection.id,
    fetched: 0,
    matched: 0,
    written: 0,
    removed: 0,
  };

  const adapter = calendarAdapter(connection.provider);
  if (!adapter) return { ...base, reason: `no calendar adapter for ${connection.provider}` };

  let accessToken = decryptSecret(connection.access_token);
  const refreshToken = decryptSecret(connection.refresh_token);
  const expired =
    connection.token_expires_at !== null &&
    connection.token_expires_at.getTime() < Date.now() + 60_000;

  if ((!accessToken || expired) && refreshToken) {
    const app = await oauthAppFor(client, connection);
    const refreshed = await refreshAccessToken(app, refreshToken, fetchImpl);
    accessToken = refreshed.accessToken;
    await client.query(
      `UPDATE connected_accounts
          SET access_token = $2,
              refresh_token = COALESCE($3, refresh_token),
              token_expires_at = CASE WHEN $4::int IS NULL THEN NULL
                                      ELSE now() + ($4 || ' seconds')::interval END
        WHERE id = $1`,
      [
        connection.id,
        encryptSecret(refreshed.accessToken),
        encryptSecret(refreshed.refreshToken),
        refreshed.expiresIn,
      ],
    );
  }
  if (!accessToken && process.env.CALENDAR_STUB !== "1") {
    return { ...base, reason: "no usable access token - reconnect required" };
  }

  // A fixed window rather than "since last sync": an event's DETAILS can
  // change without the event being new (moved an hour later, a guest added),
  // and a since-cursor would never see it again. The window is small and the
  // unique index makes re-reading free.
  const now = Date.now();
  const from = new Date(now - LOOKBACK_DAYS * 86_400_000);
  const to = new Date(now + LOOKAHEAD_DAYS * 86_400_000);

  const result = await adapter.fetchSince(
    accessToken ?? "",
    connection.calendar_cursor,
    from,
    to,
    fetchImpl,
  );
  base.fetched = result.events.length;

  const addresses = [...new Set(result.events.flatMap((e) => e.attendees))];
  const contactsByEmail = new Map<string, string>();
  if (addresses.length > 0) {
    const { rows } = await client.query<{ id: string; email: string }>(
      `SELECT id, lower(email) AS email FROM contacts
        WHERE email IS NOT NULL AND lower(email) = ANY($1::text[]) AND status <> 'merged'`,
      [addresses],
    );
    for (const row of rows) contactsByEmail.set(row.email, row.id);
  }

  for (const event of result.events) {
    const contactId = attendeeContact(event, connection.account_email, contactsByEmail);
    if (!contactId) continue;
    base.matched++;

    if (event.cancelled) {
      // Scoped to this connection's own rows. A hand-logged meeting with the
      // same subject is not ours to delete.
      const { rowCount } = await client.query(
        `DELETE FROM interactions
          WHERE connection_id = $1 AND external_id = $2 AND type = 'meeting'`,
        [connection.id, event.externalId],
      );
      base.removed += rowCount ?? 0;
      continue;
    }

    const {
      rows: [deal],
    } = await client.query<{ id: string }>(
      `SELECT id FROM deals WHERE contact_id = $1 AND status = 'open'
        ORDER BY last_activity_at DESC LIMIT 1`,
      [contactId],
    );

    // DO UPDATE rather than DO NOTHING, unlike the mail sync: a sent message
    // is immutable, and a meeting is not. Rescheduling one has to move the
    // row, or the timeline keeps showing the time it was originally set for.
    const { rowCount } = await client.query(
      `INSERT INTO interactions
         (org_id, type, direction, contact_id, deal_id, connection_id, external_id,
          subject, occurred_at, duration_s, actor_user_id, metadata)
       VALUES ($1, 'meeting', NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (org_id, type, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET subject     = EXCLUDED.subject,
                     occurred_at = EXCLUDED.occurred_at,
                     duration_s  = EXCLUDED.duration_s,
                     deal_id     = COALESCE(EXCLUDED.deal_id, interactions.deal_id),
                     metadata    = EXCLUDED.metadata`,
      [
        connection.org_id,
        contactId,
        deal?.id ?? null,
        connection.id,
        event.externalId,
        event.title,
        event.startsAt,
        durationSeconds(event),
        connection.user_id,
        JSON.stringify({
          organizer: event.organizer,
          attendees: event.attendees,
          location: event.location,
        }),
      ],
    );
    base.written += rowCount ?? 0;
  }

  await client.query(
    `UPDATE connected_accounts
        SET calendar_synced_at = now(), calendar_cursor = $2, calendar_failures = 0
      WHERE id = $1`,
    [connection.id, result.cursor],
  );
  return base;
}

/** One pass over every connection that offers a calendar. */
export async function syncAllCalendars(fetchImpl: typeof fetch = fetch): Promise<number> {
  const { rows: connections } = await getAdminPool().query<ConnectionRow>(
    `SELECT id, org_id, user_id, provider, account_email, access_token, refresh_token,
            token_expires_at, calendar_cursor, calendar_failures, oauth_client_id
       FROM connected_accounts
      WHERE status = 'active' AND calendar_failures < $1
        AND 'calendar' = ANY(capabilities)
      ORDER BY calendar_synced_at NULLS FIRST
      LIMIT 50`,
    [MAX_FAILURES],
  );

  let written = 0;
  for (const connection of connections) {
    try {
      const outcome = await withOrgContext(connection.org_id, (client) =>
        syncCalendar(client as DbClient, connection, fetchImpl),
      );
      written += outcome.written;
      if (outcome.reason) {
        console.log(`calendar sync ${connection.account_email}: ${outcome.reason}`);
      } else if (outcome.written > 0 || outcome.removed > 0) {
        console.log(
          `calendar sync ${connection.account_email}: ${outcome.fetched} fetched, ` +
            `${outcome.matched} with a contact, ${outcome.written} on the timeline, ` +
            `${outcome.removed} cancelled`,
        );
      }
    } catch (err) {
      const dead = needsReconnect(err);
      // Only the CALENDAR counter moves, and `status` is deliberately left
      // alone: a revoked calendar scope must not park a mailbox that is still
      // working. The connection stays active and the mail sweep keeps running.
      await getAdminPool().query(
        `UPDATE connected_accounts
            SET calendar_failures = $2, last_error = $3
          WHERE id = $1`,
        [
          connection.id,
          dead ? MAX_FAILURES : connection.calendar_failures + 1,
          String(err instanceof Error ? err.message : err).slice(0, 500),
        ],
      );
      console.error(`calendar sync ${connection.account_email}:`, err);
    }
  }
  return written;
}

/** Same start-a-timer shape as the worker's other sweeps. */
export function startCalendarSync(): NodeJS.Timeout {
  const raw = Number(process.env.CALENDAR_SYNC_INTERVAL_MS);
  const interval = Number.isFinite(raw) && raw > 0 ? raw : 600_000;
  return setInterval(
    () => void syncAllCalendars().catch((err) => console.error("calendar sync:", err)),
    interval,
  );
}
