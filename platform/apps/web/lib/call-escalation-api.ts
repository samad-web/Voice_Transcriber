import "server-only";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * The one fetch every call-escalation Server Action makes (0151, Build
 * docs/38) - the queue's actions and the settings page's alike.
 *
 * Deliberately NOT `"use server"`, for the reason lib/attendance-api.ts gives:
 * a generic `(method, path, body)` exported from a Server Action file would be
 * a public endpoint reaching any owner route with this session's credentials.
 * The actions that import this each pin their own method and path, and
 * validate what they send.
 *
 * The tenant and the reader are re-derived from the session on every call -
 * nothing tenant-scoped is ever taken from the browser.
 */

export type EscalationCallResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number };

/**
 * The API's refusal, in words a telecaller can act on.
 *
 * Two refusals get their own sentence because the API's code is the useful
 * part: `escalation_disabled` (the workspace switch went off while the page
 * was open) and 429 (MAX_LIVE_ESCALATIONS_PER_TELECALLER). Everything else
 * prefers the API's own `message` when it gives one.
 */
export async function escalationErrorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown };
  const nested =
    body.message && typeof body.message === "object" && !Array.isArray(body.message)
      ? (body.message as { code?: unknown })
      : null;
  if (body.code === "escalation_disabled" || nested?.code === "escalation_disabled") {
    return "Escalations are switched off for this workspace. An owner can turn them on in Settings.";
  }
  if (res.status === 429) {
    return "You have too many escalations still waiting. Wait for some to be answered, or withdraw one, then try again.";
  }
  const message = body.message;
  if (Array.isArray(message)) {
    const joined = message
      .map((m: unknown) => (typeof m === "string" ? m : ((m as { message?: string })?.message ?? "")))
      .filter(Boolean)
      .join("; ");
    if (joined) return joined;
  }
  if (typeof message === "string" && message && !/^forbidden/i.test(message)) return message;
  if (res.status === 403) return "Your role cannot do this. Ask an owner of this workspace.";
  if (res.status === 404) return "That escalation could not be found. It may have been withdrawn.";
  if (res.status === 409) return "Somebody else changed this first. Look again and retry.";
  return `The server refused this (HTTP ${res.status}).`;
}

export async function escalationCall<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<EscalationCallResult<T>> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Not signed in to a workspace.", status: 401 };
  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, error: "The server could not be reached. Try again in a moment.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await escalationErrorFrom(res), status: res.status };
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: true, data, status: res.status };
}
