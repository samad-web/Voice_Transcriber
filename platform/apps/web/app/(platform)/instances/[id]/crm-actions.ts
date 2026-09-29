"use server";

import { revalidatePath } from "next/cache";
import { call } from "@/lib/action-call";
import { requireOperator } from "@/lib/operator-guard";

/**
 * Server actions for the CRM console. Every one of these goes through the API
 * rather than the database directly - the admin key stays server-side and the
 * validation, encryption and audit trail live in one place.
 *
 * Every action takes an optional `orgId`. Without it the request is pinned to
 * DEV_ORG_ID, which is what the standalone /crm page has always done. With it
 * the request targets that tenant, which is what the per-instance CRM section
 * needs: a platform operator manages customers other than DEV_ORG_ID, and
 * before this the console could only ever configure one of them.
 *
 * Which makes `requireOperator()` the first statement of every export below.
 * The `orgId` is attacker-controlled by construction, the credential behind it
 * is the root admin key, and these actions hold a tenant's CRM secrets and their
 * delivery payloads. A Server Action is an independently-addressable POST
 * endpoint, so the operator check in `(platform)/layout.tsx` - which runs during
 * a render - is not on this path at all. See lib/operator-guard.ts.
 */

/** Refresh whichever surface the change was made from. */
function refresh(orgId?: string) {
  revalidatePath("/crm");
  if (orgId) revalidatePath(`/instances/${orgId}`);
}

export async function connectProviderAction(input: {
  workspaceId: string;
  provider: string;
  target?: string;
  label?: string;
  config: Record<string, string>;
  secret?: string;
  fieldMap?: Record<string, string>;
  onlyQualified?: boolean;
  orgId?: string;
}): Promise<{ error?: string; id?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const { orgId, ...body } = input;
  const res = await call<{ id: string }>("/v1/crm/integrations", {
    method: "POST",
    body,
    orgId,
  });
  if (res.error) return { error: res.error };
  refresh(orgId);
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
  headers?: Record<string, string>;
  bodyTemplate?: unknown;
  idPath?: string;
  fieldMap?: Record<string, string>;
  onlyQualified?: boolean;
  orgId?: string;
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const { orgId, ...body } = input;
  const res = await call("/v1/crm/integrations/custom", { method: "POST", body, orgId });
  if (res.error) return { error: res.error };
  refresh(orgId);
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
  onlyQualified?: boolean;
  orgId?: string;
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const { id, orgId, ...body } = input;
  const res = await call(`/v1/crm/integrations/${id}`, { method: "PATCH", body, orgId });
  if (res.error) return { error: res.error };
  refresh(orgId);
  return {};
}

export async function deleteIntegrationAction(
  id: string,
  orgId?: string,
): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call(`/v1/crm/integrations/${id}`, { method: "DELETE", orgId });
  if (res.error) return { error: res.error };
  refresh(orgId);
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
  orgId?: string,
): Promise<{ error?: string; result?: TestResult }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<TestResult>(`/v1/crm/integrations/${id}/test`, {
    method: "POST",
    body: { dryRun },
    orgId,
  });
  if (res.error) return { error: res.error };
  // A live test writes last_error/last_success_at on the integration.
  if (!dryRun) refresh(orgId);
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
  orgId?: string,
): Promise<{ error?: string; deliveries?: Delivery[] }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<{ deliveries: Delivery[] }>(
    `/v1/crm/integrations/${id}/deliveries?limit=25`,
    { method: "GET", orgId },
  );
  if (res.error) return { error: res.error };
  return { deliveries: res.data?.deliveries ?? [] };
}

export async function retryDeliveryAction(
  deliveryId: string,
  orgId?: string,
): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call(`/v1/crm/deliveries/${deliveryId}/retry`, { method: "POST", orgId });
  if (res.error) return { error: res.error };
  refresh(orgId);
  return {};
}

export async function retryDeadAction(
  id: string,
  orgId?: string,
): Promise<{ error?: string; requeued?: number }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<{ requeued: number }>(`/v1/crm/integrations/${id}/retry-dead`, {
    method: "POST",
    orgId,
  });
  if (res.error) return { error: res.error };
  refresh(orgId);
  return { requeued: res.data?.requeued ?? 0 };
}
