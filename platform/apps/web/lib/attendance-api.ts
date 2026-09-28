import "server-only";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * The one fetch every attendance Server Action makes (doc 33 §9).
 *
 * Deliberately NOT `"use server"`, for the reason lib/action-call.ts gives: a
 * generic `(method, path, body)` exported from a Server Action file would be a
 * public endpoint that reaches any owner route with this session's
 * credentials. The actions that import this each pin their own method and
 * path, and validate what they send.
 *
 * The tenant is re-derived from the session on every call, as `ownerHeaders()`
 * does - nothing tenant-scoped is ever taken from the browser.
 */

export const ATTENDANCE_BASE = "/v1/owner/attendance";

export type AttendanceCallResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/**
 * The API's own words when it gives them: a string `message` (a 409's "that
 * pattern is still assigned"), or a zod issue array joined into one line.
 * A 403 with nothing useful to say becomes the persona sentence the rest of
 * the console uses.
 */
async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  const message = body?.message;
  if (Array.isArray(message)) {
    const joined = message
      .map((m: unknown) => (typeof m === "string" ? m : ((m as { message?: string })?.message ?? "")))
      .filter(Boolean)
      .join("; ");
    if (joined) return joined;
  }
  if (typeof message === "string" && message && !(res.status === 403 && /^forbidden/i.test(message))) {
    return message;
  }
  if (res.status === 403) return "Your role cannot do this. Ask an owner of this workspace.";
  return `The server refused this (HTTP ${res.status}).`;
}

export async function attendanceCall<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<AttendanceCallResult<T>> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Not signed in to a workspace.", status: 401 };
  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });

  let res: Response;
  try {
    res = await fetch(`${API_URL}${ATTENDANCE_BASE}${path}`, {
      method,
      headers,
      cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, error: "The server could not be reached. Try again in a moment.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await errorFrom(res), status: res.status };
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: true, data };
}
