import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";
import { getPrincipal, isOperator } from "@/lib/owner-context";

/**
 * The one fetch every Server Action in `app/(platform)/**\/actions.ts` makes.
 *
 * Originally lived only in `crm/actions.ts`. `calls/actions.ts` and
 * `instances/[id]/actions.ts` each hand-rolled their own version of this same
 * try/catch - with drifting error formats between them (`API 500` in one file,
 * `API 500: {"message":"..."}` in another) - which is exactly the kind of
 * inconsistency that makes an operator's bug report useless. Hoisted here so
 * all three files fail the same way.
 *
 * Deliberately NOT `"use server"`: this module is a plain server-side helper
 * imported *by* Server Action files, not a Server Action itself. Marking it
 * would force every export to be an independently-invocable async function
 * with a serializable signature, which a generic `call<T>` is not.
 *
 * `status` and `rawBody` are exposed alongside the formatted `error` string
 * for the handful of callers (`deleteInstanceAction`) that have to branch on
 * a structured error body rather than just display it.
 */
export async function call<T>(
  path: string,
  init: { method: string; body?: unknown; orgId?: string },
): Promise<{ data?: T; error?: string; status?: number; rawBody?: unknown }> {
  // Who is asking, for the call-access gate (0122). Resolved here rather than
  // at ~30 call sites because every action in `(platform)` already opens with
  // `requireOperator()`, so the principal is a fact this helper can derive
  // instead of one each caller has to remember to pass - and forgetting it on
  // a call route would look exactly like the customer having refused.
  // `getPrincipal` is React-`cache()`d, so this costs one resolution per
  // request no matter how many actions run.
  const principal = await getPrincipal().catch(() => null);
  const operatorEmail = isOperator(principal) ? (principal?.email ?? null) : null;

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers: init.orgId ? orgHeaders(init.orgId, { operatorEmail }) : adminHeaders,
      cache: "no-store",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Zod issues come back as an array; flatten them into something readable
      // rather than dumping the raw validation object into the UI.
      const message = payload?.message;
      const text = Array.isArray(message)
        ? message
            .map((m: { path?: string[]; message?: string }) =>
              `${m.path?.join(".") ?? ""} ${m.message ?? ""}`.trim(),
            )
            .join("; ")
        : (message ?? JSON.stringify(payload));
      return { error: `API ${res.status}: ${text}`, status: res.status, rawBody: payload };
    }
    return { data: payload as T, status: res.status };
  } catch {
    return { error: "API unreachable - is the API running?" };
  }
}
