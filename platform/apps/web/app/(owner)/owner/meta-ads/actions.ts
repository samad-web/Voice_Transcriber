"use server";

import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

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
   * True when the API answered 503 — META_APP_ID/META_APP_SECRET/
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
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = (body as { message?: unknown })?.message;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    const data = (await res.json()) as { authorizeUrl: string };
    return { authorizeUrl: data.authorizeUrl };
  } catch {
    return { error: "API unreachable" };
  }
}
