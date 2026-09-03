"use server";

import { revalidatePath } from "next/cache";
import { OwnerRole } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";

/**
 * Change a colleague's persona, and/or which telecaller identity they are.
 *
 * ── EVERY ARGUMENT HERE IS UNTRUSTED ──────────────────────────────────────
 *
 * A server action is a public endpoint. The `userId` below arrives from the
 * browser and a caller can send any uuid they like; what they cannot do is
 * choose which ORG it is applied in, because the tenant is re-resolved from
 * the verified session by `ownerHeaders()` and never passed in. That is the
 * same rule every other action in this console follows (see ../actions.ts).
 *
 * ── AND THE AUTHORIZATION IS NOT HERE ─────────────────────────────────────
 *
 * The `owner`-only check below is a courtesy, not the control. It exists so a
 * manager who somehow reaches the page gets a sentence instead of a raw "API
 * 403", and so the round trip is skipped. The real gate is
 * `@RequireOwnerRole("owner")` on `PATCH /v1/owner/team/:userId`, which reads
 * the persona from `memberships` rather than from anything this tier asserts -
 * so deleting these four lines would change the error message and nothing else.
 *
 * Deliberately worth stating, because a check in a server action LOOKS like
 * enforcement and a future reader could reasonably move the API's guard on the
 * strength of it.
 */
export async function setTeamMemberAction(
  userId: string,
  update: { ownerRole?: string; telecallerId?: string | null },
): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can change who does what here." };
  }

  // Parsed rather than forwarded: an unrecognised persona should be refused
  // here with a readable message, not sent on to trip a zod error in the API
  // and come back as an issue array.
  const body: { ownerRole?: string; telecallerId?: string | null } = {};
  if (update.ownerRole !== undefined) {
    const parsed = OwnerRole.safeParse(update.ownerRole);
    if (!parsed.success) return { error: `"${update.ownerRole}" is not a role` };
    body.ownerRole = parsed.data;
  }
  if (update.telecallerId !== undefined) body.telecallerId = update.telecallerId || null;
  if (Object.keys(body).length === 0) return { error: "Nothing to change" };

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/team/${userId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  // The sidebar itself is built from the persona, so a change here can alter
  // what the person who made it can see. Revalidating the layout's own path
  // rather than only this page is what makes that take effect immediately
  // instead of on the next hard navigation.
  revalidatePath("/owner/team");
  revalidatePath("/owner");
  return {};
}

/**
 * Provision a colleague's login.
 *
 * Unlike `setTeamMemberAction`'s persona check, the owner-only rule here IS
 * enforced by the API too - `POST /v1/owner/team` carries
 * `@RequireOwnerRole("owner")`, and `OwnerRoleGuard` resolves the persona from
 * `memberships` rather than from anything this tier asserts. The check below
 * is the courtesy that turns a raw 403 into a sentence.
 *
 * The generated password comes BACK to the caller rather than going to the new
 * person's inbox. Nothing here emails anybody: the owner reads the password out
 * or sends it however they already talk to their colleague, and the platform
 * stays out of a stranger's mailbox.
 */
export async function inviteTeamMemberAction(input: {
  email: string;
  name?: string;
  ownerRole: string;
  telecallerId?: string | null;
  recordingsListen?: boolean;
}): Promise<ActionResult & { password?: string | null; linkedExisting?: boolean }> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can add people." };
  }

  const role = OwnerRole.safeParse(input.ownerRole);
  if (!role.success) return { error: `"${input.ownerRole}" is not a role` };

  const email = input.email.trim();
  if (!email) return { error: "An email address is required." };

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/team`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({
        email,
        name: input.name?.trim() || undefined,
        ownerRole: role.data,
        telecallerId: input.telecallerId || null,
        recordingsListen: input.recordingsListen ?? false,
      }),
    });
    if (!res.ok) return { error: await errorText(res) };
    const body = (await res.json()) as { password?: string | null; linkedExisting?: boolean };
    revalidatePath("/owner/team");
    revalidatePath("/owner");
    return { password: body.password ?? null, linkedExisting: body.linkedExisting ?? false };
  } catch {
    return { error: "The platform API did not answer." };
  }
}

/** A fresh password, shown once. Owner only, enforced by the API. */
export async function resetTeamPasswordAction(
  userId: string,
): Promise<ActionResult & { password?: string }> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can reset a password." };
  }

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/team/${userId}/password`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await errorText(res) };
    const body = (await res.json()) as { password: string };
    return { password: body.password };
  } catch {
    return { error: "The platform API did not answer." };
  }
}

/**
 * Remove somebody's access to this workspace.
 *
 * The API refuses the last owner and refuses self-removal; both come back as
 * readable messages rather than being pre-empted here, so the console can
 * never disagree with the rule the server actually applies.
 */
export async function removeTeamMemberAction(userId: string): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can remove people." };
  }

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/team/${userId}`, {
      method: "DELETE",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/team");
  revalidatePath("/owner");
  return {};
}
