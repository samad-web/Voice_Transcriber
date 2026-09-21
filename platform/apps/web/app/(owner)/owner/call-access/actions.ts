"use server";

import { revalidatePath } from "next/cache";
import { validateCallAccessWindow } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";

/**
 * Deciding whether the vendor may hear this business's calls (migration 0122).
 *
 * ── THE PERSONA CHECK HERE IS A COURTESY, NOT THE CONTROL ─────────────────
 *
 * Unlike `../transcription/actions.ts`, the API can and does refuse on its
 * own: `/v1/owner/call-access/*` carries `@RequireOwnerRole("owner")`, and
 * `OwnerRoleGuard` resolves the persona from `memberships` rather than from
 * anything the caller asserts. So a manager invoking these actions directly
 * gets a 403 from the API whatever this file does.
 *
 * The checks below therefore exist to produce a sentence instead of an
 * `API 403`, and removing one would be a downgrade in manners rather than a
 * privilege escalation. That is the opposite of the transcription actions, and
 * the difference is worth stating because the two files look alike.
 */

export async function approveCallAccessAction(
  requestId: string,
  grantedStart: string,
  grantedEnd: string,
): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can grant access to this organisation's call recordings." };
  }

  // Checked here so a bad window comes back as a sentence rather than as a
  // constraint violation from Postgres. The database remains the authority -
  // 0122's `call_access_window_is_bounded` refuses the same thing.
  const window = validateCallAccessWindow(grantedStart, grantedEnd);
  if (!window.ok) return { error: window.message };

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/call-access/${requestId}/approve`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ grantedStart, grantedEnd }),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "Could not reach the server." };
  }

  revalidatePath("/owner/call-access");
  return {};
}

export async function denyCallAccessAction(requestId: string): Promise<ActionResult> {
  return simplePost(requestId, "deny", "decline");
}

export async function revokeCallAccessAction(requestId: string): Promise<ActionResult> {
  return simplePost(requestId, "revoke", "withdraw");
}

async function simplePost(
  requestId: string,
  action: "deny" | "revoke",
  verb: string,
): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: `Only an Owner can ${verb} access to this organisation's call recordings.` };
  }
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/call-access/${requestId}/${action}`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "Could not reach the server." };
  }

  revalidatePath("/owner/call-access");
  return {};
}

/**
 * The gate itself, and who is alerted.
 *
 * Both fields are sent every time and neither is defaulted, matching the API's
 * schema: a PUT that omitted `gateEnabled` and silently received `false` would
 * turn a change of designated administrator into switching the protection off.
 */
export async function updateCallAccessSettingsAction(settings: {
  gateEnabled: boolean;
  designatedAdminUserId: string | null;
}): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can change these settings." };
  }
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/call-access/settings`, {
      method: "PUT",
      headers,
      cache: "no-store",
      // Built from named fields, never a spread of the caller's object.
      body: JSON.stringify({
        gateEnabled: settings.gateEnabled,
        designatedAdminUserId: settings.designatedAdminUserId,
      }),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "Could not reach the server." };
  }

  revalidatePath("/owner/call-access");
  return {};
}
