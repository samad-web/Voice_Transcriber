"use server";

import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import type { OwnerCallDetail } from "../types";

/**
 * One call in full, for the drawer.
 *
 * Fetched on open rather than with the list: a transcript is unbounded text and
 * the table shows 50 rows, so carrying them all would make the page pay for
 * every conversation to render one panel.
 *
 * The 403 gets its own sentence because it is not a failure - `call_intel` is
 * off for this instance - and "API 403" would send a manager to support to be
 * told something this message could have said itself.
 */
export async function fetchOwnerCallAction(
  callId: string,
): Promise<{ detail?: OwnerCallDetail; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/calls/${callId}`, {
      headers,
      cache: "no-store",
    });
    if (res.status === 403) {
      return { error: "Call intelligence is not enabled for this instance." };
    }
    if (!res.ok) return { error: `API ${res.status}` };
    return { detail: (await res.json()) as OwnerCallDetail };
  } catch {
    return { error: "API unreachable" };
  }
}
