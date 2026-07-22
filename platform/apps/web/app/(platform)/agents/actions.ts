"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL, DEV_WORKSPACE_ID } from "@/lib/server-api";

export interface AgentFieldInput {
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "datetime" | "string[]";
  description: string;
  required: boolean;
  enumValues?: string[];
}

export async function createAgentAction(input: {
  name: string;
  systemPrompt: string;
  fields: AgentFieldInput[];
  activate: boolean;
}): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/agents`, {
      method: "POST",
      headers: adminHeaders,
      cache: "no-store",
      body: JSON.stringify({
        workspaceId: DEV_WORKSPACE_ID,
        name: input.name,
        systemPrompt: input.systemPrompt,
        fieldSchema: { fields: input.fields },
        activate: input.activate,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath("/agents");
    return {};
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}

export interface AgentTestResult {
  error?: string;
  agentVersion?: number;
  output?: unknown;
  validationStatus?: string;
  validationErrors?: unknown;
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export async function testAgentAction(input: {
  agentId: string;
  callId: string;
  version?: number;
}): Promise<AgentTestResult> {
  try {
    const res = await fetch(`${API_URL}/v1/agents/${input.agentId}/test`, {
      method: "POST",
      headers: adminHeaders,
      cache: "no-store",
      body: JSON.stringify({
        callId: input.callId,
        version: input.version,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    return (await res.json()) as AgentTestResult;
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}

export async function activateAgentAction(input: {
  agentId: string;
  version: number;
}): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/agents/${input.agentId}/activate`, {
      method: "POST",
      headers: adminHeaders,
      cache: "no-store",
      body: JSON.stringify({ version: input.version }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/agents");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
