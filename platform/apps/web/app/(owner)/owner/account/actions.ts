"use server";

import { revalidatePath } from "next/cache";
import type { BusinessProfile } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { getSessionUser } from "@/lib/supabase/server";
import { verifyCurrentPassword } from "@/lib/verify-password";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * The owner console's own-account actions (doc 27 §4).
 *
 * Every one of them names the caller through `ownerHeaders()`, which sets
 * `x-caller-user-id` from the verified session. None takes a user id as an
 * argument, so none can be pointed at somebody else.
 */

export interface AccountActionResult {
  error?: string;
  /** Field-level messages from the API's validation, keyed by field name. */
  fieldErrors?: Record<string, string>;
}

/** Zod issues from the API, as `{ field: message }` for the form. */
async function failure(res: Response): Promise<AccountActionResult> {
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { message?: unknown };
  if (Array.isArray(body.message)) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of body.message as Array<{ path?: unknown[]; message?: string }>) {
      const field = String(issue.path?.[0] ?? "");
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message ?? "Check this field.";
    }
    if (Object.keys(fieldErrors).length) return { fieldErrors, error: "Some fields need attention." };
  }
  return { error: await apiErrorMessage(res) };
}

async function send(path: string, method: "PATCH" | "PUT", body: unknown): Promise<Response | AccountActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in to a workspace." };
  try {
    return await fetch(`${API_URL}${path}`, { method, headers, cache: "no-store", body: JSON.stringify(body) });
  } catch {
    return { error: "API unreachable" };
  }
}

/** Your name, shown to your team in every workspace you belong to. */
export async function updateNameAction(name: string): Promise<AccountActionResult> {
  const res = await send("/v1/account/profile", "PATCH", { name });
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res);
  // The account menu reads the name from the principal the LAYOUT resolves.
  revalidatePath("/owner", "layout");
  return {};
}

/**
 * Your phone in this workspace - where call-access approval codes are sent
 * (0122), so it needs your current password, checked against the sign-in
 * service before anything is written. The API audits the change.
 *
 * With auth unconfigured (local dev only) there is no password to check and
 * the check is skipped: that mode has no sessions and no real people.
 */
export async function updatePhoneAction(input: { phone: string; password: string }): Promise<AccountActionResult> {
  if (AUTH_ENABLED) {
    const user = await getSessionUser();
    if (!user?.email) return { error: "You're not signed in." };
    if (!input.password) return { fieldErrors: { password: "Enter your current password." }, error: "Enter your current password." };
    const verified = await verifyCurrentPassword({ id: user.id, email: user.email }, input.password);
    if (!verified.ok) return { fieldErrors: { password: verified.error }, error: verified.error };
  }

  const res = await send("/v1/account/phone", "PATCH", { phone: input.phone.trim() || null });
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res);
  revalidatePath("/owner/account/profile");
  return {};
}

/** The whole business profile form, as one PUT. Owner only - the API decides. */
export async function saveBusinessProfileAction(
  input: Record<string, unknown>,
): Promise<AccountActionResult & { profile?: BusinessProfile }> {
  const res = await send("/v1/owner/business-profile", "PUT", input);
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res);
  const body = (await res.json().catch(() => ({}))) as { profile?: BusinessProfile };
  // The display name is the sidebar heading and the tenant switcher's label,
  // both drawn by the layout.
  revalidatePath("/owner", "layout");
  return { profile: body.profile };
}

/**
 * The workspace clock (Build docs/30). Owner OR manager - the API decides,
 * through OwnerRoleGuard on time-settings.controller.ts. Every time in the
 * console, and where every "today" begins, is read from the zone the LAYOUT
 * resolves, so the whole layout is revalidated rather than this page.
 */
export async function saveTimeZoneAction(
  timezone: string,
): Promise<AccountActionResult & { timezone?: string; changed?: boolean }> {
  const res = await send("/v1/owner/time-settings", "PUT", { timezone });
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res);
  const body = (await res.json().catch(() => ({}))) as { timezone?: string; changed?: boolean };
  revalidatePath("/owner", "layout");
  return { timezone: body.timezone, changed: body.changed };
}

/**
 * The workspace's country and currency (Time & location). Owner only - the
 * API decides. The country is where every phone field in the console starts,
 * and the layout carries it, so the whole layout is revalidated.
 */
export async function saveRegionAction(input: {
  country: string;
  currency: string;
}): Promise<AccountActionResult & { country?: string; currency?: string; changed?: boolean }> {
  const res = await send("/v1/owner/time-settings/region", "PUT", input);
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res);
  const body = (await res.json().catch(() => ({}))) as { country?: string; currency?: string; changed?: boolean };
  revalidatePath("/owner", "layout");
  return { country: body.country, currency: body.currency, changed: body.changed };
}
