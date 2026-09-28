import { decryptSecret, getAdminPool, withOrgContext } from "@aura/db";
import { attendanceAlertText, describeRequest, type LeaveType, type HalfDay, type RequestKind, resolveTimeZone } from "@aura/shared";
import type { Queryable } from "./attendance-schedule";

/**
 * WhatsApp alerts to approvers (doc 33 §6.4, migration 0140) - the drain of
 * `attendance_whatsapp_outbox`.
 *
 * ── WHO, FROM WHERE, AND ONLY WHEN SOMEBODY SAID YES ────────────────────────
 *
 * Recipients are the workspace's OWN managers and owners, on the number their
 * staff profile holds (`memberships.whatsapp_number`) - never a lead, never a
 * customer. The message goes out from the workspace's own business channel
 * (`organizations.attendance_whatsapp_channel_id`: provider waba or wasi, no
 * owner - the 0140 trigger enforces it), never from a personal number and
 * never from Aura's own platform account: the Evolution sender in
 * ./whatsapp.ts is deliberately not used here.
 *
 * Three switches must all be on AT SEND TIME, or the row is `skipped`:
 *   - the workspace's toggle, which only an owner can turn on;
 *   - WHATSAPP_SENDING_ENABLED, the deployment's switch for all outbound
 *     WhatsApp (off unless set - the same gate the console's reply box and
 *     call-access codes use);
 *   - and the request must still be pending: nobody is nagged about a request
 *     that was decided while the row waited.
 * A skipped row is never retried, so turning a switch on later does not
 * release a burst of stale alerts.
 *
 * ── THE TWO TRANSPORTS ──────────────────────────────────────────────────────
 *
 * Wasi: a plain text message through Wasi's Hub API - Wasi enforces its own
 * rules (WABA connected, 24-hour window, plan caps) and a refusal comes back
 * with its reason, which is recorded. WABA (Meta Cloud API): a business may
 * only START a conversation with an approved template, so this sends the
 * `attendance_request_alert` template (3 variables: name, request, link) and
 * nothing else; the console will not let the toggle on without it approved.
 *
 * These are small copies of the API's senders (conversations/wasi-client.ts,
 * meta-send.ts) because the worker cannot import the API and this change was
 * scoped to the apps. Moving both into a shared package is the follow-up.
 *
 * The telecaller's reason is never sent: a sick-leave reason is a health
 * detail and does not belong in a chat app.
 */

export const ATTENDANCE_WABA_TEMPLATE = "attendance_request_alert";
const MAX_ATTEMPTS = 5;
const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";

export class SendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** 429 and 5xx are worth another go; any other refusal is final. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Minutes until the next attempt: 1, 2, 4, 8 ... */
export function backoffMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

/** Digits only - both transports want the international number without spaces or a plus. */
export function whatsappDigits(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

/** `PUBLIC_APP_URL` (the console, basePath included) + the Requests tab. Null when unset. */
export function requestsLink(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/owner/attendance?tab=requests` : null;
}

async function sendWasiText(
  channel: { apiBaseUrl: string; apiKey: string; wasiClientId: string },
  to: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${channel.apiBaseUrl.replace(/\/$/, "")}/api/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${channel.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "text", to, body, client_id: channel.wasiClientId }),
    });
  } catch (err) {
    throw new SendError(`Wasi unreachable: ${(err as Error).message}`, true);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string; meta_message_id?: string | null };
  if (!res.ok) {
    throw new SendError(`Wasi refused (${res.status}${json.code ? ` ${json.code}` : ""}): ${json.error ?? "no reason"}`, isRetryableStatus(res.status));
  }
  return json.meta_message_id ?? null;
}

async function sendCloudTemplate(
  creds: { accessToken: string; phoneNumberId: string },
  to: string,
  template: { name: string; language: string; params: string[] },
  fetchImpl: typeof fetch,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(creds.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${creds.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: template.name,
            language: { code: template.language },
            components: [{ type: "body", parameters: template.params.map((text) => ({ type: "text", text })) }],
          },
        }),
      },
    );
  } catch (err) {
    throw new SendError(`Meta unreachable: ${(err as Error).message}`, true);
  }
  const json = (await res.json().catch(() => null)) as {
    messages?: { id?: string }[];
    error?: { message?: string; error_user_msg?: string };
  } | null;
  if (!res.ok) {
    throw new SendError(
      `Meta refused (${res.status}): ${json?.error?.error_user_msg ?? json?.error?.message ?? "no reason"}`,
      isRetryableStatus(res.status),
    );
  }
  return json?.messages?.[0]?.id ?? null;
}

interface DueRow {
  id: string;
  reason: "new_request" | "escalation";
  attempts: number;
  request_status: string;
  kind: RequestKind;
  leave_type: string | null;
  start_date: string | null;
  end_date: string | null;
  half_day: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  telecaller_name: string;
  whatsapp_number: string | null;
  recipient_active: boolean;
}

export async function drainAttendanceWhatsapp(fetchImpl: typeof fetch = fetch): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM attendance_whatsapp_outbox WHERE status = 'queued' AND next_attempt_at <= now()`,
  );
  let sent = 0;
  for (const { org_id } of orgs) {
    try {
      sent += await drainOrg(org_id, fetchImpl);
    } catch (err) {
      console.error(`attendance whatsapp: org ${org_id}:`, err);
    }
  }
  return sent;
}

