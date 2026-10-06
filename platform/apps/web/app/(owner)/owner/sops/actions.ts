"use server";

import { revalidatePath } from "next/cache";
import { ScriptAdherenceMode, SopSteps, type SopStep } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";

/**
 * Save a call procedure - as a new SOP, or as a new VERSION of an existing one.
 *
 * ── THE AUTHORIZATION IS NOT HERE ───────────────────────────────────────────
 *
 * Same rule the team actions state at length: the owner/manager check below is
 * a courtesy so somebody who reaches this page gets a sentence instead of a raw
 * 403, and so a doomed round trip is skipped. The real gate is
 * `@RequireOwnerRole("owner", "manager")` on every route of
 * `call-sops.controller.ts`, which reads the persona from `memberships` rather
 * than from anything this tier asserts.
 *
 * The org is likewise never passed in - `ownerHeaders()` re-resolves it from
 * the verified session, so a caller can send any SOP id they like and still
 * only ever write inside their own tenant.
 */
async function post(path: string, body: unknown): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") {
    return { error: "Only an Owner or Manager can change the call procedure." };
  }

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return { error: await errorText(res) };

  revalidatePath("/owner/sops");
  // The productivity page reads adherence, and a deactivated SOP changes what
  // it can say about the range. Cheap to revalidate, confusing not to.
  revalidatePath("/owner/productivity");
  return {};
}

export async function saveSopAction(input: {
  /** Absent for a brand-new procedure; present to add a version to an existing one. */
  sopId?: string;
  name: string;
  steps: SopStep[];
}): Promise<ActionResult> {
  // Parsed here rather than forwarded, so a malformed step comes back as a
  // readable sentence instead of a zod issue array from the API. The API
  // validates again with the same schema - this is the message, not the gate.
  const parsed = SopSteps.safeParse(input.steps);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Those steps are not valid." };
  }
  if (!input.name.trim()) return { error: "Give the procedure a name." };

  const body = { name: input.name.trim(), steps: parsed.data, activate: true };
  return input.sopId
    ? post(`/v1/owner/sops/${input.sopId}/versions`, body)
    : post("/v1/owner/sops", body);
}

/**
 * Stop scoring new calls.
 *
 * Existing scores are deliberately left alone - they are a record of what was
 * judged at the time, not a live view, so turning scoring off must not rewrite
 * the history of calls already reviewed.
 */
export async function deactivateSopAction(): Promise<ActionResult> {
  return post("/v1/owner/sops/deactivate", {});
}

/**
 * Choose the measure: AI scoring, or this floor's own checklist (0155).
 *
 * The API refuses 'sop' when nothing is activated, with a sentence saying so -
 * forwarded as-is rather than reworded here, because it is the API that knows
 * whether there is a checklist to score against.
 *
 * Revalidates the insights and call pages as well as the two `post` already
 * does: the switch changes which adherence figure those screens can show, and
 * a stale page would keep printing the number the workspace just stopped using.
 */
export async function setAdherenceModeAction(mode: unknown): Promise<ActionResult> {
  const parsed = ScriptAdherenceMode.safeParse(mode);
  if (!parsed.success) return { error: "Choose AI scoring or your call checklist." };
  const result = await post("/v1/owner/sops/mode", { mode: parsed.data });
  if (!result.error) {
    revalidatePath("/owner/insights");
    revalidatePath("/owner/calls");
  }
  return result;
}
