"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";
import { errorText } from "../../actions";

/**
 * Settings → Tasks (migration 0156): whether an owner or a manager may give
 * themselves a task.
 *
 * The owner/manager check is not here. Every route of
 * `task-settings.controller.ts` carries `@RequireOwnerRole`, and the PUT is
 * narrower still (owners only) - this tier forwards a verified session and
 * reads the refusal back. The org is never passed in: `orgHeaders` re-derives
 * it from the session, so a caller can send whatever they like and still only
 * write inside their own tenant.
 */

export interface TaskSettingsView {
  ownerSelfTasks: boolean;
  canEdit: boolean;
}

export interface TaskSettingsResult {
  error?: string;
  settings?: TaskSettingsView;
}

export async function setOwnerSelfTasksAction(enabled: unknown): Promise<TaskSettingsResult> {
  const parsed = z.boolean().safeParse(enabled);
  if (!parsed.success) return { error: "Choose on or off." };

  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });

  try {
    const res = await fetch(`${API_URL}/v1/owner/task-settings`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ ownerSelfTasks: parsed.data }),
    });
    if (!res.ok) return { error: await errorText(res) };
    const settings = (await res.json()) as TaskSettingsView;
    revalidatePath("/owner/settings/tasks");
    // And the task pages: the "Assign to" list is fetched per render from
    // `/v1/tasks/assignable-people`, and whether the reader is on it has just
    // changed. Without this, the composer keeps offering a name the API would
    // now refuse until something else happens to refresh the page.
    revalidatePath("/owner/tasks");
    return { settings };
  } catch {
    return { error: "API unreachable" };
  }
}
