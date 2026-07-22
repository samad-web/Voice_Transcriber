"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL } from "@/lib/server-api";

export async function addMemberAction(input: {
  email: string;
  name: string;
  role: string;
  recordingsListen?: boolean;
  recordingsExport?: boolean;
}): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/members`, {
      method: "POST",
      headers: adminHeaders,
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

export async function updateMemberAction(input: {
  userId: string;
  role?: string;
  recordingsListen?: boolean;
  recordingsExport?: boolean;
}): Promise<{ error?: string }> {
  try {
    const { userId, ...patch } = input;
    const res = await fetch(`${API_URL}/v1/members/${userId}`, {
      method: "PATCH",
      headers: adminHeaders,
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

export async function removeMemberAction(userId: string): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/members/${userId}`, {
      method: "DELETE",
      headers: adminHeaders,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/team");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export async function createWorkspaceAction(name: string): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/workspaces`, {
      method: "POST",
      headers: adminHeaders,
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
