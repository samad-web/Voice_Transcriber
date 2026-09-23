import "server-only";
import { headers } from "next/headers";
import { AUTH_EVENT_UA_MAX, type AuthEventConsole, type AuthEventKind } from "@aura/shared";
import { clientIpFrom } from "@/lib/client-ip";
import { getPrincipal } from "@/lib/owner-context";
import { API_URL, personHeaders } from "@/lib/server-api";

/**
 * Record one sign-in event (doc 27 §5.3) - best effort, always.
 *
 * Every caller is a sign-in or sign-out path, and none of them may be slowed
 * or broken by a history log: an API that is down, slow or refusing must cost
 * a line in the server log and nothing else. So this never throws, gives up
 * after a few seconds, and returns whether it landed only so a test can see.
 *
 * `authUserId` must come from a verified source on this server - getClaims(),
 * or GoTrue's own sign-in response - never from a form. A failed sign-in has
 * no session and passes `email` instead; the API resolves it by a local
 * SELECT and records nothing when it matches nobody.
 */
export async function recordAuthEvent(event: {
  kind: AuthEventKind;
  authUserId: string | null;
  sessionId?: string | null;
  console?: AuthEventConsole | null;
  orgId?: string | null;
  email?: string | null;
}): Promise<boolean> {
  try {
    const h = await headers();
    const res = await fetch(`${API_URL}/v1/account/auth-events`, {
      method: "POST",
      headers: personHeaders(event.authUserId),
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        kind: event.kind,
        sessionId: event.sessionId ?? null,
        console: event.console ?? null,
        orgId: event.orgId ?? null,
        ip: clientIpFrom(h),
        userAgent: h.get("user-agent")?.slice(0, AUTH_EVENT_UA_MAX) ?? null,
        email: event.email ?? null,
      }),
    });
    if (!res.ok) {
      console.warn(`[auth-events] ${event.kind} not recorded: API ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[auth-events] ${event.kind} not recorded:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Which console, and which workspace, the signed-in person is in right now -
 * for the history row. Best effort: a principal that cannot be resolved
 * leaves both null, and the row is still written.
 */
export async function currentConsole(): Promise<{ console: AuthEventConsole | null; orgId: string | null }> {
  try {
    const principal = await getPrincipal();
    if (!principal) return { console: null, orgId: null };
    return principal.kind === "owner"
      ? { console: "owner", orgId: principal.membership?.orgId ?? null }
      : { console: "operator", orgId: null };
  } catch {
    return { console: null, orgId: null };
  }
}

/**
 * `session_id` from an access token GoTrue has JUST handed this server
 * (signInWithPassword's response). Decoded, not verified - the token did not
 * come from the browser, it came from the auth server over TLS a moment ago,
 * and it is used only to label a history row.
 */
export function sessionIdFromAccessToken(token: string | null | undefined): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.session_id === "string" ? json.session_id : null;
  } catch {
    return null;
  }
}
