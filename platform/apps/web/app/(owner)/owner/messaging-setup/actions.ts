"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

export interface MessagingChannel {
  id: string;
  channel: "whatsapp" | "sms" | "email";
  provider: string;
  inbound_address: string;
  display_name: string | null;
  api_base_url: string | null;
  config: Record<string, unknown>;
  status: "active" | "disabled";
  webhook_token: string;
  webhook_path: string;
  last_inbound_at: string | null;
  created_at: string;
}

export async function listChannelsAction(): Promise<{ channels?: MessagingChannel[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/channels`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { channels: MessagingChannel[] };
    return { channels: data.channels };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Creates the org's WhatsApp-via-Wasi channel (Kailash gap Milestone 3).
 * Aura is a Hub API CLIENT of Wasi (the user's own WhatsApp Business
 * Solution Provider) — never Meta directly. `apiKey` is the Hub API key
 * issued for this org's client on Wasi's admin panel; `wasiClientId` is that
 * same client's id.
 */
export async function createWasiChannelAction(input: {
  inboundAddress: string;
  displayName: string;
  apiKey: string;
  apiBaseUrl: string;
  wasiClientId: string;
}): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/channels`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({
        channel: "whatsapp",
        provider: "wasi",
        inboundAddress: input.inboundAddress,
        displayName: input.displayName,
        apiKey: input.apiKey,
        apiBaseUrl: input.apiBaseUrl,
        config: { wasiClientId: input.wasiClientId },
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = (body as { message?: unknown })?.message;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    revalidatePath("/owner/messaging-setup");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Pastes in the forward_secret Wasi's admin panel shows once its
 * "CRM Inbound Forwarding" section is saved for this client — there is no
 * self-serve retrieval on Wasi's side, so this is a one-time manual entry.
 */
export async function setForwardSecretAction(
  channelId: string,
  forwardSecret: string,
): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/channels/${channelId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ forwardSecret }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner/messaging-setup");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function setChannelStatusAction(
  channelId: string,
  status: "active" | "disabled",
): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/channels/${channelId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner/messaging-setup");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}
