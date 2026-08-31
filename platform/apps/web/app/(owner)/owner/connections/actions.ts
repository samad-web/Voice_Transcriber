"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Email/calendar connection actions (PRD Layer 1).
 *
 * Same shape as the other owner actions: the tenant AND the acting user are
 * re-resolved from the session inside `ownerHeaders()` rather than accepted as
 * arguments, which matters more here than anywhere else — the user id is what
 * decides whose mailbox a token gets attached to.
 */

export interface ConnectionActionResult {
  error?: string;
}

/** Mint an authorize URL. The caller sends the browser there. */
export async function startOAuthAction(
  provider: string,
): Promise<ConnectionActionResult & { authorizeUrl?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/connections/oauth/start`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ provider, redirectPath: "/owner/connections" }),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { authorizeUrl: string };
    return { authorizeUrl: data.authorizeUrl };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function connectBasicAction(input: {
  provider: string;
  accountEmail: string;
  displayName?: string;
  config: Record<string, string>;
}): Promise<ConnectionActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/connections`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/connections");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export async function disconnectAction(id: string): Promise<ConnectionActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/connections/${id}`, {
      method: "DELETE",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/connections");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
