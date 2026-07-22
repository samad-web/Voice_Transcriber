"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL } from "@/lib/server-api";

export async function connectWebhookAction(input: {
  workspaceId: string;
  webhookUrl: string;
}): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/crm/integrations`, {
      method: "POST",
      headers: adminHeaders,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath("/crm");
    return {};
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}

export async function updateFieldMapAction(input: {
  id: string;
  fieldMap: Record<string, string>;
}): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/crm/integrations/${input.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      cache: "no-store",
      body: JSON.stringify({ fieldMap: input.fieldMap }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath("/crm");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
