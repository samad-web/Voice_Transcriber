"use server";

import { revalidatePath } from "next/cache";
import type { AgentDefinitionInput, AgentKind, ExtractionField } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";

/**
 * The AI Agent Studio's server actions.
 *
 * ── THE AUTHORIZATION IS NOT HERE ───────────────────────────────────────────
 *
 * Same rule the SOP actions state: the owner/manager check below saves a
 * doomed round trip and turns a 403 into a sentence. The gate is
 * `@RequireOwnerRole("owner", "manager")` on every route of
 * owner-agents.controller.ts, which reads the persona from `memberships`.
 *
 * The org is never passed in - `ownerHeaders()` re-resolves it from the
 * session, so an agent id from another tenant simply 404s under RLS.
 */

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ActionResult & { data?: T }> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") {
    return { error: "Only an Owner or Manager can change AI agents." };
  }
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) return { error: await errorText(res) };
    return { data: (await res.json()) as T };
  } catch {
    return { error: "The API could not be reached. Try again in a moment." };
  }
}

function revalidate(agentId?: string) {
  revalidatePath("/owner/agents");
  if (agentId) revalidatePath(`/owner/agents/${agentId}`);
}

export async function createAgentAction(input: {
  definition: AgentDefinitionInput;
  workspaceId: string | null;
  activate: boolean;
}): Promise<ActionResult & { id?: string }> {
  const res = await call<{ id: string }>("POST", "/v1/owner/agents", input);
  if (res.error || !res.data) return { error: res.error ?? "The agent was not saved." };
  revalidate(res.data.id);
  return { id: res.data.id };
}

export async function saveAgentVersionAction(input: {
  agentId: string;
  definition: AgentDefinitionInput;
  activate: boolean;
}): Promise<ActionResult & { version?: number }> {
  const res = await call<{ version: number }>(
    "POST",
    `/v1/owner/agents/${input.agentId}/versions`,
    {
      definition: input.definition,
      activate: input.activate,
    },
  );
  if (res.error || !res.data) return { error: res.error ?? "The change was not saved." };
  revalidate(input.agentId);
  return { version: res.data.version };
}

export async function activateAgentAction(input: {
  agentId: string;
  version: number;
}): Promise<ActionResult> {
  const res = await call("POST", `/v1/owner/agents/${input.agentId}/activate`, {
    version: input.version,
  });
  if (!res.error) revalidate(input.agentId);
  return { error: res.error };
}

export async function deactivateAgentAction(input: { agentId: string }): Promise<ActionResult> {
  const res = await call("POST", `/v1/owner/agents/${input.agentId}/deactivate`, {});
  if (!res.error) revalidate(input.agentId);
  return { error: res.error };
}

export async function archiveAgentAction(input: { agentId: string }): Promise<ActionResult> {
  const res = await call("POST", `/v1/owner/agents/${input.agentId}/archive`, {});
  if (!res.error) revalidate(input.agentId);
  return { error: res.error };
}

export interface GeneratedAgent {
  name: string;
  instructions: string;
  fields: ExtractionField[];
}

export async function generateAgentAction(input: {
  kind: AgentKind;
  description: string;
  baseAgentId?: string;
}): Promise<ActionResult & { draft?: GeneratedAgent }> {
  const res = await call<GeneratedAgent>("POST", "/v1/owner/agents/generate", input);
  return res.error ? { error: res.error } : { draft: res.data };
}

export interface CallSample {
  id: string;
  started_at: string;
  duration_s: number | null;
  direction: string | null;
  workspace_id: string;
  remote_name: string | null;
  remote_number_prefix: string | null;
  remote_number_last3: string | null;
  telecaller: string | null;
  transcript_chars: number;
}

export async function loadCallSamplesAction(): Promise<ActionResult & { calls?: CallSample[] }> {
  const res = await call<{ calls: CallSample[] }>("GET", "/v1/owner/agents/samples?source=calls");
  return res.error ? { error: res.error } : { calls: res.data?.calls ?? [] };
}

export interface ConversationSample {
  id: string;
  peer_label: string | null;
  peer_last3: string | null;
  last_inbound_at: string;
  matched: boolean;
  message_count: number;
}

export async function loadConversationSamplesAction(): Promise<
  ActionResult & { conversations?: ConversationSample[] }
> {
  const res = await call<{ conversations: ConversationSample[] }>(
    "GET",
    "/v1/owner/agents/samples?source=conversations",
  );
  return res.error ? { error: res.error } : { conversations: res.data?.conversations ?? [] };
}

export interface QualifierTestOutcome {
  verdict: {
    disposition: string;
    score: number;
    intent: string | null;
    rationale: string | null;
    name: string | null;
    email: string | null;
    company: string | null;
    budget: number | null;
    notes: string | null;
  };
  details: Record<string, unknown>;
  band: "hot" | "warm" | "cold" | "junk";
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export async function testQualifierAction(input: {
  definition: AgentDefinitionInput;
  conversationId: string;
}): Promise<ActionResult & { result?: QualifierTestOutcome }> {
  const res = await call<QualifierTestOutcome>("POST", "/v1/owner/agents/test", input);
  return res.error ? { error: res.error } : { result: res.data };
}

export interface DraftOutcome {
  reply: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export async function testDrafterAction(input: {
  definition: AgentDefinitionInput;
  callId?: string;
  conversationId?: string;
}): Promise<ActionResult & { result?: DraftOutcome }> {
  const res = await call<DraftOutcome>("POST", "/v1/owner/agents/test", input);
  return res.error ? { error: res.error } : { result: res.data };
}

export interface ExtractorTestOutcome {
  output: Record<string, unknown>;
  validationStatus: "valid" | "repaired" | "failed";
  validationErrors: string[];
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  lead: {
    qualified: boolean;
    reason: string;
    title: string | null;
    valueNum: number | null;
    filled: number;
  };
}

export async function testExtractorAction(input: {
  definition: AgentDefinitionInput;
  callId: string;
}): Promise<ActionResult & { result?: ExtractorTestOutcome }> {
  const res = await call<ExtractorTestOutcome>("POST", "/v1/owner/agents/test", input);
  return res.error ? { error: res.error } : { result: res.data };
}
