"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/** One rung that is owed right now. */
export interface DueStep {
  id: string;
  journey_id: string;
  step_index: number;
  label: string;
  channel: string;
  guidance: string | null;
  due_at: string;
  contact_id: string;
  contact_name: string | null;
  phone_prefix: string | null;
  phone_last3: string | null;
  cadence_name: string;
}

export interface Journey {
  id: string;
  cadence_name: string;
  contact_id: string;
  contact_name: string | null;
  status: "active" | "completed" | "stopped";
  stop_reason: string | null;
  started_at: string;
  due_count: number;
  step_count: number;
}

export async function fetchDueAction(
  mine: boolean,
): Promise<{ due?: DueStep[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/outreach/due?limit=100${mine ? "&mine=true" : ""}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { due: DueStep[] };
    return { due: data.due };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function fetchJourneysAction(
  status: "active" | "completed" | "stopped",
): Promise<{ journeys?: Journey[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/outreach/journeys?status=${status}&limit=100`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { journeys: Journey[] };
    return { journeys: data.journeys };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Record that a rung was done or deliberately skipped.
 *
 * It does NOT send anything — the rep made the call or wrote the message
 * themselves, and this writes down that they did. The platform has no
 * automated sending path, by design.
 */
export async function actOnStepAction(
  stepId: string,
  status: "done" | "skipped",
  note?: string,
): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/outreach/steps/${stepId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ status, note: note?.trim() ? note.trim() : null }),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/outreach");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}

/** Stop chasing someone, by hand. */
export async function stopJourneyAction(
  journeyId: string,
  stopReason: string,
): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/outreach/journeys/${journeyId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ stopReason }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner/outreach");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}
