"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Operator-only, asserted per action rather than by the `(platform)` layout.
 * Each export below is an independently-addressable POST endpoint that takes a
 * tenant from its caller and sends the root admin key; the layout's
 * `isOperator()` gates rendering and never runs on invocation. See
 * lib/operator-guard.ts.
 */

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
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
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

export interface GeneratedDraft {
  error?: string;
  name?: string;
  systemPrompt?: string;
  fields?: AgentFieldInput[];
}

/**
 * Draft a new agent from a description — the Studio's "describe it with AI"
 * path. When `baseAgentId` is set (the "Start from" picker), drafts a
 * MODIFICATION of that agent instead of one from scratch. Never persists
 * anything: the draft only fills the same form state the manual builder and
 * "Start from" picker already write to, and it's saved through the ordinary
 * `createAgentAction` above, same as anything else typed into that form.
 */
export async function generateAgentAction(input: {
  description: string;
  baseAgentId?: string;
  baseVersion?: number;
  orgId?: string;
}): Promise<GeneratedDraft> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/agents/generate`, {
      method: "POST",
      headers: headersFor(input.orgId),
      cache: "no-store",
      body: JSON.stringify({
        description: input.description,
        baseAgentId: input.baseAgentId,
        baseVersion: input.baseVersion,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    return (await res.json()) as GeneratedDraft;
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
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
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
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
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
