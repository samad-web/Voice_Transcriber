import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { safeConsolePath } from "@aura/shared";
import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_MAX_AGE_S } from "@/lib/active-org";
import { recordAuthEvent, sessionIdFromAccessToken } from "@/lib/auth-events";
import { consoleUrl } from "@/lib/console-url";
import { isListedOperatorEmail } from "@/lib/owner-context";
import { consolePublicOrigin } from "@/lib/public-url";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { INVITE_COOKIE } from "@/lib/supabase/google";
import { createClient } from "@/lib/supabase/server";

/**
 * Where GoTrue sends the browser back after "Continue with Google".
 *
 * Public (`/auth` is in the middleware's PUBLIC_PREFIXES): the person arriving
 * has no session yet - making one is this route's job. Register
 * `<console>/auth/callback` in Supabase → Auth → URL Configuration → Redirect
 * URLs, or GoTrue ignores `redirectTo` and sends people to the Site URL.
 *
 * Two outcomes, decided by whether an invite cookie came back with the browser:
 *
 *   INVITE   the API accepts the invite for the account GoTrue vouches for
 *            (same verified Google address, single use, unexpired) and the
 *            person lands in their new workspace.
 *   SIGN-IN  the API links the Google identity to the existing platform user
 *            with that verified address, if it had no binding yet. It never
 *            creates one. A Google account belonging to no workspace and no
 *            operator allowlist is signed straight back out, rather than being
 *            left holding a session that opens nothing.
 *
 * Every failure signs the new session out before redirecting: a half-finished
 * sign-in must not leave a live session behind.
 */

async function discardSession(): Promise<void> {
  try {
    const supabase = await createClient();
    // Local scope revokes this session's refresh token at GoTrue; errors are
    // irrelevant because the cookies go below regardless.
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // ignored - see above
  }
  const store = await cookies();
  for (const cookie of store.getAll()) {
    if (cookie.name.startsWith("sb-")) store.delete(cookie.name);
  }
}

function to(origin: string, path: string, params: Record<string, string> = {}): NextResponse {
  // consoleUrl, not new URL(path, origin): a redirect built here does not get
  // the /admin basePath on its own (lib/console-url.ts). And the PUBLIC
  // origin, not request.url's - behind nginx that is https://0.0.0.0:3000.
  const url = consoleUrl(origin, path, undefined, "/login");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

async function postApi(path: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify(body),
    });
    return { ok: res.ok, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, body: { code: "unavailable" } };
  }
}

export async function GET(request: NextRequest) {
  const origin = await consolePublicOrigin();
  if (!AUTH_ENABLED) return to(origin, "/login");

  const query = request.nextUrl.searchParams;
  const store = await cookies();
  const inviteToken = store.get(INVITE_COOKIE)?.value ?? null;
  // Spent the moment it is read, whatever happens next: an invite is retried
  // from its own page, never by replaying this callback.
  if (inviteToken) store.delete(INVITE_COOKIE);

  const failed = (code: string) =>
    inviteToken ? to(origin, `/invite/${encodeURIComponent(inviteToken)}`, { error: code }) : to(origin, "/login", { error: code });

  // Cancelled at Google, or GoTrue refused (e.g. sign-ups disabled for an
  // unknown address). The provider's own words stay out of the URL.
  if (query.get("error")) {
    return failed(query.get("error") === "access_denied" ? "google_cancelled" : "google_failed");
  }
  const code = query.get("code");
  if (!code) return failed("google_failed");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  const accessToken = data?.session?.access_token;
  if (error || !accessToken || !data.user) {
    await discardSession();
    return failed("google_failed");
  }
  const sessionId = sessionIdFromAccessToken(accessToken);

  if (inviteToken) {
    const accepted = await postApi("/v1/auth/invites/accept", { token: inviteToken, accessToken });
    if (!accepted.ok) {
      await discardSession();
      return failed(typeof accepted.body.code === "string" ? accepted.body.code : "accept_failed");
    }
    const orgId = typeof accepted.body.orgId === "string" ? accepted.body.orgId : null;
    // Open the workspace they just joined, not whichever they joined first.
    // A preference only - getPrincipal re-checks it against the session.
    if (orgId) {
      store.set(ACTIVE_ORG_COOKIE, orgId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: ACTIVE_ORG_MAX_AGE_S,
      });
    }
    await recordAuthEvent({ kind: "sign_in", authUserId: data.user.id, sessionId, console: "owner", orgId });
    return to(origin, "/owner", accepted.body.alreadyMember ? {} : { joined: "1" });
  }

  const linked = await postApi("/v1/auth/identity/link", { accessToken });
  const hasWorkspace = linked.ok && linked.body.hasWorkspace === true;
  if (!hasWorkspace && !(await isListedOperatorEmail(data.user.email ?? ""))) {
    await discardSession();
    return to(origin, "/login", { error: linked.ok ? "no_workspace" : "unavailable" });
  }

  await recordAuthEvent({ kind: "sign_in", authUserId: data.user.id, sessionId });
  return to(origin, safeConsolePath(query.get("next"), "/dashboard"));
}
