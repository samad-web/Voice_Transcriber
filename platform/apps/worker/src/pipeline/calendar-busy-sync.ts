import { createSign } from "node:crypto";
import { getAdminPool } from "@aura/db";

/**
 * Close Aura slots that the team is already busy for in Google Calendar.
 *
 * ── THE GAP THIS FILLS ─────────────────────────────────────────────────────
 *
 * The sync used to run one way: a booking taken on the website was mirrored
 * INTO Google. Nothing came back. An hour blocked out in the team's own
 * calendar - an existing client call, anything not created by this funnel -
 * stayed on offer to visitors, and the first anyone knew was two people
 * expecting the same half hour.
 *
 * ── WHICH CALENDARS COUNT AS "BUSY" ────────────────────────────────────────
 *
 *   GOOGLE_CALENDAR_ID          the booking calendar itself
 *   GOOGLE_BUSY_CALENDAR_IDS    comma-separated, optional - the humans' own
 *                               calendars, which is where the conflicts
 *                               actually live
 *
 * Free/busy needs only read access, which matters here: a Workspace domain that
 * refuses to share a calendar for WRITING will usually still share free/busy,
 * so this works even where the booking calendar could not be theirs.
 *
 * ── IT UNBLOCKS AS WELL AS BLOCKS ──────────────────────────────────────────
 *
 * Every sweep recomputes the whole window from scratch and clears the flag on
 * anything no longer busy. A one-way ratchet would lose availability
 * permanently every time somebody moved a meeting, and the failure would be
 * invisible - slots quietly disappearing with nothing to point at.
 *
 * ── IT NEVER TOUCHES A BOOKED SLOT ─────────────────────────────────────────
 *
 * Only `status = 'open'` rows are considered. A slot someone has already booked
 * through the funnel is a commitment to a real person; the fact that it now
 * collides with something in Google is a conflict for a human to resolve, not
 * something to paper over by hiding the row. It will also always look busy -
 * the funnel put its own event there.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";

/** How far ahead to reconcile. Slots further out than this are left alone. */
const HORIZON_DAYS = 30;

export interface BusySyncResult {
  configured: boolean;
  blocked: number;
  unblocked: number;
  busyIntervals: number;
  error?: string;
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function readConfig() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim();
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!calendarId || !clientEmail || !rawKey) return null;

  const extra = (process.env.GOOGLE_BUSY_CALENDAR_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    // Deduped: naming the booking calendar in the extras list too would ask
    // Google about it twice and prove nothing.
    calendarIds: [...new Set([calendarId, ...extra])],
    clientEmail,
    privateKey: rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey,
    subject: process.env.GOOGLE_CALENDAR_IMPERSONATE_SUBJECT?.trim() || undefined,
  };
}

async function accessToken(cfg: NonNullable<ReturnType<typeof readConfig>>): Promise<string> {
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

/**
 * Reconcile the next `HORIZON_DAYS` of open slots against Google.
 *
 * Returns counts rather than throwing on a Google failure: this runs on a timer
 * inside a worker that has other jobs, and an unreachable calendar must not
 * take the process down. A failure leaves the previous flags exactly as they
 * were - stale, but stale in the safe direction, since a slot wrongly blocked
 * costs one booking and a slot wrongly open costs a double-booked human.
 */
export async function syncExternalBusy(): Promise<BusySyncResult> {
  const pool = getAdminPool();
  const cfg = readConfig();
  if (!cfg) return { configured: false, blocked: 0, unblocked: 0, busyIntervals: 0 };

  const from = new Date();
  const to = new Date(from.getTime() + HORIZON_DAYS * 86_400_000);

  let busy: { start: number; end: number }[];
  try {
    const token = await accessToken(cfg);
    const res = await fetch(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: cfg.calendarIds.map((id) => ({ id })),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`freeBusy ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const json = (await res.json()) as {
      calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown }>;
    };

    busy = [];
    for (const id of cfg.calendarIds) {
      const cal = json.calendars?.[id];
      if (!cal || cal.errors) {
        // FAIL THE WHOLE SWEEP, not just this calendar. A partial answer would
        // silently reopen every slot that only the unreadable calendar knew was
        // busy - the exact double-booking this job exists to prevent, arrived at
        // by a route that looks like success.
        throw new Error(
          `no readable free/busy for ${id} - check it is shared with the service account`,
        );
      }
      for (const b of cal.busy ?? []) {
        busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
      }
    }
  } catch (err) {
    return {
      configured: true,
      blocked: 0,
      unblocked: 0,
      busyIntervals: 0,
      error: (err as Error).message,
    };
  }

  // Every open slot in the horizon, flagged or not, because this recomputes
  // rather than accumulates.
  const { rows } = await pool.query<{ id: string; starts_at: Date; ends_at: Date; blocked: boolean }>(
    `SELECT id, starts_at, ends_at, (external_busy_at IS NOT NULL) AS blocked
       FROM marketing.booking_slots
      WHERE status = 'open'
        AND starts_at >= $1
        AND starts_at <= $2`,
    [from, to],
  );

  // Half-open overlap: a slot starting exactly when a meeting ends is free.
  // Back-to-back is normal; overlapping is not.
  const overlaps = (s: Date, e: Date) =>
    busy.some((b) => s.getTime() < b.end && e.getTime() > b.start);

  const toBlock: string[] = [];
  const toClear: string[] = [];
  for (const row of rows) {
    const isBusy = overlaps(row.starts_at, row.ends_at);
    if (isBusy && !row.blocked) toBlock.push(row.id);
    else if (!isBusy && row.blocked) toClear.push(row.id);
  }

  if (toBlock.length > 0) {
    await pool.query(
      `UPDATE marketing.booking_slots SET external_busy_at = now() WHERE id = ANY($1::uuid[])`,
      [toBlock],
    );
  }
  if (toClear.length > 0) {
    await pool.query(
      `UPDATE marketing.booking_slots SET external_busy_at = NULL WHERE id = ANY($1::uuid[])`,
      [toClear],
    );
  }

  return {
    configured: true,
    blocked: toBlock.length,
    unblocked: toClear.length,
    busyIntervals: busy.length,
  };
}

/** Ten minutes: often enough that a meeting added by hand closes the slot
 *  before a visitor takes it, rare enough to be nothing on the quota. */
const INTERVAL_MS = 10 * 60_000;

export function startCalendarBusySync(): NodeJS.Timeout | null {
  if (!readConfig()) {
    console.log(
      "calendar busy sync: OFF (no GOOGLE_CALENDAR_ID / service account) - " +
        "slots are offered from the database alone",
    );
    return null;
  }

  const run = async () => {
    try {
      const r = await syncExternalBusy();
      if (r.error) console.error(`[calendar-busy] sweep failed: ${r.error}`);
      else if (r.blocked || r.unblocked) {
        console.log(
          `[calendar-busy] ${r.blocked} slot(s) closed, ${r.unblocked} reopened ` +
            `(${r.busyIntervals} busy interval(s) in Google)`,
        );
      }
    } catch (err) {
      // Never let a timer callback take the worker down.
      console.error("[calendar-busy] unexpected", err);
    }
  };

  console.log("calendar busy sync: ON - Google busy times close matching slots every 10 minutes");
  void run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  return timer;
}
