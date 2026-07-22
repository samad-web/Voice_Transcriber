"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL } from "@/lib/server-api";

export interface CreatedKey {
  error?: string;
  id?: string;
  prefix?: string;
  name?: string;
  key?: string;
}

export async function createApiKeyAction(name: string): Promise<CreatedKey> {
  try {
    const res = await fetch(`${API_URL}/v1/apikeys`, {
      method: "POST",
      headers: adminHeaders,
      cache: "no-store",
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = (await res.json()) as CreatedKey;
    revalidatePath("/api-keys");
    return data;
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}

export async function revokeApiKeyAction(id: string): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/apikeys/${id}`, {
      method: "DELETE",
      headers: adminHeaders,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/api-keys");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
