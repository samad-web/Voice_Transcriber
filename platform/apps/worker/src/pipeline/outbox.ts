import { randomUUID } from "node:crypto";

import { getAdminPool, withOrgContext } from "@aura/db";
import {
  backoffSeconds,
  buildSourceDocument,
  deliver,
  mapPayload,
  type CrmIntegration,
  type DbClient,
} from "./crm-dispatch";

/**
 * Durable outgoing queue for CRM deliveries.
 *
 * The queue IS the table: crm_sync_log holds one row per (call, integration)
 * with the pending send and when it may next be tried. A worker restart, a
 * broker purge or a redeploy therefore loses nothing — anything still due is
 * picked up by the next drain. That is the whole reason this isn't a RabbitMQ
 * delayed-retry queue: a lead that took a five-minute call to obtain should not
 * be destroyed by an infrastructure hiccup.
 */

const INTEGRATION_COLUMNS = `id, endpoint, auth_type, auth_header, auth_secret,
  headers, field_map, max_attempts, rate_limit_per_min, auth`;

/**
 * Queue this call for every connected integration on its workspace, then try
 * once immediately so the happy path stays instant instead of waiting for the
 * next drain tick.
 *
 * ON CONFLICT resets an existing row rather than inserting a second:
 * reprocessing a call must redeliver the same lead, not queue a duplicate.
 */
export async function enqueueDispatch(
  client: DbClient,
  orgId: string,
  callId: string,
): Promise<void> {
  const { rows: integrations } = await client.query<CrmIntegration>(
    `SELECT ${INTEGRATION_COLUMNS} FROM crm_integrations ci
      WHERE ci.status = 'connected'
        AND ci.workspace_id = (SELECT workspace_id FROM calls WHERE id = $1)`,
    [callId],
  );
  if (integrations.length === 0) return;

  for (const integration of integrations) {
    const requestId = randomUUID();
    await client.query(
      `INSERT INTO crm_sync_log
         (org_id, call_id, integration_id, status, attempts, next_attempt_at, request_id)
       VALUES ($1, $2, $3, 'pending', 0, now(), $4)
       ON CONFLICT (call_id, integration_id) DO UPDATE
         SET status = 'pending', attempts = 0, next_attempt_at = now(),
             request_id = EXCLUDED.request_id, error = NULL,
             response_status = NULL, response_body = NULL, updated_at = now()`,
      [orgId, callId, integration.id, requestId],
    );
    await attemptOne(client, orgId, callId, integration, requestId);
  }
}

/**
 * One delivery attempt, recording the full request and response either way.
 * Never throws: a CRM problem must not fail the call that produced the lead.
 */
async function attemptOne(
  client: DbClient,
  orgId: string,
  callId: string,
  integration: CrmIntegration,
  requestId: string,
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    const source = await buildSourceDocument(client, callId);
    payload = mapPayload(source, integration.field_map);
  } catch (err) {
    await client.query(
      `UPDATE crm_sync_log
          SET status = 'dead', error = $3, next_attempt_at = NULL,
              last_attempt_at = now(), updated_at = now()
        WHERE call_id = $1 AND integration_id = $2`,
      [callId, integration.id, `payload build failed: ${(err as Error).message}`.slice(0, 500)],
    );
    return;
  }

  const result = await deliver(integration, payload, requestId);

  const {
    rows: [current],
  } = await client.query<{ attempts: number }>(
    `SELECT attempts FROM crm_sync_log WHERE call_id = $1 AND integration_id = $2`,
    [callId, integration.id],
  );
  const attempts = (current?.attempts ?? 0) + 1;

  const exhausted = attempts >= integration.max_attempts;
  const status = result.ok ? "synced" : result.terminal || exhausted ? "dead" : "pending";
  // Honour Retry-After when the receiver sets it; otherwise back off ourselves.
  const nextAttempt =
    status === "pending" ? (result.retryAfterS ?? backoffSeconds(attempts)) : null;

  await client.query(
    `UPDATE crm_sync_log
        SET status = $3, attempts = $4, error = $5,
            external_id = $6, request_body = $7::jsonb,
            response_status = $8, response_body = $9, request_id = $10,
            last_attempt_at = now(), updated_at = now(),
            next_attempt_at = CASE WHEN $11::int IS NULL
                                   THEN NULL
                                   ELSE now() + make_interval(secs => $11::int) END
      WHERE call_id = $1 AND integration_id = $2`,
    [
      callId,
      integration.id,
      status,
      attempts,
      result.error?.slice(0, 500) ?? null,
      result.status ? String(result.status) : null,
      JSON.stringify(payload),
      result.status,
      result.body || null,
      requestId,
      nextAttempt,
    ],
  );

  if (status === "dead") {
    console.error(
      `call ${callId}: CRM delivery gave up after ${attempts} attempt(s) — ` +
        `${result.status ?? "no response"} ${result.error ?? ""}`,
    );
  }
}

/**
 * Drain everything due. Runs cross-tenant off the admin pool to find work, then
 * re-enters each org's RLS context to touch its rows.
 *
 * Each integration is capped per tick at its share of rate_limit_per_min, so a
 * backlog that built up during an outage doesn't stampede the receiver the
 * moment it recovers — the exact moment it is least able to cope.
 */
export async function drainOutbox(intervalMs = 15_000): Promise<number> {
  const share = Math.max(1, Math.round(intervalMs / 60_000 * 1000) / 1000);

  const { rows: due } = await getAdminPool().query<{
    org_id: string;
    call_id: string;
    integration_id: string;
    request_id: string | null;
    rate_limit_per_min: number;
  }>(
    `SELECT l.org_id, l.call_id, l.integration_id, l.request_id, i.rate_limit_per_min
       FROM crm_sync_log l
       JOIN crm_integrations i ON i.id = l.integration_id
      WHERE l.status = 'pending'
        AND l.next_attempt_at IS NOT NULL
        AND l.next_attempt_at <= now()
        AND i.status = 'connected'
      ORDER BY l.next_attempt_at
      LIMIT 500`,
  );
  if (due.length === 0) return 0;

  const sentPerIntegration = new Map<string, number>();
  const byOrg = new Map<string, typeof due>();
  for (const row of due) {
    const cap = Math.max(1, Math.floor(row.rate_limit_per_min * share));
    const sent = sentPerIntegration.get(row.integration_id) ?? 0;
    if (sent >= cap) continue;
    sentPerIntegration.set(row.integration_id, sent + 1);
    const list = byOrg.get(row.org_id) ?? [];
    list.push(row);
    byOrg.set(row.org_id, list);
  }

  let processed = 0;
  for (const [orgId, rows] of byOrg) {
    await withOrgContext(orgId, async (client) => {
      for (const row of rows) {
        const {
          rows: [integration],
        } = await client.query<CrmIntegration>(
          `SELECT ${INTEGRATION_COLUMNS} FROM crm_integrations WHERE id = $1`,
          [row.integration_id],
        );
        if (!integration) continue;
        await attemptOne(
          client,
          orgId,
          row.call_id,
          integration,
          row.request_id ?? randomUUID(),
        );
        processed++;
      }
    });
  }
  if (processed > 0) console.log(`crm outbox: retried ${processed} delivery(ies)`);
  return processed;
}

export function startOutboxDrain(): NodeJS.Timeout {
  const interval = Number(process.env.CRM_OUTBOX_INTERVAL_MS ?? 15_000);
  return setInterval(
    () => void drainOutbox(interval).catch((err) => console.error("crm outbox:", err)),
    interval,
  );
}
