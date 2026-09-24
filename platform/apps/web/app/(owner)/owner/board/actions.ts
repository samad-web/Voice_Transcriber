"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";
import type {
  LeadBoard,
  LeadBoardGrants,
  LeadBoardRoute,
  LeadBoardRouteSource,
  Stage,
} from "../types";

/**
 * Lead boards (0136): the Manage boards dialog, the routing table and New lead.
 *
 * Each one re-resolves the tenant from the session (`ownerHeaders`) - a server
 * action is a public endpoint, so the org is never taken from an argument.
 * Every write revalidates the pages that render boards: the board itself, the
 * list (its stage labels come from each lead's board) and the dashboard.
 */

const BOARD_PATHS = ["/owner/board", "/owner/leads", "/owner"];

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  revalidate = true,
): Promise<{ data?: T; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      cache: "no-store",
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as T;
    if (revalidate && init.method && init.method !== "GET") for (const p of BOARD_PATHS) revalidatePath(p);
    return { data };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function fetchLeadBoardsAction(): Promise<{
  boards?: LeadBoard[];
  can?: LeadBoardGrants;
  error?: string;
}> {
  const { data, error } = await call<{ boards: LeadBoard[]; can: LeadBoardGrants }>("/v1/lead-boards");
  return error ? { error } : { boards: data?.boards, can: data?.can };
}

export async function createLeadBoardAction(name: string): Promise<{ id?: string; error?: string }> {
  const { data, error } = await call<{ board: { id: string } }>("/v1/lead-boards", {
    method: "POST",
    body: { name },
  });
  return error ? { error } : { id: data?.board.id };
}

/** `ref` is a board id, or `main` for the Main board. */
export async function updateLeadBoardAction(
  ref: string,
  update: { name?: string; stages?: Stage[] },
): Promise<{ error?: string }> {
  const { error } = await call(`/v1/lead-boards/${encodeURIComponent(ref)}`, { method: "PATCH", body: update });
  return error ? { error } : {};
}

export async function deleteLeadBoardAction(
  id: string,
  moveTo: string,
): Promise<{ leadsMoved?: number; error?: string }> {
  const { data, error } = await call<{ leadsMoved: number }>(
    `/v1/lead-boards/${encodeURIComponent(id)}?moveTo=${encodeURIComponent(moveTo)}`,
    { method: "DELETE" },
  );
  return error ? { error } : { leadsMoved: data?.leadsMoved };
}

export async function fetchBoardRoutesAction(): Promise<{
  sources?: { whatsapp: LeadBoardRouteSource[]; web_form: LeadBoardRouteSource[] };
  routes?: LeadBoardRoute[];
  error?: string;
}> {
  const { data, error } = await call<{
    sources: { whatsapp: LeadBoardRouteSource[]; web_form: LeadBoardRouteSource[] };
    routes: LeadBoardRoute[];
  }>("/v1/lead-boards/routes");
  return error ? { error } : { sources: data?.sources, routes: data?.routes };
}

export async function saveBoardRoutesAction(routes: LeadBoardRoute[]): Promise<{ error?: string }> {
  const { error } = await call("/v1/lead-boards/routes", { method: "PUT", body: { routes } });
  return error ? { error } : {};
}

export interface NewLeadInput {
  name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  notes: string | null;
  value: number | null;
  /** `main`, a board id, or undefined to follow the "Added manually" route. */
  boardId?: string;
}

/**
 * "New lead". `created: false` means the number or email already belongs to a
 * lead, which the API returned instead of making a duplicate.
 */
export async function createLeadAction(
  input: NewLeadInput,
): Promise<{ leadId?: string; created?: boolean; boardId?: string | null; error?: string }> {
  const { data, error } = await call<{ leadId: string; created: boolean; boardId: string | null }>("/v1/leads", {
    method: "POST",
    body: input,
  });
  return error ? { error } : { leadId: data?.leadId, created: data?.created, boardId: data?.boardId ?? null };
}
