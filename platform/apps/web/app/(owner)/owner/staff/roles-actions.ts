"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";

/**
 * The Roles & permissions writes.
 *
 * As everywhere else in this console, the `owner`-only check below is a
 * courtesy that turns an API 403 into a sentence; the control is
 * `@RequireOwnerRole("owner")` on each route in `owner-roles.controller.ts`.
 * That controller deliberately carries NO `@RequireCrmPermission`, so an owner
 * who saves a grid that revokes their own CRM access can still reach it to put
 * things back - see its header.
 */

async function ownerOnly(): Promise<{ headers: Record<string, string> } | { error: string }> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (owner.membership.ownerRole !== "owner") {
    return { error: "Only an Owner can change permissions." };
  }
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  return { headers };
}

export async function saveRolePermissionsAction(
  roleId: string,
  grants: Array<{
    objectType: string;
    action: string;
    scope: string;
    fieldRestrictions: Record<string, string>;
  }>,
): Promise<ActionResult> {
  const gate = await ownerOnly();
  if ("error" in gate) return gate;

  try {
    const res = await fetch(`${API_URL}/v1/owner/roles/${roleId}/permissions`, {
      method: "PUT",
      headers: gate.headers,
      cache: "no-store",
      body: JSON.stringify({ grants }),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/staff");
  return {};
}

/**
 * Create a role of the business's own.
 *
 * The key is derived here rather than asked for: a slug is an API requirement,
 * not a decision anybody wants to make. Non-alphanumerics collapse to
 * underscores and a leading digit gets a prefix, because the API's pattern is
 * `^[a-z][a-z0-9_]*$` - so "3rd Party Auditor" becomes `r_3rd_party_auditor`
 * rather than a 400 the person cannot act on.
 */
export async function createRoleAction(name: string): Promise<ActionResult> {
  const gate = await ownerOnly();
  if ("error" in gate) return gate;

  const trimmed = name.trim();
  if (!trimmed) return { error: "Give the role a name." };

  let key = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!key) return { error: "That name has no letters or digits in it." };
  if (!/^[a-z]/.test(key)) key = `r_${key}`;

  try {
    const res = await fetch(`${API_URL}/v1/owner/roles`, {
      method: "POST",
      headers: gate.headers,
      cache: "no-store",
      body: JSON.stringify({ key, name: trimmed }),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/staff");
  return {};
}

export async function deleteRoleAction(roleId: string): Promise<ActionResult> {
  const gate = await ownerOnly();
  if ("error" in gate) return gate;

  try {
    const res = await fetch(`${API_URL}/v1/owner/roles/${roleId}`, {
      method: "DELETE",
      headers: gate.headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/staff");
  return {};
}
