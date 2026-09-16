"use server";

import { revalidatePath } from "next/cache";
import type { RecycleBinResource } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * The recycle bin (migration 0097).
 *
 * No permission logic here on purpose, the same as the Handsets actions: the
 * API decides who may list and restore, and a server action that decided for
 * itself would be a second copy of the rule and the one that drifts.
 */

export interface BinItem {
  resource: RecycleBinResource;
  id: string;
  name: string | null;
  deletedAt: string;
  deletedBy: string | null;
}

export interface BinResponse {
  retentionDays: number;
  items: BinItem[];
}

export async function restoreAction(
  resource: RecycleBinResource,
  id: string,
): Promise<{ href?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/recycle-bin/${resource}/${id}/restore`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const body = (await res.json()) as { href?: string };
    // The layout, not just this page: a restored tag, rule or dataset reappears
    // in whichever page owns it, and those are cached separately.
    revalidatePath("/owner", "layout");
    return { href: body.href };
  } catch {
    return { error: "API unreachable" };
  }
}
