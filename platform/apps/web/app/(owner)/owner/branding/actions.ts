"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

/**
 * Org logo/colors (Kailash gap Milestone 4, migration 0065's `branding` jsonb
 * column on `organizations`). Same shape as the other owner actions: the
 * tenant is re-resolved from the session inside `ownerHeaders()`.
 */

export interface BrandingPatch {
  logoUrl?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  browserTitle?: string;
}

export interface BrandingActionResult {
  error?: string;
}

/**
 * PATCH /org/branding merges into the existing jsonb rather than replacing
 * it, so only the fields the user actually changed need to be sent — see
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
    revalidatePath("/owner/branding");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
