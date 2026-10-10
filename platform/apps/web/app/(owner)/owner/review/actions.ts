"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * The review queue's opt-out verdicts (migration 0109). The WhatsApp and
 * duplicate verdicts reuse the actions their own pages already call
 * (`whatsapp-leads/actions.ts`, `crm-actions.ts`), so there is one definition
 * of what approving a lead or merging two records sends to the API.
 *
 * `done: false` with no error means somebody else decided it first - the card
 * is dropped either way, and the console says so rather than showing a failure.
 */

async function verdict(id: string, action: "confirm" | "dismiss"): Promise<ActionResult & { done?: boolean }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/opt-outs/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { confirmed?: boolean; dismissed?: boolean };
    revalidatePath("/owner/review");
    revalidatePath("/owner/inbox");
    return { done: Boolean(data.confirmed ?? data.dismissed) };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function confirmOptOutAction(id: string) {
  return verdict(id, "confirm");
}

export async function dismissOptOutAction(id: string) {
  return verdict(id, "dismiss");
}

// ── §12's call suggestions ────────────────────────────────────────────────
//
// APPROVING DOES NOT MAKE THE CHANGE HERE. It marks the suggestion approved;
// the worker's executor is what runs the tool, inside the same gate check a
// second time. So nothing in this file sends a message, books a slot or
// writes to a lead - which is also why Approve can be a plain POST with no
// confirmation dialog, while a reject needs the reviewer's reason.
//
// The API's own refusals are passed through verbatim. It refuses for reasons a
// person has to act on - the assistant was switched off while the item waited,
// somebody else decided it first, the accuracy gate is not met - and "that did
// not work" would throw away the only sentence that tells them what to do.

interface AgentReviewResult extends ActionResult {
  state?: string;
}

async function review(
  id: string,
  path: string,
  body?: unknown,
): Promise<AgentReviewResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in" };

  try {
    const res = await fetch(
      `${API_URL}/v1/transcript-agent/review/${encodeURIComponent(id)}/${path}`,
      {
        method: "POST",
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      },
    );
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { state?: string };
    revalidatePath("/owner/review");
    // The two screens a decision shows up on: an approved callback lands in
    // the to-call list, and a rejected one leaves it alone.
    revalidatePath("/owner/callbacks");
    return { state: data.state };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function approveAgentActionAction(id: string) {
  return review(id, "approve");
}

/** §12: "edits and rejections store a reason" - required, not optional. */
export async function rejectAgentActionAction(id: string, reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) return { error: "Say briefly why, so the assistant can learn from it." };
  return review(id, "reject", { reason: trimmed });
}

/**
 * §12's Edit: approve, but with the reviewer's own values.
 *
 * The edited params go to the API as they are; it validates them against the
 * tool's own schema and refuses anything the tool would not accept. Validating
 * here as well would be a second, quieter definition of what a tool takes.
 */
export async function editAgentActionAction(
  id: string,
  params: Record<string, unknown>,
  reason: string,
) {
  const trimmed = reason.trim();
  if (!trimmed) return { error: "Say briefly what you changed, so the assistant can learn from it." };
  return review(id, "edit", { params, reason: trimmed });
}

/**
 * §12's bulk approve "for high-confidence similar items".
 *
 * Returns per-item outcomes rather than one verdict: the API decides each one
 * separately through the same path, so some can be refused while the rest go
 * through, and a reviewer who pressed one button needs to know which.
 */
export async function bulkApproveAgentActionsAction(
  ids: string[],
): Promise<ActionResult & { approved?: number; failures?: Array<{ id: string; error: string }> }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in" };
  if (ids.length === 0) return { error: "Nothing selected." };

  try {
    const res = await fetch(`${API_URL}/v1/transcript-agent/review/bulk-approve`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ids }),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as {
      approved?: number;
      results?: Array<{ id: string; ok: boolean; error?: string }>;
    };
    revalidatePath("/owner/review");
    revalidatePath("/owner/callbacks");
    return {
      approved: data.approved ?? 0,
      failures: (data.results ?? [])
        .filter((r) => !r.ok)
        .map((r) => ({ id: r.id, error: r.error ?? "could not be approved" })),
    };
  } catch {
    return { error: "API unreachable" };
  }
}
