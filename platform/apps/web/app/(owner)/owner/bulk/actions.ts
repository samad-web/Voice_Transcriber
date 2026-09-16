"use server";

import { revalidatePath } from "next/cache";
import { OWNER_ROLE_ADMINS } from "@aura/shared";
import { getOwner } from "@/lib/owner-context";
import { API_URL } from "@/lib/server-api";
import { errorText, ownerHeaders } from "../actions";

/**
 * The list views' bulk actions (CRM dashboard Phase 5).
 *
 * Every one is a single request carrying the selected ids; the API checks each
 * id against the org and the caller's record scope inside one transaction and
 * answers how many it changed and how many it skipped. The console never
 * decides who may change what - it reports what the API did.
 *
 * NOTHING HERE SENDS A MESSAGE. The bulk "Email" action is a copyable address
 * list assembled in the browser from rows already on screen (email-list-
 * dialog.tsx); a person sends from their own mail app, one decision at a time.
 */

export type BulkObject = "contacts" | "deals" | "tasks" | "leads";

export interface BulkActionResult {
  error?: string;
  updated?: number;
  skipped?: number;
}

/** The body field each object's reassign route takes - contacts/deals have owners, tasks assignees, leads telecallers. */
const TARGET_FIELD: Record<BulkObject, string> = {
  contacts: "ownerUserId",
  deals: "ownerUserId",
  tasks: "assigneeUserId",
  leads: "telecallerId",
};

const LIST_PATH: Record<BulkObject, string> = {
  contacts: "/owner/contacts",
  deals: "/owner/deals",
  tasks: "/owner/tasks",
  leads: "/owner/leads",
};

export async function bulkReassignAction(
  object: BulkObject,
  ids: string[],
  targetId: string | null,
): Promise<BulkActionResult> {
  if (!(object in TARGET_FIELD)) return { error: "Unknown list" };
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/${object}/reassign`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ ids, [TARGET_FIELD[object]]: targetId }),
    });
    if (res.status === 403) return { error: "You don't have permission to reassign these." };
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as { updated: number; skipped: number };
    revalidatePath(LIST_PATH[object]);
    if (object === "tasks") revalidatePath("/owner");
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

export async function bulkTagAction(object: "contacts" | "deals", tagId: string, ids: string[]): Promise<BulkActionResult> {
  if (object !== "contacts" && object !== "deals") return { error: "Only contacts and deals can be tagged" };
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/tags/${encodeURIComponent(tagId)}/${object}`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ ids }),
    });
    if (res.status === 403) return { error: "You don't have permission to tag these." };
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as { updated: number; skipped: number };
    revalidatePath(LIST_PATH[object]);
    return data;
  } catch {
    return { error: "API unreachable" };
  }
}

export interface TagOption {
  id: string;
  name: string;
  color: string | null;
}

export async function fetchTagsAction(): Promise<{ tags?: TagOption[]; canCreate?: boolean; error?: string }> {
  const [headers, owner] = await Promise.all([ownerHeaders(), getOwner()]);
  if (!headers || !owner) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/tags`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { tags: TagOption[] };
    return { tags: data.tags, canCreate: OWNER_ROLE_ADMINS.includes(owner.membership.ownerRole) };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Add a word to the org's tag vocabulary.
 *
 * OWNER/MANAGER, checked HERE: the API's `POST /v1/tags` is org configuration
 * on AdminKeyGuard+TenantGuard with no persona gate (tags.controller.ts), so
 * this action is the only thing stopping every rep from growing the list. Same
 * arrangement as the stale-deal threshold (deals/stale-actions.ts).
 */
export async function createTagAction(name: string): Promise<{ tag?: TagOption; error?: string }> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  if (!OWNER_ROLE_ADMINS.includes(owner.membership.ownerRole)) {
    return { error: "Only an owner or manager can add a new tag." };
  }
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  const trimmed = name.trim();
  if (!trimmed) return { error: "Give the tag a name" };

  try {
    const res = await fetch(`${API_URL}/v1/tags`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ name: trimmed.slice(0, 60) }),
    });
    if (!res.ok) return { error: await errorText(res) };
    return (await res.json()) as { tag: TagOption };
  } catch {
    return { error: "API unreachable" };
  }
}

export interface AssigneeOption {
  id: string;
  label: string;
  detail: string | null;
}

/**
 * Who a selection can be given to.
 *
 * `people` - the org's members (contacts, deals, tasks belong to users).
 * `telecallers` - the active telecaller identities (leads belong to those); read
 * from the team roster, which is owner/manager only, the same people the lead
 * reassign route admits.
 */
export async function fetchAssigneeOptionsAction(
  kind: "people" | "telecallers",
): Promise<{ options?: AssigneeOption[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    if (kind === "telecallers") {
      const res = await fetch(`${API_URL}/v1/owner/team`, { headers, cache: "no-store" });
      if (res.status === 403) return { error: "Only an owner or manager can reassign leads." };
      if (!res.ok) return { error: `API ${res.status}` };
      const data = (await res.json()) as {
        telecallers: Array<{ id: string; displayName: string; userId: string | null }>;
      };
      return {
        options: data.telecallers.map((t) => ({
          id: t.id,
          label: t.displayName,
          // Said beside the name, not discovered later: an unbound telecaller
          // gets the leads but no notification (lead-routing.ts).
          detail: t.userId ? null : "no console login - won't be notified",
        })),
      };
    }

    const res = await fetch(`${API_URL}/v1/members`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { members: Array<{ userId: string; name: string | null; email: string }> };
    // One row per person: a member can hold an org and a workspace membership.
    const seen = new Set<string>();
    const options: AssigneeOption[] = [];
    for (const m of data.members) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      options.push({ id: m.userId, label: m.name ?? m.email, detail: m.name ? m.email : null });
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    return { options };
  } catch {
    return { error: "API unreachable" };
  }
}
