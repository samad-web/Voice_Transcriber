"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../actions";

/**
 * §10A.3's quick actions, as server actions.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE TENANT IS DERIVED, NEVER PASSED IN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `ownerHeaders()` re-resolves the owner from the session on every call. A
 * server action is a public endpoint - anything it accepts as an argument, a
 * caller can forge - so the org and the persona come from the cookie and only
 * the callback id comes from the page. The same contract every other action
 * file in this console has, and its header makes the argument.
 *
 * ── NOTHING HERE DIALS, AND NOTHING HERE SENDS ───────────────────────────
 *
 * "Call now" is a link to the vault's own reveal route, which is gated on
 * `contact_number:view` and audited separately - it is deliberately NOT an
 * action here, because a page that could reveal a customer's number by posting
 * to itself would be a second, ungated door onto the most sensitive single
 * read in the product.
 */

async function post(path: string, body: unknown): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in." };

  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;
    // The API's own sentence, where it has one. These are written for the
    // person reading them - "the assistant was switched off after this was
    // suggested" is a better error than "403", and inventing a generic one
    // here would throw it away.
    return {
      error:
        detail?.message ??
        (response.status === 403
          ? "You cannot change this call-back."
          : "That did not work. Try again."),
    };
  }

  // The list is a server component, so the page has to be told to re-read.
  revalidatePath("/owner/callbacks");
  return {};
}

/** §10A.3's Snooze: 5/15/30 or a custom number of minutes. */
export async function snoozeCallback(id: string, minutes: number): Promise<ActionResult> {
  return post(`/v1/callbacks/${id}/snooze`, { minutes });
}

/** §10A.3's Reschedule. The API clamps it into calling hours and says if it did. */
export async function rescheduleCallback(id: string, dueAt: string): Promise<ActionResult> {
  return post(`/v1/callbacks/${id}/reschedule`, { dueAt });
}

/** §10A.3's Done, "with disposition". */
export async function completeCallback(
  id: string,
  outcome: string,
  notes?: string,
): Promise<ActionResult> {
  return post(`/v1/callbacks/${id}/complete`, { outcome, notes: notes ?? null });
}

/**
 * §10A.3's "Can't reach".
 *
 * `connected: false` - which is what makes this an ATTEMPT rather than a
 * completion, and what stops it being counted as a miss (§10A.5). The API
 * schedules the next try from the org's retry intervals.
 */
export async function recordAttempt(id: string, notes?: string): Promise<ActionResult> {
  return post(`/v1/callbacks/${id}/attempt`, {
    connected: false,
    durationSeconds: 0,
    notes: notes ?? null,
  });
}

/** §10A.3's Reassign. The API refuses unless the caller can see the whole team. */
export async function reassignCallback(
  id: string,
  assignedUserId: string,
  reason: string,
): Promise<ActionResult> {
  return post(`/v1/callbacks/${id}/reassign`, { assignedUserId, reason });
}
