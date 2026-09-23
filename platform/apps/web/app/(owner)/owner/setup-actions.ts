"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "./actions";
import { apiErrorMessage } from "./lib/api-error";

/**
 * "Don't show this again" - retire the setup checklist without finishing it.
 *
 * OWNER only on the API side (`@RequireOwnerRole("owner")` on the dismiss
 * route), because it silences a notice for the whole tenant permanently. The
 * console hides the control from a manager rather than letting them press it
 * and collect a 403, but the guard is what actually decides.
 *
 * Revalidates the layout path: `setup_completed_at` is read from the principal
 * the owner layout resolves, so the banner only disappears once that render is
 * thrown away.
 */
export async function dismissSetupAction(): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/setup/dismiss`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    // `layout` rather than `page`: the checklist lives in the owner layout, and
    // revalidating a single page would leave the banner on every other route.
    revalidatePath("/owner", "layout");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

/** One POST/DELETE against the setup guide's routes (doc 27 §7.5). */
async function guideCall(path: string, method: "POST" | "DELETE"): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}${path}`, { method, headers, cache: "no-store" });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    // The sidebar meter is drawn by the owner LAYOUT, so the whole route group
    // re-renders - not just /owner/get-started.
    revalidatePath("/owner", "layout");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Skip an optional setup step: it leaves the guide's "X of N". The API refuses
 * a required step (409) and an unknown one (404); the id is only ever one the
 * page rendered from the catalogue.
 */
export async function skipSetupStepAction(stepId: string): Promise<{ error?: string }> {
  return guideCall(`/v1/owner/setup/steps/${encodeURIComponent(stepId)}/skip`, "POST");
}

/** Undo a skip. */
export async function unskipSetupStepAction(stepId: string): Promise<{ error?: string }> {
  return guideCall(`/v1/owner/setup/steps/${encodeURIComponent(stepId)}/skip`, "DELETE");
}

/** "Hide this guide" - owner only, enforced by the API. */
export async function dismissGuideAction(): Promise<{ error?: string }> {
  return guideCall("/v1/owner/setup/guide/dismiss", "POST");
}

/** Bring a hidden guide back - owner only, enforced by the API. */
export async function reopenGuideAction(): Promise<{ error?: string }> {
  return guideCall("/v1/owner/setup/guide/reopen", "POST");
}