async function settle(
  client: Queryable,
  id: string,
  outcome: { status: "sent"; providerId: string | null } | { status: "skipped" | "failed"; error: string } | { status: "retry"; error: string; attempts: number },
) {
  if (outcome.status === "sent") {
    await client.query(
      `UPDATE attendance_whatsapp_outbox
          SET status = 'sent', attempts = attempts + 1, provider_message_id = $2, sent_at = now(), last_error = NULL
        WHERE id = $1`,
      [id, outcome.providerId],
    );
  } else if (outcome.status === "retry") {
    await client.query(
      `UPDATE attendance_whatsapp_outbox
          SET attempts = attempts + 1, last_error = $2,
              next_attempt_at = now() + make_interval(mins => $3)
        WHERE id = $1`,
      [id, outcome.error.slice(0, 500), backoffMinutes(outcome.attempts)],
    );
  } else {
    await client.query(
      `UPDATE attendance_whatsapp_outbox
          SET status = $2, attempts = attempts + CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END, last_error = $3
        WHERE id = $1`,
      [id, outcome.status, outcome.error.slice(0, 500)],
    );
  }
}

async function drainOrg(orgId: string, fetchImpl: typeof fetch): Promise<number> {
  // Read everything needed, then send OUTSIDE any transaction (a provider
  // round trip must not hold a connection), then record each outcome.
  const plan = await withOrgContext(orgId, async (client) => {
    const {
      rows: [org],
    } = await client.query<{
      zone: string | null;
      alerts: boolean;
      provider: string | null;
      channel_status: string | null;
      owner_user_id: string | null;
      api_key: string | null;
      api_base_url: string | null;
      config: { wasiClientId?: string; phoneNumberId?: string } | null;
      template_language: string | null;
      channel_id: string | null;
    }>(
      `SELECT o.reporting_timezone AS zone, o.attendance_whatsapp_alerts AS alerts,
              c.id AS channel_id, c.provider, c.status AS channel_status, c.owner_user_id,
              c.api_key, c.api_base_url, c.config,
              (SELECT mt.language FROM message_templates mt
                WHERE mt.channel_id = c.id AND mt.name = $2 AND mt.status = 'approved'
                  AND jsonb_array_length(COALESCE(mt.variables, '[]'::jsonb)) = 3
                ORDER BY (mt.language = 'en') DESC, mt.language LIMIT 1) AS template_language
         FROM organizations o
         LEFT JOIN messaging_channels c ON c.id = o.attendance_whatsapp_channel_id
        WHERE o.id = $1`,
      [orgId, ATTENDANCE_WABA_TEMPLATE],
    );
    const { rows } = await client.query<DueRow>(
      `SELECT x.id, x.reason, x.attempts, r.status AS request_status, r.kind, r.leave_type,
              r.start_date::text AS start_date, r.end_date::text AS end_date, r.half_day,
              r.starts_at, r.ends_at, t.display_name AS telecaller_name,
              COALESCE(NULLIF(btrim(m.whatsapp_number), ''),
                       (SELECT NULLIF(btrim(m2.whatsapp_number), '') FROM memberships m2
                         WHERE m2.org_id = m.org_id AND m2.user_id = m.user_id
                           AND NULLIF(btrim(m2.whatsapp_number), '') IS NOT NULL
                         ORDER BY (m2.scope_type = 'org') DESC LIMIT 1)) AS whatsapp_number,
              (m.status = 'active' AND u.status = 'active') AS recipient_active
         FROM attendance_whatsapp_outbox x
         JOIN attendance_requests r ON r.id = x.request_id
         JOIN telecallers t ON t.id = r.telecaller_id
         JOIN memberships m ON m.id = x.recipient_membership_id
         JOIN users u ON u.id = m.user_id
        WHERE x.status = 'queued' AND x.next_attempt_at <= now()
        ORDER BY x.next_attempt_at
        LIMIT 50`,
    );
    return { org, rows };
  });
  if (!plan.org || plan.rows.length === 0) return 0;
  const org = plan.org;
  const zone = resolveTimeZone(org.zone);
  const link = requestsLink();

  // Decide per row before sending anything.
  const outcomes: { id: string; outcome: Parameters<typeof settle>[2] }[] = [];
  let sent = 0;
  for (const row of plan.rows) {
    const skip = (error: string) => outcomes.push({ id: row.id, outcome: { status: "skipped", error } });
    if (!org.alerts) {
      skip("WhatsApp alerts were switched off before this was sent");
      continue;
    }
    if (process.env.WHATSAPP_SENDING_ENABLED !== "true") {
      skip("outbound WhatsApp is switched off on this deployment (WHATSAPP_SENDING_ENABLED)");
      continue;
    }
    if (row.request_status !== "pending") {
      skip(`the request was ${row.request_status.replace("_", " ")} before this was sent`);
      continue;
    }
    if (!org.channel_id || org.channel_status !== "active" || org.owner_user_id !== null || !["waba", "wasi"].includes(org.provider ?? "")) {
      skip("no active WhatsApp Business channel is chosen for alerts");
      continue;
    }
    if (!row.recipient_active) {
      skip("the recipient is no longer an active member");
      continue;
    }
    const to = whatsappDigits(row.whatsapp_number);
    if (!to) {
      skip("the recipient has no WhatsApp number on their staff profile");
      continue;
    }
    if (!link) {
      outcomes.push({ id: row.id, outcome: { status: "failed", error: "the worker has no PUBLIC_APP_URL, so the message would carry no link" } });
      continue;
    }

    const request = {
      kind: row.kind,
      leaveType: row.leave_type as LeaveType | null,
      startDate: row.start_date,
      endDate: row.end_date,
      halfDay: row.half_day as HalfDay | null,
      startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
      endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
      zone,
    };
    try {
      let providerId: string | null;
      if (org.provider === "wasi") {
        if (!org.api_key || !org.api_base_url || !org.config?.wasiClientId) {
          outcomes.push({ id: row.id, outcome: { status: "failed", error: "the WhatsApp channel is missing its Wasi credentials" } });
          continue;
        }
        providerId = await sendWasiText(
          { apiBaseUrl: org.api_base_url, apiKey: decryptSecret(org.api_key) ?? "", wasiClientId: org.config.wasiClientId },
          to,
          attendanceAlertText({ reason: row.reason, telecallerName: row.telecaller_name, link, ...request }),
          fetchImpl,
        );
      } else {
        if (!org.template_language) {
          skip(`the "${ATTENDANCE_WABA_TEMPLATE}" template is not approved on this WhatsApp Business number`);
          continue;
        }
        if (!org.api_key || !org.config?.phoneNumberId) {
          outcomes.push({ id: row.id, outcome: { status: "failed", error: "the WhatsApp channel is missing its Cloud API credentials" } });
          continue;
        }
        const what = describeRequest(request);
        providerId = await sendCloudTemplate(
          { accessToken: decryptSecret(org.api_key) ?? "", phoneNumberId: org.config.phoneNumberId },
          to,
          {
            name: ATTENDANCE_WABA_TEMPLATE,
            language: org.template_language,
            params: [
              row.telecaller_name,
              `${row.kind === "leave" ? "leave" : row.kind === "break" ? "break" : "hours change"}: ${what}${row.reason === "escalation" ? " (still waiting)" : ""}`,
              link,
            ],
          },
          fetchImpl,
        );
      }
      outcomes.push({ id: row.id, outcome: { status: "sent", providerId } });
      sent += 1;
    } catch (err) {
      const e = err instanceof SendError ? err : new SendError((err as Error).message, true);
      const attempts = row.attempts + 1;
      outcomes.push({
        id: row.id,
        outcome:
          e.retryable && attempts < MAX_ATTEMPTS
            ? { status: "retry", error: e.message, attempts }
            : { status: "failed", error: e.message },
      });
    }
  }

  await withOrgContext(orgId, async (client) => {
    for (const o of outcomes) await settle(client, o.id, o.outcome);
  });
  if (sent > 0) console.log(`attendance whatsapp: org ${orgId}: ${sent} sent`);
  return sent;
}

export function startAttendanceWhatsappDrain(): NodeJS.Timeout {
  const interval = Number(process.env.ATTENDANCE_WHATSAPP_INTERVAL_MS ?? 60 * 1000);
  return setInterval(() => {
    void drainAttendanceWhatsapp().catch((err) => console.error("attendance whatsapp drain:", err));
  }, interval);
}
