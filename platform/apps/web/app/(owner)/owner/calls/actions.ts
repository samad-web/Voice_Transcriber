"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { apiErrorMessage } from "../lib/api-error";
import { ownerHeaders } from "../actions";
import type { CallIssueSummary, CallNote, OwnerCallDetail } from "../types";

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

/*
 * `reprocessOwnerCallAction` stood here until 0147 (doc 36 §2). The route it
 * called - `POST /v1/owner/calls/:id/reprocess` - is gone, and the two that
 * remain are operator-only, so there is deliberately no client-side caller for
 * a reprocess anywhere in this console. A client with a bad transcript reports
 * it; we re-run the call from the escalation queue.
 */

// ── Reporting a problem with a call (0147, doc 36) ───────────────────────────

/**
 * File a report.
 *
 * Every refusal the API can give here is a sentence somebody can act on, so
 * none of them collapse to "API 4xx":
 *   409 - they have already reported this exact problem on this call;
 *   429 - the workspace is at its open-report ceiling;
 *   403 - `call_intel` is off for the instance.
 */
export async function fileCallIssueAction(input: {
  callId: string;
  category: string;
  severity: string;
  description: string;
  atSeconds?: number | null;
}): Promise<{ ref?: number; id?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/call-issues`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        callId: input.callId,
        category: input.category,
        severity: input.severity,
        description: input.description,
        // Omitted rather than null: the API's schema makes it optional, and a
        // null would be a value the zod object has to be taught to tolerate.
        ...(input.atSeconds === null || input.atSeconds === undefined
          ? {}
          : { atSeconds: Math.max(0, Math.round(input.atSeconds)) }),
      }),
    });
    if (res.status === 403) {
      return { error: "Call intelligence is not enabled for this instance." };
    }
    if (res.status === 409 || res.status === 429) {
      return { error: await apiErrorMessage(res) };
    }
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const body = (await res.json()) as { id: string; ref: number };
    // The drawer re-reads its own list, but the call log's row chips and any
    // other view of this call are server-rendered.
    revalidatePath("/owner/calls");
    return { id: body.id, ref: body.ref };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * The reports already filed against one call, for the drawer.
 *
 * Its own round trip, for the same reason the notes are: a report is filed while
 * the drawer is open and the list has to be re-read afterwards, and folding it
 * into the detail response would mean re-fetching the transcript to show a
 * sentence somebody just typed.
 */
export async function fetchCallIssuesAction(
  callId: string,
): Promise<{ reports?: CallIssueSummary[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(
      `${API_URL}/v1/owner/call-issues?state=all&callId=${encodeURIComponent(callId)}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return { error: await apiErrorMessage(res) };
    return { reports: ((await res.json()) as { reports: CallIssueSummary[] }).reports };
  } catch {
    return { error: "API unreachable" };
  }
}

// ── Dispositions (migration 0097) ───────────────────────────────────────────

export interface Disposition {
  id: string;
  key: string;
  label: string;
  lead_quality: "hot" | "medium" | "cold" | null;
  color: string;
  sort_order: number;
  is_active: boolean;
}

/**
 * Record what a person says this call was.
 *
 * The response says whether the lead was re-rated, and the console shows it -
 * because a chip that silently changed a lead's temperature would be a side
 * effect nobody consented to. `null` clears the verdict, and deliberately does
 * NOT put the temperature back: there is nothing to put it back to.
 */
export async function setCallDispositionAction(
  callId: string,
  key: string | null,
): Promise<{ error?: string; leadRerated?: boolean }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/owner/calls/${callId}/disposition`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ key }),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const body = (await res.json()) as { leadRerated?: boolean };
    revalidatePath("/owner/calls");
    return { leadRerated: body.leadRerated };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * A follow-up message drafted from this call by the org's reply drafter
 * (migration 0121). Returns text for the person to copy and edit - it sends
 * nothing, and there is no send path behind it.
 */
export async function draftCallFollowUpAction(callId: string): Promise<{ reply?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/owner/calls/${callId}/draft-reply`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { reply: string };
    return { reply: data.reply };
  } catch {
    return { error: "API unreachable" };
  }
}
