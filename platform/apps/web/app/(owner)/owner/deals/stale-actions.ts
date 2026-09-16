"use server";

import { revalidatePath } from "next/cache";
import { OWNER_ROLE_ADMINS } from "@aura/shared";
import { MAX_STALE_AFTER_DAYS, MIN_STALE_AFTER_DAYS } from "@/lib/deal-staleness";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Set how many idle days flag a deal as stale on one pipeline (migration 0106).
 *
 * THIS IS THE ONLY PERSONA GATE. `PATCH /v1/pipelines/:id` is plain
 * AdminKeyGuard+TenantGuard - pipeline configuration, by design - and every
 * console request arrives on the admin key, so the API cannot tell an owner
 * from a telecaller here. The check below is what stops a rep re-timing the
 * flag their manager reads; deleting it is a privilege escalation, the same
 * shape as updateTranscriptionAction's note.
 *
 * The body is built from the one field this action exists for. Nothing the
 * client sends reaches the API except the number, validated first.
 */
export async function setStaleAfterDaysAction(
  pipelineId: string,
  days: number,
): Promise<{ error?: string; staleAfterDays?: number }> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (!OWNER_ROLE_ADMINS.includes(owner.membership.ownerRole)) {
    return { error: "Only an owner or manager can change when deals are flagged." };
  }
  if (!Number.isInteger(days) || days < MIN_STALE_AFTER_DAYS || days > MAX_STALE_AFTER_DAYS) {
    return { error: `Choose a whole number of days from ${MIN_STALE_AFTER_DAYS} to ${MAX_STALE_AFTER_DAYS}.` };
  }
  if (!/^[0-9a-f-]{36}$/i.test(pipelineId)) return { error: "Unknown pipeline" };

  try {
    const res = await fetch(`${API_URL}/v1/pipelines/${pipelineId}`, {
      method: "PATCH",
      headers: orgHeaders(owner.membership.orgId, {
        ownerRole: owner.membership.ownerRole,
        userId: owner.userId,
      }),
      cache: "no-store",
      body: JSON.stringify({ staleAfterDays: days }),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { pipeline?: { stale_after_days?: number } };
    revalidatePath("/owner/deals");
    return { staleAfterDays: data.pipeline?.stale_after_days ?? days };
  } catch {
    return { error: "API unreachable" };
  }
}
