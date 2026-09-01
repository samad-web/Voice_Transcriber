"use server";

import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import type { CallNote, OwnerCallDetail } from "../types";

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


/**
 * The notes on one call.
 *
 * Its own round trip rather than a field on the detail response: notes are
 * written while the drawer is open and have to be re-read after a write, and
 * folding them into the detail would mean re-fetching the transcript to see a
 * sentence somebody just typed.
 */
export async function fetchOwnerCallNotesAction(
  callId: string,
): Promise<{ notes?: CallNote[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/calls/${callId}/notes`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    return { notes: ((await res.json()) as { notes: CallNote[] }).notes };
  } catch {
    return { error: "API unreachable" };
  }
}

/** Add one note. Returns the created row so the caller can render it at once. */
export async function addOwnerCallNoteAction(
  callId: string,
  body: string,
): Promise<{ note?: CallNote; error?: string }> {
  const text = body.trim();
  if (!text) return { error: "Write something first" };

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/calls/${callId}/notes`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: text }),
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    return { note: (await res.json()) as CallNote };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * A short-lived playback URL for the recording.
 *
 * The 403 is spelled out because it is the commonest answer and it is not a
 * fault: this account's membership has no `recordings_listen` grant. "API 403"
 * would send someone to support to be told what this sentence already says.
 */
export async function fetchOwnerCallAudioAction(
  callId: string,
): Promise<{ url?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/calls/${callId}/audio`, {
      headers,
      cache: "no-store",
    });
    if (res.status === 403) {
      return { error: "Your account cannot play call recordings." };
    }
    if (res.status === 404) return { error: "No recording stored for this call." };
    if (!res.ok) return { error: `API ${res.status}` };
    return { url: ((await res.json()) as { url: string }).url };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Re-run the pipeline for one call.
 *
 * The 409 is passed through in the API's own words rather than flattened to a
 * generic failure: it names the status the call is actually in, which is the
 * one thing that tells a reader "it is still working, wait" instead of
 * "something broke". 403 means manager rather than owner - reprocessing spends
 * money, so the API keeps it to the account holder.
 */
export async function reprocessOwnerCallAction(
  callId: string,
): Promise<{ status?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/calls/${callId}/reprocess`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (res.status === 403) {
      return { error: "Only the account owner can reprocess a call." };
    }
    if (res.status === 409) {
      const detail = (await res.json().catch(() => null)) as { message?: string } | null;
      return { error: detail?.message ?? "This call is still being processed." };
    }
    if (!res.ok) return { error: `API ${res.status}` };
    return { status: ((await res.json()) as { status: string }).status };
  } catch {
    return { error: "API unreachable" };
  }
}
