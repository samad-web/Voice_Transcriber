"use server";

import { revalidatePath } from "next/cache";
import { StaffStatus } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";

/**
 * The staff-record writes: employment details, suspension, permission role.
 *
 * ── WHERE THE AUTHORIZATION ACTUALLY IS ───────────────────────────────────
 *
 * Not here. Every `owner`-only check below is a courtesy that turns a raw API
 * 403 into a sentence and skips a round trip; the control is
 * `@RequireOwnerRole("owner")` on each route, which resolves the persona from
 * `memberships` rather than from anything this tier asserts. Deleting these
 * checks would change the error message and nothing else.
 *
 * Worth stating on every one of them, because a check in a server action LOOKS
 * like enforcement, and a future reader could reasonably move the API's guard
 * on the strength of it. `/v1/org/policy` is the counter-example in this
 * codebase where the server action IS the only gate - these are not that.
 *
 * The `userId` arrives from the browser and a caller may send any uuid; what
 * they cannot choose is the ORG it lands in, because the tenant is re-resolved
 * from the verified session by `ownerHeaders()` and never passed in.
 */

async function ownerOnly(): Promise<{ headers: HeadersInit } | { error: string }> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can change this." };
  }
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  return { headers };
}

/** Employee code, job title and phone - see migration 0102. */
export async function setStaffProfileAction(
  userId: string,
  fields: { staffCode?: string; jobTitle?: string; phone?: string },
): Promise<ActionResult> {
  const gate = await ownerOnly();
  if ("error" in gate) return gate;

  // Empty string is sent as `null`, not omitted. Omitting would mean "leave it
  // alone", and there would then be no way to CLEAR a code somebody typed by
  // mistake - the input would render empty and the value would still be there.
  const body = {
    staffCode: fields.staffCode?.trim() ? fields.staffCode.trim() : null,
    jobTitle: fields.jobTitle?.trim() ? fields.jobTitle.trim() : null,
    phone: fields.phone?.trim() ? fields.phone.trim() : null,
  };

  try {
    const res = await fetch(`${API_URL}/v1/owner/team/${userId}/profile`, {
      method: "PATCH",
      headers: gate.headers,
      cache: "no-store",
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/staff");
  return {};
}

/**
 * Suspend somebody's access, or put it back.
 *
 * Two routes rather than one PATCH with a value, matching the API: they are
 * different acts with different guards - suspension goes through the
 * last-owner check, reinstatement never does, because it only ever widens.
 */
export async function setStaffStatusAction(userId: string, status: string): Promise<ActionResult> {
  const gate = await ownerOnly();
  if ("error" in gate) return gate;

  const parsed = StaffStatus.safeParse(status);
  if (!parsed.success) return { error: `"${status}" is not a staff status` };

  try {
    const res = await fetch(
      `${API_URL}/v1/owner/team/${userId}/${parsed.data === "suspended" ? "suspend" : "reinstate"}`,
      { method: "POST", headers: gate.headers, cache: "no-store" },
    );
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/staff");
  // The suspended person's own sidebar is built from a membership that no
  // longer resolves, so the layout has to be revalidated too - otherwise a
  // cached shell would keep rendering for them until their next hard
  // navigation.
  revalidatePath("/owner");
  return {};
}

/** Assign the permission role whose grid applies (0039's `memberships.role_id`). */
export async function assignStaffRoleAction(
  userId: string,
  roleId: string | null,
): Promise<ActionResult> {
  const gate = await ownerOnly();
  if ("error" in gate) return gate;

  try {
    const res = await fetch(`${API_URL}/v1/owner/team/${userId}/role`, {
      method: "PUT",
      headers: gate.headers,
      cache: "no-store",
      body: JSON.stringify({ roleId: roleId || null }),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/staff");
  return {};
}
