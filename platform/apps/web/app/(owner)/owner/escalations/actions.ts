"use server";

import { revalidatePath } from "next/cache";
import {
  ForwardCallEscalationInput,
  RaiseCallEscalationInput,
  ResolveCallEscalationInput,
  type CallEscalationDetail,
  type CallEscalationListItem,
} from "@aura/shared";
import { escalationCall } from "@/lib/call-escalation-api";
import type { LeadCallDetail } from "../types";

/**
 * Call escalations (0151, Build docs/38) - every write the console makes, and
 * the two reads the queue's drawer makes on open.
 *
 * Each action pins its own method and path and goes through
 * `escalationCall`, which re-derives the tenant and the reader from the
 * session: a Server Action is a public endpoint, so nothing tenant-scoped is
 * ever taken from the browser. Who may act on which escalation is decided per
 * row by the API (`canAct` / `canWithdraw`); the console only stops offering
 * buttons it knows will fail.
 *
 * Inputs are checked against the shared schemas first, so a bad note is
 * refused with the same words the API would have used, without a round trip.
 */

const BASE = "/v1/owner/call-escalations";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = "That escalation could not be found.";

export interface EscalationActionResult<T> {
  data?: T;
  error?: string;
}

/** The first schema issue, as the sentence the form shows. */
function issue(issues: readonly { message: string }[]): string {
  return issues[0]?.message ?? "Check what you typed and try again.";
}

function refresh() {
  revalidatePath("/owner/escalations");
}

/**
 * The updated escalation out of a step's response. The brief says a step
 * returns the row itself; the controller as built wraps it as `{ escalation }`
 * (and that one is the full detail, history included). Both are accepted so
 * the console does not break on whichever lands - a detail is a list item
 * with more fields, so the caller can treat it as either.
 */
function stepRow(data: unknown): CallEscalationListItem | null {
  if (!data || typeof data !== "object") return null;
  const wrapped = (data as { escalation?: unknown }).escalation;
  const row = wrapped && typeof wrapped === "object" ? wrapped : data;
  return typeof (row as { id?: unknown }).id === "string" ? (row as CallEscalationListItem) : null;
}

/** A write that returns the updated row. */
async function write(
  path: string,
  body?: unknown,
): Promise<EscalationActionResult<CallEscalationListItem>> {
  const result = await escalationCall<unknown>("POST", `${BASE}${path}`, body);
  if (!result.ok) return { error: result.error };
  refresh();
  const row = stepRow(result.data);
  // Done either way - the drawer re-reads the detail after every step, so an
  // unexpected body costs the optimistic update, not the action.
  return row ? { data: row } : {};
}

/** GET :id - the row, its history and where it can be passed to. */
export async function fetchEscalationAction(id: string): Promise<EscalationActionResult<CallEscalationDetail>> {
  if (!UUID.test(id)) return { error: NOT_FOUND };
  const result = await escalationCall<CallEscalationDetail>("GET", `${BASE}/${encodeURIComponent(id)}`);
  return result.ok ? { data: result.data } : { error: result.error };
}

/**
 * GET :id/call - the call in full, the same shape as a lead's call
 * (`LeadCallDetail`). A 403 here is the `call_intel` module, not the
 * escalation: anybody who can open the escalation may read its call, and the
 * transcript arrives already redacted for a reader without recordings access.
 */
export async function fetchEscalationCallAction(id: string): Promise<EscalationActionResult<LeadCallDetail>> {
  if (!UUID.test(id)) return { error: NOT_FOUND };
  const result = await escalationCall<LeadCallDetail>("GET", `${BASE}/${encodeURIComponent(id)}/call`);
  if (result.ok) return { data: result.data };
  if (result.status === 403) return { error: "Call transcripts are not enabled for this workspace." };
  return { error: result.error };
}

/**
 * POST / - raise one from the lead drawer. A second press on a call that is
 * already escalated comes back with `duplicate: true` and the live one, rather
 * than as an error: the telecaller's intent is satisfied either way.
 */
export async function raiseEscalationAction(
  input: unknown,
): Promise<EscalationActionResult<{ escalation: CallEscalationListItem; duplicate: boolean }>> {
  const parsed = RaiseCallEscalationInput.safeParse(input);
  if (!parsed.success) return { error: issue(parsed.error.issues) };
  const result = await escalationCall<{ escalation: CallEscalationListItem; duplicate: boolean }>(
    "POST",
    BASE,
    parsed.data,
  );
  if (!result.ok) return { error: result.error };
  refresh();
  return { data: result.data };
}

/** "I'm on it". */
export async function acknowledgeEscalationAction(id: string): Promise<EscalationActionResult<CallEscalationListItem>> {
  if (!UUID.test(id)) return { error: NOT_FOUND };
  return write(`/${encodeURIComponent(id)}/acknowledge`);
}

/** Answer it. The note, if any, goes back to the telecaller's phone. */
export async function resolveEscalationAction(
  id: string,
  note: string,
): Promise<EscalationActionResult<CallEscalationListItem>> {
  if (!UUID.test(id)) return { error: NOT_FOUND };
  const parsed = ResolveCallEscalationInput.safeParse(note.trim() ? { note } : {});
  if (!parsed.success) return { error: issue(parsed.error.issues) };
  return write(`/${encodeURIComponent(id)}/resolve`, parsed.data);
}

/** Pass it up - to one person, or (`null`) to every owner and manager. */
export async function forwardEscalationAction(
  id: string,
  toMembershipId: string | null,
  note: string,
): Promise<EscalationActionResult<CallEscalationListItem>> {
  if (!UUID.test(id)) return { error: NOT_FOUND };
  const parsed = ForwardCallEscalationInput.safeParse({
    toMembershipId,
    ...(note.trim() ? { note } : {}),
  });
  if (!parsed.success) return { error: issue(parsed.error.issues) };
  return write(`/${encodeURIComponent(id)}/forward`, parsed.data);
}

/** Take it back - the raiser only, while it is still live. */
export async function withdrawEscalationAction(id: string): Promise<EscalationActionResult<CallEscalationListItem>> {
  if (!UUID.test(id)) return { error: NOT_FOUND };
  return write(`/${encodeURIComponent(id)}/withdraw`);
}
