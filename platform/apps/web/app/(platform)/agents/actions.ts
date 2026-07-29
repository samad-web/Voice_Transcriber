"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";

/** Omitted orgId keeps the dev-org default; the page passes the selected tenant. */
const headersFor = (orgId?: string) => (orgId ? orgHeaders(orgId) : adminHeaders);

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
  /**
   * Workspace the agent belongs to. Previously hardcoded to the environment's
   * DEV_WORKSPACE_ID, so an agent authored while viewing customer B was
   * written into customer A's workspace — where it then ran against A's calls.
   */
  workspaceId: string;
  orgId?: string;
}): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/agents`, {
      method: "POST",
      headers: headersFor(input.orgId),
      cache: "no-store",
      body: JSON.stringify({
        workspaceId: input.workspaceId,
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
  orgId?: string;
}): Promise<AgentTestResult> {
  try {
    const res = await fetch(`${API_URL}/v1/agents/${input.agentId}/test`, {
      method: "POST",
      headers: headersFor(input.orgId),
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
  orgId?: string;
}): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/agents/${input.agentId}/activate`, {
      method: "POST",
      headers: headersFor(input.orgId),
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
