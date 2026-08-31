"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Meta Lead Ads connect (Kailash gap Milestone 4).
 *
 * Same shape as connections/actions.ts: the tenant is re-resolved from the
 * session inside `ownerHeaders()`, never trusted from the caller.
 */

export interface MetaConnectResult {
  authorizeUrl?: string;
  error?: string;
  /**
   * True when the API answered 503 - META_APP_ID/META_APP_SECRET/
   * META_OAUTH_REDIRECT_URI are unset on this deployment. Reported as its own
   * flag rather than folded into `error` so the client can show a plain
   * "ask your platform admin" message instead of a raw API string.
   */
  notConfigured?: boolean;
}

/** Mint a Facebook OAuth consent URL. The caller sends the browser there. */
export async function startMetaConnectAction(): Promise<MetaConnectResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/meta/oauth/start`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (res.status === 503) return { notConfigured: true };
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { authorizeUrl: string };
    return { authorizeUrl: data.authorizeUrl };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * The MCP route (migration 0074) - an alternative to the OAuth flow above.
 *
 * Unlike OAuth, this needs no app review and no public callback URL, which is
 * why it is offered alongside rather than instead: an org that cannot get
 * through Meta's app review can still pull its lead ads in.
 */

export interface McpConnection {
  id: string;
  provider: string;
  label: string | null;
  server_url: string;
  status: "connected" | "error" | "revoked";
  last_error: string | null;
  server_info: { name?: string; version?: string };
  tools: Array<{ name: string; description?: string }>;
  last_sync_at: string | null;
}

export interface McpCapabilities {
  canFetchLeads: boolean;
  leadTool: string | null;
  toolCount: number;
}

export async function connectMetaMcpAction(input: {
  serverUrl: string;
  accessToken?: string | null;
  label?: string | null;
}): Promise<{ connection?: McpConnection; capabilities?: McpCapabilities; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/mcp/connections`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ provider: "meta", ...input }),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as {
      connection: McpConnection;
      capabilities: McpCapabilities;
    };
    revalidatePath("/owner/meta-ads");
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

export async function testMcpConnectionAction(
  id: string,
): Promise<{ ok?: boolean; connection?: McpConnection; capabilities?: McpCapabilities; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/mcp/connections/${id}/test`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as {
      ok: boolean;
      error: string | null;
      connection: McpConnection;
      capabilities: McpCapabilities;
    };
    revalidatePath("/owner/meta-ads");
    // A reachable server that failed its handshake is not an action error -
    // the call succeeded and the answer is "no". Surfaced through `ok` so the
    // client can show the server's own reason.
    return { ok: data.ok, connection: data.connection, capabilities: data.capabilities, error: data.error ?? undefined };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function disconnectMcpAction(id: string): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/mcp/connections/${id}`, {
      method: "DELETE",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/meta-ads");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
