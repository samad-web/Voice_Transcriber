"use server";

import { revalidatePath } from "next/cache";
import type { StagePack } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * The ready-made boards, and which one matches a typed description.
 *
 * The matching runs on the API rather than here so there is one definition of
 * "a dental clinic gets the clinic board" - the same reason `readChannel` is
 * shared rather than reimplemented per surface. It is a GET and commits to
 * nothing; the description is never stored.
 */
export async function stagePackCatalogueAction(
  describe: string,
): Promise<{ packs?: StagePack[]; suggestedId?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(
      `${API_URL}/v1/pipelines/stage-packs/catalogue?describe=${encodeURIComponent(describe)}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as { packs: StagePack[]; suggestedId: string };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Replace the pipeline's columns with a pack.
 *
 * Note what this does NOT do: send the stage array. The pack ID goes over the
 * wire and the API resolves it, so the columns that land are the ones the
 * catalogue defines rather than whatever a client happened to be holding - and
 * the audit row names the pack, which is what makes "why did our board change
 * on the 14th" answerable.
 */
export async function applyStagePackAction(
  pipelineId: string,
  packId: string,
): Promise<{ movedDeals?: number; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/pipelines/${pipelineId}/apply-stage-pack`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ packId }),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { movedDeals: number };
    revalidatePath("/owner/deals");
    return { movedDeals: data.movedDeals };
  } catch {
    return { error: "API unreachable" };
  }
}
