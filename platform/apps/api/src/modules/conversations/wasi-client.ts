import { WasiErrorResponse } from "@aura/shared";

/**
 * `WasiSendRequest` minus `client_id` — hand-written rather than
 * `Omit<WasiSendRequest, "client_id">` because `Omit` does not distribute
 * over a union, and collapses the two send shapes into one that's missing
 * both variants' own fields. `sendWasiMessage` supplies `client_id` itself
 * from the channel, so the caller should never need to pass it.
 */
type WasiSendInput =
  | { type: "template"; to: string; template: string; params?: Record<string, string>; headerMediaUrl?: string }
  | { type: "text"; to: string; body: string };

/**
 * Aura as a Hub API CLIENT of Wasi (`C:\Users\mas20\Desktop\work\Wasi`) — the
 * user's own WhatsApp Business Solution Provider platform. This is the
 * outbound half; the inbound half (signature verification, event routing)
 * lives in messaging-webhook.controller.ts.
 */

export interface WasiChannel {
  apiBaseUrl: string;
  /** Decrypted already — callers read this off `decryptSecret(channel.api_key)`. */
  apiKey: string;
  wasiClientId: string;
}

export class WasiSendError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly metaError: unknown,
    public readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface WasiSendResult {
  /** Wasi's `messages` row, `returning *` — the fields this codebase reads are typed below. */
  metaMessageId: string | null;
  status: string;
  raw: unknown;
}

/**
 * `POST /api/v1/messages`. Wasi enforces the real business rules (WABA
 * connected, consent, plan volume cap, 24h session window, template
 * approval) server-side — this is a thin, faithful client, not a
 * reimplementation of that logic. A rejection is surfaced with Wasi's own
 * `code` intact so the caller (whatsapp-send.controller.ts) can react to
 * `session_window_closed` differently from `waba_not_connected`.
 */
export async function sendWasiMessage(
  channel: WasiChannel,
  request: WasiSendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<WasiSendResult> {
  const res = await fetchImpl(`${channel.apiBaseUrl.replace(/\/$/, "")}/api/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${channel.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...request, client_id: channel.wasiClientId }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const parsed = WasiErrorResponse.safeParse(body);
    throw new WasiSendError(
      parsed.success ? parsed.data.error : `Wasi rejected the send (${res.status})`,
      parsed.success ? parsed.data.code : undefined,
      parsed.success ? parsed.data.metaError : undefined,
      res.status,
    );
  }
  const row = body as { meta_message_id?: string | null; status?: string };
  return { metaMessageId: row.meta_message_id ?? null, status: row.status ?? "sent", raw: body };
}

export interface WasiTemplate {
  name: string;
  status: string;
  category?: string;
  language?: string;
}

/**
 * `GET /api/v1/templates` — for the composer's template picker. No client_id
 * on this one (unlike send): the Bearer key alone resolves to exactly one
 * client on Wasi's side, and a template has no separate "who is this for."
 */
export async function listWasiTemplates(channel: WasiChannel, fetchImpl: typeof fetch = fetch): Promise<WasiTemplate[]> {
  const res = await fetchImpl(`${channel.apiBaseUrl.replace(/\/$/, "")}/api/v1/templates`, {
    headers: { authorization: `Bearer ${channel.apiKey}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Wasi rejected the template list request (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as WasiTemplate[];
}
