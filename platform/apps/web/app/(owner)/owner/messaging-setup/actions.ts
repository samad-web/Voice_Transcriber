"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

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
 * Solution Provider) - never Meta directly. `apiKey` is the Hub API key
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
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/messaging-setup");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Pastes in the forward_secret Wasi's admin panel shows once its
 * "CRM Inbound Forwarding" section is saved for this client - there is no
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

/**
 * Connect one of Meta's three surfaces (migration 0098).
 *
 * ── WHY THIS IS ONE ACTION AND NOT THREE ────────────────────────────────────
 *
 * WABA, Instagram and Messenger differ in exactly two fields - which id
 * identifies the sender, and which channel the messages are filed under - and
 * are identical in everything else: the same access token, the same webhook,
 * the same signature. Three near-copies would drift on the shared nine tenths.
 *
 * The `verifyToken` is generated here rather than typed. It is a value the
 * tenant has to paste into Meta and never needs to remember, and asking a
 * person to invent a secret produces "test123" often enough to matter.
 */
export async function createMetaChannelAction(input: {
  kind: "waba" | "instagram" | "facebook";
  inboundAddress: string;
  displayName: string;
  accessToken: string;
  /** WABA: the phone number id. Instagram/Messenger: the page id. */
  senderId: string;
  /** WABA only: the business account id, for reading approved templates. */
  businessAccountId?: string;
  verifyToken: string;
}): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  const channel = input.kind === "waba" ? "whatsapp" : input.kind;
  // `waba` and `meta` as providers, not one name: they are different APIs with
  // different payload shapes on the send side, and the webhook handler
  // branches on exactly this.
  const provider = input.kind === "waba" ? "waba" : "meta";
  const config =
    input.kind === "waba"
      ? {
          phoneNumberId: input.senderId,
          businessAccountId: input.businessAccountId,
          verifyToken: input.verifyToken,
        }
      : input.kind === "instagram"
        ? { igUserId: input.senderId, pageId: input.senderId, verifyToken: input.verifyToken }
        : { pageId: input.senderId, verifyToken: input.verifyToken };

  try {
    const res = await fetch(`${API_URL}/v1/messaging/channels`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({
        channel,
        provider,
        inboundAddress: input.inboundAddress,
        displayName: input.displayName,
        apiKey: input.accessToken,
        config,
      }),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/messaging-setup");
    revalidatePath("/owner/integrations");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}

/** Pull the approved template list off Meta into `message_templates`. */
export async function syncWabaTemplatesAction(
  channelId: string,
): Promise<{ synced?: number; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/channels/${channelId}/templates/sync`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const body = (await res.json()) as { synced?: number };
    revalidatePath("/owner/messaging-setup");
    return { synced: body.synced ?? 0 };
  } catch {
    return { error: "API unreachable" };
  }
}
