"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../../actions";
import { apiErrorMessage } from "../../lib/api-error";

/**
 * Replaying rejected events (§8.8).
 *
 * ── BOUNDED, AND THE PAGE SAYS SO ───────────────────────────────────────────
 *
 * The API re-queues at most 5,000 per call and returns how many are left. An
 * unbounded "replay everything" on a tenant with 400,000 rejected rows would
 * hand the drain a backlog that starves live ingestion for an hour - so this
 * returns a count the console turns into a "replay the next batch" button
 * rather than a spinner that never ends.
 */
export async function replayFailedAction(input: {
  resource?: string;
  code?: string;
}): Promise<ActionResult & { requeued?: number; remaining?: number }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/insights/events/replay-failed`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { requeued?: number; remaining?: number };
    revalidatePath("/owner/api-platform/events");
    revalidatePath("/owner/api-platform");
    return { requeued: data.requeued, remaining: data.remaining };
  } catch {
    return { error: "API unreachable" };
  }
}

/** Resolve one unmapped reference, then offer the replay. */
export async function resolveUnmappedAction(
  id: string,
  resolution: "created" | "mapped" | "ignored",
  targetId?: string,
): Promise<ActionResult & { rejectedWaiting?: number }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(
      `${API_URL}/v1/insights/unmapped/${encodeURIComponent(id)}/resolve`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ resolution, targetId }),
        cache: "no-store",
      },
    );
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { rejectedWaiting?: number };
    revalidatePath("/owner/api-platform");
    revalidatePath("/owner/api-platform/events");
    return { rejectedWaiting: data.rejectedWaiting };
  } catch {
    return { error: "API unreachable" };
  }
}
