"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";

/** Omitted orgId keeps the dev-org default; the pages pass the selected tenant. */
const headersFor = (orgId?: string) => (orgId ? orgHeaders(orgId) : adminHeaders);

export async function addMemberAction(
  input: {
    email: string;
    name: string;
    role: string;
    recordingsListen?: boolean;
    recordingsExport?: boolean;
  },
  orgId?: string,
): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/members`, {
      method: "POST",
      headers: headersFor(orgId),
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath("/team");
    return {};
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}

export async function updateMemberAction(
  input: {
    userId: string;
    role?: string;
    recordingsListen?: boolean;
    recordingsExport?: boolean;
  },
  orgId?: string,
): Promise<{ error?: string }> {
  try {
    const { userId, ...patch } = input;
    const res = await fetch(`${API_URL}/v1/members/${userId}`, {
      method: "PATCH",
      headers: headersFor(orgId),
      cache: "no-store",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/team");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export async function removeMemberAction(
  userId: string,
  orgId?: string,
): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/members/${userId}`, {
      method: "DELETE",
      headers: headersFor(orgId),
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/team");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export async function createWorkspaceAction(
  name: string,
  orgId?: string,
): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/workspaces`, {
      method: "POST",
      headers: headersFor(orgId),
      cache: "no-store",
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath("/team");
    return {};
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}
