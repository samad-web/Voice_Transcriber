"use server";

import { revalidatePath } from "next/cache";
import type { Branding } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

/**
 * Org logo/colors (Kailash gap Milestone 4, migration 0065's `branding` jsonb
 * column on `organizations`). Same shape as the other owner actions: the
 * tenant is re-resolved from the session inside `ownerHeaders()`.
 */

/**
 * The patch body IS the shared `Branding` shape - the same definition
 * tenancy.controller.ts validates the request against. It used to be a
 * hand-written interface here, and had already drifted from the API's Zod
 * object (the colours were `string`, the API accepts null too).
 *
 * Every field is optional and the API merges into the existing jsonb, so a
 * patch carries only what changed. Images clear to `null`, which the API reads
 * as "go back to the default asset"; the colours do the same.
 */
export type BrandingPatch = Branding;

export interface BrandingActionResult {
  error?: string;
}

/**
 * PATCH /org/branding merges into the existing jsonb rather than replacing
 * it, so only the fields the user actually changed need to be sent - see
 * tenancy.controller.ts's `branding || $2::jsonb` update.
 */
export async function updateBrandingAction(patch: BrandingPatch): Promise<BrandingActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/org/branding`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = (body as { message?: unknown })?.message;
      if (Array.isArray(detail)) {
        return { error: detail.map((d: { message?: string }) => d.message ?? "").join("; ") };
      }
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    // The whole route group, not just this page. Branding is applied in the
    // owner LAYOUT now - the mark, the tab title, the favicon and the colour
    // tokens every page inherits - so revalidating only /owner/branding would
    // leave the rest of the console on the old palette until its cache expired.
    revalidatePath("/owner", "layout");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
