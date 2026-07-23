"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL } from "@/lib/server-api";

/**
 * Server actions for the CRM console. Every one of these goes through the API
 * rather than the database directly — the admin key stays server-side and the
 * validation, encryption and audit trail live in one place.
 */

async function call<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers: adminHeaders,
      cache: "no-store",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Zod issues come back as an array; flatten them into something readable
      // rather than dumping the raw validation object into the UI.
      const message = payload?.message;
      const text = Array.isArray(message)
        ? message.map((m: { path?: string[]; message?: string }) =>
            `${m.path?.join(".") ?? ""} ${m.message ?? ""}`.trim(),
          ).join("; ")
        : (message ?? JSON.stringify(payload));
      return { error: `API ${res.status}: ${text}` };
    }
    return { data: payload as T };
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}

export async function connectProviderAction(input: {
  workspaceId: string;
  provider: string;
  target?: string;
  label?: string;
  config: Record<string, string>;
  secret?: string;
  fieldMap?: Record<string, string>;
}): Promise<{ error?: string; id?: string }> {
  const res = await call<{ id: string }>("/v1/crm/integrations", {
    method: "POST",
    body: input,
  });
  if (res.error) return { error: res.error };
  revalidatePath("/crm");
  return { id: res.data?.id };
}

export async function connectCustomAction(input: {
  workspaceId: string;
  label?: string;
  webhookUrl: string;
  authType: string;
  authHeader?: string;
  authPrefix?: string;
  authSecret?: string;
  fieldMap?: Record<string, string>;
}): Promise<{ error?: string }> {
  const res = await call("/v1/crm/integrations/custom", { method: "POST", body: input });
  if (res.error) return { error: res.error };
  revalidatePath("/crm");
  return {};
}

export async function updateIntegrationAction(input: {
  id: string;
  fieldMap?: Record<string, string>;
  config?: Record<string, string>;
  label?: string;
  authSecret?: string;
  status?: "connected" | "disconnected";
  maxAttempts?: number;
  rateLimitPerMin?: number;
}): Promise<{ error?: string }> {
  const { id, ...body } = input;
  const res = await call(`/v1/crm/integrations/${id}`, { method: "PATCH", body });
  if (res.error) return { error: res.error };
  revalidatePath("/crm");
  return {};
}

export async function deleteIntegrationAction(id: string): Promise<{ error?: string }> {
  const res = await call(`/v1/crm/integrations/${id}`, { method: "DELETE" });
  if (res.error) return { error: res.error };
  revalidatePath("/crm");
  return {};
}

export interface TestResult {
  ok: boolean;
  dryRun: boolean;
  url: string;
  method: string;
  headerNames: string[];
  payload: unknown;
  sampleCallId: string | null;
  status: number | null;
  responseBody: string | null;
  externalId: string | null;
  error: string | null;
  missing: string[];
}

export async function testIntegrationAction(
  id: string,
  dryRun: boolean,
): Promise<{ error?: string; result?: TestResult }> {
  const res = await call<TestResult>(`/v1/crm/integrations/${id}/test`, {
    method: "POST",
    body: { dryRun },
  });
  if (res.error) return { error: res.error };
  // A live test writes last_error/last_success_at on the integration.
  if (!dryRun) revalidatePath("/crm");
  return { result: res.data };
}

export interface Delivery {
  id: string;
  call_id: string;
  status: string;
  attempts: number;
  error: string | null;
  external_id: string | null;
  target: string | null;
  request_url: string | null;
  request_body: unknown;
  response_status: number | null;
  response_body: string | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  updated_at: string;
  started_at: string | null;
  remote_name: string | null;
}

export async function listDeliveriesAction(
  id: string,
): Promise<{ error?: string; deliveries?: Delivery[] }> {
  const res = await call<{ deliveries: Delivery[] }>(
    `/v1/crm/integrations/${id}/deliveries?limit=25`,
    { method: "GET" },
  );
  if (res.error) return { error: res.error };
  return { deliveries: res.data?.deliveries ?? [] };
}

export async function retryDeliveryAction(deliveryId: string): Promise<{ error?: string }> {
  const res = await call(`/v1/crm/deliveries/${deliveryId}/retry`, { method: "POST" });
  if (res.error) return { error: res.error };
  revalidatePath("/crm");
  return {};
}

export async function retryDeadAction(
  id: string,
): Promise<{ error?: string; requeued?: number }> {
  const res = await call<{ requeued: number }>(`/v1/crm/integrations/${id}/retry-dead`, {
    method: "POST",
  });
  if (res.error) return { error: res.error };
  revalidatePath("/crm");
  return { requeued: res.data?.requeued ?? 0 };
}
