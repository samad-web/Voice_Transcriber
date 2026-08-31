/**
 * The HTTP client the suites speak to the spawned API with.
 *
 * Two credentials, because the platform has two and they behave differently in
 * exactly the way the isolation loop is about (doc 13 §2.1):
 *
 *   asTenant(t)   `x-admin-key` + `x-org-id: <t.orgId>`. This is the console's
 *                 credential (`apps/web/lib/server-api.ts:17`): a cross-tenant
 *                 root key whose tenant is chosen by a HEADER. It is therefore
 *                 the only credential that can *express* "tenant A asking for
 *                 tenant B's row", which is the whole point of the loop - a
 *                 credential that cannot name the wrong tenant proves nothing.
 *
 *   asSession(t)  `Authorization: Bearer aus_…`. AdminKeyGuard:114 OVERWRITES
 *                 `x-org-id` with the session's own org, so a session can never
 *                 be unpinned. `asSessionClaiming()` exists to prove that: it
 *                 sends a tenant-A session together with tenant B's org header.
 *
 * Nothing here throws on a non-2xx. Every assertion in the loop is about WHICH
 * status came back - a helper that threw on 404 would make the most important
 * expected outcome in the suite unobservable.
 */
import { API_BASE, ADMIN_API_KEY } from "./env.js";
import type { Tenant } from "./tenants.js";

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  /** Raw text, kept for the cases where the body is not JSON (an S3 redirect,
   *  an empty 204, or a Nest exception filter that answered HTML). */
  text: string;
}

export interface Caller {
  label: string;
  headers: Record<string, string>;
}

/** The console's credential, pointed at one tenant. */
export function asTenant(t: Tenant): Caller {
  return {
    label: `admin-key/${t.key}`,
    headers: { "x-admin-key": ADMIN_API_KEY, "x-org-id": t.orgId },
  };
}

/** A real user session belonging to `t`. */
export function asSession(t: Tenant): Caller {
  return {
    label: `session/${t.key}`,
    headers: { authorization: `Bearer ${t.sessionToken}` },
  };
}

/**
 * `t`'s session, asking to be treated as `claimed`.
 *
 * The request is well-formed and the header is one the API reads elsewhere; the
 * guard is the only thing that decides it does not count here.
 */
export function asSessionClaiming(t: Tenant, claimed: Tenant): Caller {
  return {
    label: `session/${t.key} claiming x-org-id=${claimed.key}`,
    headers: { authorization: `Bearer ${t.sessionToken}`, "x-org-id": claimed.orgId },
  };
}

/** No credential at all - for the six unguarded routes in doc 13 §1.2. */
export const ANONYMOUS: Caller = { label: "anonymous", headers: {} };

export async function call<T = any>(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...caller.headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A hung request must fail the test, not the whole run. 20s is above the
    // slowest legitimate route (the CRM dry run) and far below vitest's
    // testTimeout, so the failure names the route rather than the file.
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed as T, text };
}

/** Nest renders every HttpException as `{ statusCode, message, error }`. */
export function messageOf(res: ApiResponse): string {
  const m = (res.body as { message?: unknown } | undefined)?.message;
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return m.map((x) => JSON.stringify(x)).join("; ");
  return res.text;
}
