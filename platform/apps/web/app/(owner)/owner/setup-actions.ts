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
