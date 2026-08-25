import { connectionProvider } from "@aura/shared";
import { decryptSecret, encryptSecret, getAdminPool, withOrgContext } from "@aura/db";
import type { DbClient } from "./crm-dispatch";
import {
  emailAdapter,
  parseAddress,
  ProviderHttpError,
  type NormalisedMessage,
} from "./email-providers";

/**
 * Pull each connected mailbox onto the interaction timeline (PRD Layer 1).
 *
 * ── THE RULE THAT SHAPES EVERYTHING HERE ──────────────────────────────────
 *
 * A message is recorded ONLY when the other side of it is already a contact
 * in this org's CRM. Everything else is dropped before it is written
 * anywhere.
 *
 * That is not an optimisation. A rep's mailbox holds their payslips, their
 * doctor, their union rep and their job applications; syncing it wholesale
 * into a system their manager can read would be a serious breach dressed up
 * as a feature. Matching first means the CRM learns about the conversations
 * it already had a reason to know about, and nothing else. It is also why
 * only the subject and a short snippet are stored, never the body.
 *
 * ── POLLING, NOT WEBHOOKS ─────────────────────────────────────────────────
 *
 * Webhooks need a publicly reachable HTTPS endpoint and per-provider
 * subscription renewal, cannot be exercised locally at all, and do not exist
 * for IMAP. Polling works everywhere and matches the five sweeps this worker
 * already runs. Webhooks are a latency optimisation for later, not a
 * correctness requirement.
 *
 * Runs on the ADMIN pool to enumerate connections across orgs, then does all
 * per-tenant work inside withOrgContext — the same shape backfill-crm-objects
 * and the CRM outbox use.
 */

/** Overlap the window rather than risk a gap; the unique index dedupes. */
const OVERLAP_MINUTES = 10;
/** After this many consecutive failures a connection is parked. */
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
  sync_cursor: string | null;
  last_synced_at: Date | null;
  sync_failures: number;
}

export interface SyncOutcome {
  connectionId: string;
  fetched: number;
  matched: number;
  written: number;
  reason?: string;
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Access tokens last about an hour, so without this every connection breaks
 * shortly after it is made and the user is asked to reconnect for no reason
 * they can see.
 */
export async function refreshAccessToken(
  provider: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number | null; refreshToken: string | null }> {
  const spec = connectionProvider(provider);
  if (!spec?.oauth) throw new Error(`${provider} cannot refresh — not an oauth provider`);

  const clientId = process.env[spec.oauth.clientIdEnv];
  const clientSecret = process.env[spec.oauth.clientSecretEnv];
  if (!clientId || !clientSecret) throw new Error(`${provider} is not configured on this deployment`);

  const res = await fetchImpl(spec.oauth.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ProviderHttpError(res.status, detail.slice(0, 200));
  }
  const body = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in ?? null,
    // Providers rotate refresh tokens sometimes; keep the new one when sent.
    refreshToken: body.refresh_token ?? null,
  };
}

/**
 * Decide what a message means for the CRM, or that it means nothing.
 *
 * Direction is judged from the connected account's own address: a message it
 * sent is outgoing, anything else incoming. Returns null when neither side is
 * a known contact — the drop that keeps a private mailbox private.
 */
export function classify(
  message: NormalisedMessage,
  accountEmail: string,
  contactsByEmail: Map<string, string>,
): { contactId: string; direction: "incoming" | "outgoing" } | null {
  const self = accountEmail.toLowerCase();
  const outgoing = message.from === self;

  // The counterparties are everyone on the message who is not the account
  // itself. A rep emailing themselves is not an interaction.
  const others = (outgoing ? message.to : [message.from, ...message.to]).filter((a) => a !== self);

  for (const address of others) {
    const contactId = contactsByEmail.get(address);
    if (contactId) return { contactId, direction: outgoing ? "outgoing" : "incoming" };
  }
  return null;
}

