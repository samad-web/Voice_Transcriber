"use server";

import { revalidatePath } from "next/cache";
import { OwnerRole } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";
import type { IssuedInvite } from "./types";

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
  revalidatePath("/owner/staff");
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
  /** Mobile and WhatsApp (0102's phone, 0135's whatsapp_number). */
  phone?: string | null;
  whatsapp?: string | null;
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
        phone: input.phone?.trim() || null,
        whatsapp: input.whatsapp?.trim() || null,
      }),
    });
    if (!res.ok) return { error: await errorText(res) };
    const body = (await res.json()) as { password?: string | null; linkedExisting?: boolean };
    revalidatePath("/owner/staff");
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

  revalidatePath("/owner/staff");
  revalidatePath("/owner");
  return {};
}

// ── Invite by link (0137) ─────────────────────────────────────────────────
//
// The Google-sign-in alternative to "Create login". The owner decides the same
// things (role, telecaller, phones); the invitee finishes by continuing with
// Google as the invited address. Every write is `@RequireOwnerRole("owner")`
// in owner-invites.controller.ts - the owner checks here are the courtesy.
//
// The link comes back to the owner once, like a generated password. It is
// emailed only when the owner ticks "Email it" for this one invite AND the
// platform has SMTP configured - never by default.

type InviteResult = ActionResult & { issued?: IssuedInvite };

async function postInvite(path: string, body: unknown): Promise<InviteResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: await errorText(res) };
    const issued = (await res.json()) as IssuedInvite;
    revalidatePath("/owner/staff");
    return { issued };
  } catch {
    return { error: "The platform API did not answer." };
  }
}

export async function issueInviteAction(input: {
  email: string;
  name?: string;
  ownerRole: string;
  telecallerId?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  send: boolean;
  ttlHours: number;
}): Promise<InviteResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can invite people." };
  }

  const role = OwnerRole.safeParse(input.ownerRole);
  if (!role.success) return { error: `"${input.ownerRole}" is not a role` };
  const email = input.email.trim();
  if (!email) return { error: "An email address is required." };

  return postInvite("/v1/owner/invites", {
    email,
    name: input.name?.trim() || undefined,
    ownerRole: role.data,
    telecallerId: input.telecallerId || null,
    phone: input.phone?.trim() || null,
    whatsapp: input.whatsapp?.trim() || null,
    send: input.send === true,
    ttlHours: input.ttlHours,
  });
}

/** A new link and expiry; the old link stops working at once. */
export async function resendInviteAction(inviteId: string, send: boolean): Promise<InviteResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can resend an invite." };
  }
  return postInvite(`/v1/owner/invites/${encodeURIComponent(inviteId)}/resend`, { send: send === true });
}

export async function revokeInviteAction(inviteId: string): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can withdraw an invite." };
  }

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/owner/invites/${encodeURIComponent(inviteId)}`, {
      method: "DELETE",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }
  revalidatePath("/owner/staff");
  return {};
}
