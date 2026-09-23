"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * The store's own actions - only the ones no legacy page had, because the
 * store REUSES every existing action rather than wrapping it again (doc 28
 * P3: one implementation, many doors). Pausing a lead source is still
 * `updateLeadSourceAction`; switching a number off is still
 * `setChannelStatusAction`.
 *
 * What is new here is the half of two OAuth flows that had an API route and no
 * caller (LinkedIn's account choice and disconnect), and the half that did not
 * exist at all (Meta's page choice, its pending read, and its disconnect).
 */

async function call<T>(
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<{ data?: T; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in to this workspace" };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers,
      cache: "no-store",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    return { data: (await res.json()) as T };
  } catch {
    return { error: "The platform API did not answer. Try again in a moment." };
  }
}

/** Everything a connection change can move: the store, every app page, and the pages behind the doors. */
function touched(...extra: string[]) {
  revalidatePath("/owner/integrations", "layout");
  for (const path of extra) revalidatePath(path);
}

/* ── LinkedIn ────────────────────────────────────────────────────────────── */

export interface LinkedInAdAccount {
  urn: string;
  name: string | null;
}

/** The ad accounts a just-signed-in LinkedIn connection can read. */
export async function linkedinAccountsAction(connectionId: string) {
  return call<{ accounts: LinkedInAdAccount[] }>(`/v1/linkedin/connections/${connectionId}/accounts`);
}

export async function linkedinChooseAccountAction(connectionId: string, account: LinkedInAdAccount) {
  const result = await call<{ ok: true }>(`/v1/linkedin/connections/${connectionId}/account`, {
    method: "POST",
    body: { accountUrn: account.urn, accountName: account.name ?? undefined },
  });
  if (result.data) touched("/owner/lead-sources");
  return result;
}

export async function linkedinDisconnectAction(connectionId: string) {
  const result = await call<{ ok: true }>(`/v1/linkedin/connections/${connectionId}/disconnect`, {
    method: "POST",
  });
  if (result.data) touched("/owner/lead-sources");
  return result;
}

/* ── Meta Lead Ads (doc 28 §11.3) ────────────────────────────────────────── */

export interface PendingPage {
  pageId: string;
  name: string;
  /** Already sending leads to this workspace. */
  connected: boolean;
}

/** Page NAMES from a sign-in waiting for its choice - never the tokens. */
export async function metaPendingAction(pendingId: string) {
  return call<{ pages: PendingPage[]; expiresAt: string }>(`/v1/meta/oauth/pending/${pendingId}`);
}

export async function metaChoosePagesAction(pendingId: string, pageIds: string[]) {
  const result = await call<{ connected: { id: string; name: string }[] }>(
    `/v1/meta/oauth/pending/${pendingId}/choose`,
    { method: "POST", body: { pageIds } },
  );
  if (result.data) touched("/owner/meta-ads");
  return result;
}

export async function metaDisconnectPageAction(connectionId: string) {
  const result = await call<{ ok: true; unsubscribed: boolean }>(
    `/v1/meta/connections/${connectionId}/disconnect`,
    { method: "POST" },
  );
  if (result.data) touched("/owner/meta-ads");
  return result;
}
