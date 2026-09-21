"use server";

import { revalidatePath } from "next/cache";
import type { ChannelProbeOutcome } from "@aura/shared";
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
  /**
   * The OPERATOR SWITCH, not a health signal. This page rendered it as one for
   * a while and that is the defect migration 0099 addresses: a channel with a
   * wrong key and a channel with no forward secret both read "active" here and
   * neither can carry a message. Feed the fields below to `readChannel()`
   * instead and render what it returns.
   */
  status: "active" | "disabled";
  webhook_token: string;
  webhook_path: string;
  last_inbound_at: string | null;
  created_at: string;

  /* ── What readChannel() needs (0099) ───────────────────────────────────── */
  /** Booleans, never the values - the secrets stay in the database. */
  has_api_key: boolean;
  has_forward_secret: boolean;
  last_probe_at: string | null;
  last_probe_outcome: ChannelProbeOutcome | null;
  last_probe_detail: string | null;
}

/**
 * Try a channel's credentials against the provider and record the result.
 *
 * Always resolves with a verdict rather than an error when the PROBE fails -
 * a refused key is the answer, not a failure of the request. Only an
 * unreachable Aura API is an error here.
 */
export async function verifyChannelAction(
  channelId: string,
): Promise<{ channel?: MessagingChannel; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/channels/${channelId}/verify`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { channel: MessagingChannel };
    revalidatePath("/owner/messaging-setup");
    return { channel: data.channel };
  } catch {
    return { error: "API unreachable" };
  }
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

/* ── WhatsApp Embedded Signup ────────────────────────────────────────────── */

export interface EmbeddedSignupConfig {
  provider: string;
  providerIsWasi: boolean;
  metaConfigured: boolean;
  hasHubCredentials: boolean;
  ready: boolean;
  /** Meta's public app + login-config ids. Null unless this deployment has them. */
  appId: string | null;
  configId: string | null;
  connected: boolean;
  connectedNumber: string | null;
}

/**
 * What the connect button needs to know before it renders.
 *
 * Returns a fully "not ready" shape rather than an error when the API is
 * unreachable: the page around this still has a credentials form that works,
 * and a whole screen replaced by "API 500" because one optional panel could
 * not load would be a worse failure than a disabled button.
 */
export async function embeddedSignupConfigAction(): Promise<EmbeddedSignupConfig> {
  const offline: EmbeddedSignupConfig = {
    provider: "none",
    providerIsWasi: false,
    metaConfigured: false,
    hasHubCredentials: false,
    ready: false,
    appId: null,
    configId: null,
    connected: false,
    connectedNumber: null,
  };

  const headers = await ownerHeaders();
  if (!headers) return offline;
  try {
    const res = await fetch(`${API_URL}/v1/messaging/embedded-signup`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return offline;
    return (await res.json()) as EmbeddedSignupConfig;
  } catch {
    return offline;
  }
}

/**
 * Hand a completed Facebook signup to the API.
 *
 * The `code` crosses one more boundary here and then stops: the API forwards it
 * to Wasi, which is the only party holding the Meta app secret that can redeem
 * it. Nothing on this side stores it.
 */
export async function completeEmbeddedSignupAction(input: {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  viaCoexistence: boolean;
}): Promise<{ connected?: boolean; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/embedded-signup`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/messaging-setup");
    return { connected: true };
  } catch {
    return { error: "Could not reach the API." };
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
