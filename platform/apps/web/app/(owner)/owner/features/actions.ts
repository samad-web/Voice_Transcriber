"use server";

import { revalidatePath } from "next/cache";
import { FeatureKey } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";

/**
 * Flip one feature switch.
 *
 * ── ONE KEY PER CALL, NOT THE WHOLE BOARD ─────────────────────────────────
 *
 * `PUT /v1/owner/features` merges what it is sent over what is stored, so
 * sending a single key is what keeps two owners on this page at the same time
 * from clobbering each other: the second save cannot revert the first's change
 * to an unrelated feature, because it never mentions it.
 *
 * ── THE AUTHORIZATION IS NOT HERE ─────────────────────────────────────────
 *
 * The `owner`-only check is a courtesy that turns an API 403 into a sentence.
 * The control is `@RequireOwnerRole("owner")` on the route, resolved from
 * `memberships` rather than from anything this tier asserts.
 */
export async function setFeatureAction(key: string, enabled: boolean): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can change which features this workspace uses." };
  }

  // Parsed rather than forwarded, so an unknown key is refused here with a
  // readable message instead of coming back as an API issue array.
  const parsed = FeatureKey.safeParse(key);
  if (!parsed.success) return { error: `"${key}" is not a feature` };

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/features`, {
      method: "PUT",
      headers,
      cache: "no-store",
      body: JSON.stringify({ features: { [parsed.data]: enabled } }),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/features");
  // The sidebar is built from the resolved feature set, so a change here alters
  // the rail for everybody in the workspace. Revalidating the layout's own path
  // is what makes that land on the next navigation rather than on a hard reload.
  revalidatePath("/owner");
  return {};
}
