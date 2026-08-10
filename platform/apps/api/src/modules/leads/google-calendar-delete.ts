import { createSign } from "node:crypto";

/**
 * Deleting a Google Calendar event, from the API.
 *
 * ── WHY THIS EXISTS HERE AND NOT IN THE MARKETING APP ──────────────────────
 *
 * The calendar CLIENT lives in apps/marketing, because that is where bookings
 * are made. Rejections happen in the console, which talks to this API — so
 * until now the reject endpoint released the slot, handed back the orphaned
 * event id, and told the operator to go and delete it by hand. Nobody does
 * that. The event outlived the booking it belonged to, and the team kept an
 * appointment in their diary with someone they had just declined.
 *
 * This is deliberately the SMALLEST possible client: mint a token, issue one
 * DELETE. It does not read, list, or create anything, so it cannot drift into
 * being a second scheduler — the real one stays in apps/marketing/lib/scheduler.
 *
 * ── IT RUNS AFTER THE COMMIT, ON PURPOSE ───────────────────────────────────
 *
 * Deleting inside the transaction would mean a later rollback leaves a
 * cancelled event against a slot that is still booked — a meeting that
 * silently vanished from the calendar while the database still expects it.
 * Committing first inverts the failure into the recoverable one: if the delete
 * fails, the event survives against a released slot, which is visible, is
 * reported to the operator, and can be removed by hand.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function config() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim();
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!calendarId || !clientEmail || !rawKey) return null;
  return {
    calendarId,
    clientEmail,
    // A PEM in a .env keeps its newlines as the two characters \ and n.
    privateKey: rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey,
    subject: process.env.GOOGLE_CALENDAR_IMPERSONATE_SUBJECT?.trim() || undefined,
  };
}

async function accessToken(cfg: NonNullable<ReturnType<typeof config>>): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: Record<string, string | number> = {
    iss: cfg.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  if (cfg.subject) claims.sub = cfg.subject;

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const assertion = `${header}.${payload}.${signer.sign(cfg.privateKey).toString("base64url")}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("token exchange returned no access_token");
  return json.access_token;
}

export interface CalendarDeletion {
  /** Event ids Google no longer holds — deleted now, or already gone. */
  deleted: string[];
  /** Still present, and the operator has to remove them by hand. */
  failed: { eventId: string; error: string }[];
}

/**
 * Delete events, tolerating the ones that were never there.
 *
 * 404 and 410 both count as success. An event that is already gone is the
 * outcome this function exists to produce, and reporting it as a failure would
 * send an operator hunting for something that does not exist — which is worse
 * than silence, because they would stop trusting the message that matters.
 */
export async function deleteCalendarEvents(eventIds: string[]): Promise<CalendarDeletion> {
  const out: CalendarDeletion = { deleted: [], failed: [] };
  if (eventIds.length === 0) return out;

  const cfg = config();
  if (!cfg) {
    // No calendar configured means no event was ever created, so there is
    // nothing to delete and nothing to report.
    return out;
  }

  let token: string;
  try {
    token = await accessToken(cfg);
  } catch (err) {
    return {
      deleted: [],
      failed: eventIds.map((eventId) => ({ eventId, error: (err as Error).message })),
    };
  }

  for (const eventId of eventIds) {
    try {
      const res = await fetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(cfg.calendarId)}/events/${encodeURIComponent(eventId)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (res.ok || res.status === 404 || res.status === 410) {
        out.deleted.push(eventId);
      } else {
        out.failed.push({ eventId, error: `Google ${res.status}` });
      }
    } catch (err) {
      out.failed.push({ eventId, error: (err as Error).message });
    }
  }
  return out;
}
