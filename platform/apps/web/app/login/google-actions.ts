"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeConsolePath } from "@aura/shared";
import { consolePublicBase } from "@/lib/public-url";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import {
  INVITE_COOKIE,
  INVITE_COOKIE_MAX_AGE_S,
  browserAuthorizeUrl,
  googleSignInEnabled,
} from "@/lib/supabase/google";
import { createClient } from "@/lib/supabase/server";

export interface GoogleStartResult {
  error?: string;
}

const NOT_AVAILABLE = "Google sign-in isn't available on this platform yet. Ask your administrator.";

/** The invite token's shape (43 base64url chars) - checked before anything is sent anywhere. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Begin the Google round trip and hand the browser to Google.
 *
 * Server-side `signInWithOAuth` on the cookie client: supabase-js generates the
 * PKCE verifier and writes it as a cookie on THIS response, so the callback -
 * same browser, same cookies - is the only place the returned code can be
 * redeemed. Nothing about the session ever passes through client JavaScript.
 *
 * `prompt=select_account` because a shared office PC is signed in to
 * somebody's Google already, and silently using that account is how a person
 * ends up in the console as their colleague.
 */
async function startGoogle(redirectPath: string, loginHint?: string): Promise<GoogleStartResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${await consolePublicBase()}${redirectPath}`,
      queryParams: { prompt: "select_account", ...(loginHint ? { login_hint: loginHint } : {}) },
    },
  });
  if (error || !data?.url) {
    return { error: error?.message || "Couldn't start Google sign-in. Try again." };
  }
  // supabase-js built this on the server's own GoTrue address, which on the
  // private self-hosted stack is an internal hostname - see publicAuthBase.
  const authorizeUrl = browserAuthorizeUrl(data.url);
  if (!authorizeUrl) return { error: NOT_AVAILABLE };
  redirect(authorizeUrl);
}

/** "Continue with Google" on the sign-in page. */
export async function startGoogleSignInAction(next?: string): Promise<GoogleStartResult> {
  if (!AUTH_ENABLED || !(await googleSignInEnabled())) return { error: NOT_AVAILABLE };

  // A plain sign-in must never complete a half-finished invite from an
  // earlier tab - that would join a workspace the person did not just choose.
  (await cookies()).delete(INVITE_COOKIE);

  const target = safeConsolePath(next, "/dashboard");
  return startGoogle(`/auth/callback?next=${encodeURIComponent(target)}`);
}

/**
 * "Continue with Google" on an invite page.
 *
 * The API refuses a dead invite here, before the person is sent through
 * Google for nothing, and makes sure GoTrue has a user for the invited address
 * (so this works with GoTrue sign-ups switched off). The token then rides to
 * the callback in an httpOnly cookie rather than in `redirectTo`: a URL passes
 * through Google, GoTrue's logs and browser history, and the cookie never
 * leaves this origin.
 */
export async function startGoogleInviteAction(token: string): Promise<GoogleStartResult> {
  if (!TOKEN_RE.test(token)) return { error: "This invite link isn't valid." };
  if (!AUTH_ENABLED || !(await googleSignInEnabled())) return { error: NOT_AVAILABLE };

  let email: string;
  try {
    const res = await fetch(`${API_URL}/v1/auth/invites/prepare`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ token }),
    });
    const body = (await res.json().catch(() => ({}))) as { email?: string; message?: unknown };
    if (!res.ok || !body.email) {
      return { error: typeof body.message === "string" ? body.message : "This invite can't be used right now." };
    }
    email = body.email;
  } catch {
    return { error: "The platform didn't answer. Try again in a moment." };
  }

  (await cookies()).set(INVITE_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: the callback arrives as a top-level GET from GoTrue's
    // domain, which is exactly the navigation Lax still sends cookies on.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: INVITE_COOKIE_MAX_AGE_S,
  });

  // login_hint pre-selects the invited address in Google's account chooser.
  // A hint, not a constraint - the API still compares the address it gets.
  return startGoogle("/auth/callback", email);
}
