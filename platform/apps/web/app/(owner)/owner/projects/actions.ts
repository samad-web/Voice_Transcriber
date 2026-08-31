"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";
import type { Project } from "../types";

export interface ProjectDraft {
  name: string;
  description?: string | null;
  color?: string | null;
  aliases?: string[];
  sortOrder?: number;
}

/**
 * Every page that shows a project label reads the catalogue, so all of them
 * are revalidated on a write — a renamed project that still reads by its old
 * name on the board is the kind of inconsistency people report as data loss.
 */
const TOUCHED = ["/owner/projects", "/owner/leads", "/owner/board", "/owner/deals"];

export async function createProjectAction(
  draft: ProjectDraft,
): Promise<{ project?: Project; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/projects`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(draft),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const { project } = (await res.json()) as { project: Project };
    for (const path of TOUCHED) revalidatePath(path);
    return { project };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function updateProjectAction(
  id: string,
  patch: Partial<ProjectDraft> & { active?: boolean },
): Promise<{ project?: Project; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/projects/${id}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const { project } = (await res.json()) as { project: Project };
    for (const path of TOUCHED) revalidatePath(path);
    return { project };
  } catch {
    return { error: "API unreachable" };
  }
}
