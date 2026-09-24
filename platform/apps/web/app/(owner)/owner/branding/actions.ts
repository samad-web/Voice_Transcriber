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

export interface BrandingUploadUrlResult {
  uploadUrl?: string;
  /** Same-origin, basePath-prefixed - what the form should save as the field's
   *  value once the browser has PUT the file to `uploadUrl`. See the route
   *  handler at app/branding-assets/[orgId]/[filename]/route.ts. */
  assetUrl?: string;
  error?: string;
}

const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

/**
 * Step 1 of an upload: ask the API for a presigned PUT and the path the
 * resulting object will be readable at. The caller PUTs the file straight to
 * `uploadUrl` (never through this server), then saves `assetUrl` into the
 * form the same way a pasted URL would be saved.
 */
export async function getBrandingUploadUrlAction(
  kind: "logo" | "favicon" | "banner" | "sidebarIcon" | "loginBackground",
  contentType: string,
): Promise<BrandingUploadUrlResult> {
  if (!UPLOAD_CONTENT_TYPES[contentType]) {
    return { error: "That file type isn't supported. Use PNG, JPEG, WebP, SVG or ICO." };
  }

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/org/branding/upload-url`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ kind, contentType }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = (body as { message?: unknown })?.message;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    const { uploadUrl, assetPath } = (await res.json()) as { uploadUrl: string; assetPath: string };
    const assetUrl = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${assetPath}`;
    return { uploadUrl, assetUrl };
  } catch {
    return { error: "API unreachable" };
  }
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