/** Sync one connection. Exported so a test can drive it without the timer. */
export async function syncConnection(
  client: DbClient,
  connection: ConnectionRow,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncOutcome> {
  const base: SyncOutcome = { connectionId: connection.id, fetched: 0, matched: 0, written: 0 };

  const adapter = emailAdapter(connection.provider);
  if (!adapter) return { ...base, reason: `no sync adapter for ${connection.provider}` };

  // ── credentials ─────────────────────────────────────────────────────────
  let accessToken = decryptSecret(connection.access_token);
  const refreshToken = decryptSecret(connection.refresh_token);
  const expired =
    connection.token_expires_at !== null && connection.token_expires_at.getTime() < Date.now() + 60_000;

  if ((!accessToken || expired) && refreshToken) {
    const refreshed = await refreshAccessToken(connection.provider, refreshToken, fetchImpl);
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
  // The stub needs no credential; every real adapter does.
  if (!accessToken && process.env.EMAIL_STUB !== "1") {
    return { ...base, reason: "no usable access token — reconnect required" };
  }

  // ── fetch ───────────────────────────────────────────────────────────────
  const since = new Date(
    (connection.last_synced_at?.getTime() ?? Date.now() - 30 * 86_400_000) -
      OVERLAP_MINUTES * 60_000,
  );
  const result = await adapter.fetchSince(accessToken ?? "", connection.sync_cursor, since, fetchImpl);
  base.fetched = result.messages.length;

  // ── match ───────────────────────────────────────────────────────────────
  // One lookup for every address seen, rather than a query per message.
  const addresses = [
    ...new Set(result.messages.flatMap((m) => [m.from, ...m.to]).filter(Boolean)),
  ];
  const contactsByEmail = new Map<string, string>();
  if (addresses.length > 0) {
    const { rows } = await client.query<{ id: string; email: string }>(
      `SELECT id, lower(email) AS email FROM contacts
        WHERE email IS NOT NULL AND lower(email) = ANY($1::text[]) AND status <> 'merged'`,
      [addresses],
    );
    for (const row of rows) contactsByEmail.set(row.email, row.id);
  }

  for (const message of result.messages) {
    const hit = classify(message, connection.account_email, contactsByEmail);
    if (!hit) continue;
    base.matched++;

    // The contact's most recent deal, so the thread lands on the pipeline
    // card too. Best-effort: an email is still worth recording without one.
    const {
      rows: [deal],
    } = await client.query<{ id: string }>(
      `SELECT id FROM deals WHERE contact_id = $1 AND status = 'open'
        ORDER BY last_activity_at DESC LIMIT 1`,
      [hit.contactId],
    );

    const { rowCount } = await client.query(
      `INSERT INTO interactions
         (org_id, type, direction, contact_id, deal_id, connection_id, external_id,
          subject, body, occurred_at, actor_user_id, metadata)
       VALUES ($1, 'email', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (org_id, type, external_id) WHERE external_id IS NOT NULL
       DO NOTHING`,
      [
        connection.org_id,
        hit.direction,
        hit.contactId,
        deal?.id ?? null,
        connection.id,
        message.externalId,
        message.subject,
        message.snippet,
        message.occurredAt,
        connection.user_id,
        JSON.stringify({ from: message.from, to: message.to }),
      ],
    );
    base.written += rowCount ?? 0;
  }

  await client.query(
    `UPDATE connected_accounts
        SET last_synced_at = now(), sync_cursor = $2, sync_failures = 0, last_error = NULL,
            status = 'active'
      WHERE id = $1`,
    [connection.id, result.cursor],
  );
  return base;
}

/** One pass over every syncable connection, oldest-synced first. */
export async function syncAllMailboxes(fetchImpl: typeof fetch = fetch): Promise<number> {
  const { rows: connections } = await getAdminPool().query<ConnectionRow>(
    `SELECT id, org_id, user_id, provider, account_email, access_token, refresh_token,
            token_expires_at, sync_cursor, last_synced_at, sync_failures
       FROM connected_accounts
      WHERE status = 'active' AND sync_failures < $1
        AND 'email' = ANY(capabilities)
      ORDER BY last_synced_at NULLS FIRST
      LIMIT 50`,
    [MAX_FAILURES],
  );

  let written = 0;
  for (const connection of connections) {
    try {
      const outcome = await withOrgContext(connection.org_id, (client) =>
        syncConnection(client as DbClient, connection, fetchImpl),
      );
      written += outcome.written;
      if (outcome.reason) {
        console.log(`mail sync ${connection.account_email}: ${outcome.reason}`);
      } else if (outcome.written > 0) {
        console.log(
          `mail sync ${connection.account_email}: ${outcome.fetched} fetched, ` +
            `${outcome.matched} matched a contact, ${outcome.written} added to the timeline`,
        );
      }
    } catch (err) {
      // A dead token is parked immediately rather than after five tries —
      // retrying a revoked grant never succeeds and only burns rate limit.
      const dead = err instanceof ProviderHttpError && err.needsReconnect;
      await getAdminPool().query(
        `UPDATE connected_accounts
            SET sync_failures = $2, last_error = $3, status = $4
          WHERE id = $1`,
        [
          connection.id,
          dead ? MAX_FAILURES : connection.sync_failures + 1,
          String(err instanceof Error ? err.message : err).slice(0, 500),
          dead ? "expired" : "active",
        ],
      );
      console.error(`mail sync ${connection.account_email}:`, err);
    }
  }
  return written;
}

/**
 * Slower than the CRM outbox on purpose: mail is not latency-sensitive, and
 * every provider meters requests. Same start-a-timer shape as the worker's
 * other sweeps.
 */
export function startMailboxSync(): NodeJS.Timeout {
  const raw = Number(process.env.EMAIL_SYNC_INTERVAL_MS);
  const interval = Number.isFinite(raw) && raw > 0 ? raw : 300_000;
  return setInterval(
    () => void syncAllMailboxes().catch((err) => console.error("mail sync:", err)),
    interval,
  );
}
