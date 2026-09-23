"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { safeConsolePath } from "@aura/shared";
import { currentConsole, recordAuthEvent, sessionIdFromAccessToken } from "@/lib/auth-events";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export interface LoginResult {
  error?: string;
}

/**
 * Only a same-site path comes back from ?next= - no open redirect. Any console
 * may be named (the middleware records whichever one the person was bounced
 * from), so there is no prefix; `safeConsolePath` refuses `//host` and
 * `/\host`, which the check it replaced let through.
 */
function safeNext(next: string | undefined): string {
  return safeConsolePath(next, "/dashboard");
}

/** Delete every Supabase auth cookie, whatever the project ref and chunking. */
async function clearAuthCookies(): Promise<void> {
  const cookieStore = await cookies();
  for (const cookie of cookieStore.getAll()) {
    if (cookie.name.startsWith("sb-")) cookieStore.delete(cookie.name);
  }
}

/**
 * Supabase email + password sign-in. On success the session cookies are set on
 * this response, the middleware picks them up on the next request, and we
 * redirect into the app.
 *
 * Both outcomes are recorded for Login activity (doc 27 §5.3), and neither
 * recording can change what the form sees: the failed-sign-in write names only
 * the typed email, the API records nothing for an address with no account, and
 * the error returned below is Supabase's own either way.
 */
export async function signInAction(
  email: string,
  password: string,
  next?: string,
): Promise<LoginResult> {
  if (!AUTH_ENABLED) {
    return { error: "Supabase auth is not configured - set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) {
    await recordAuthEvent({ kind: "sign_in_failed", authUserId: null, email: email.trim().toLowerCase() });
    // Supabase returns the same message for unknown user and wrong password,
    // which is what we want - don't leak which accounts exist.
    return { error: error.message };
  }

  // The subject and session come from GoTrue's own response, not the form.
  // Console and workspace are left for the API to infer: the console this
  // person lands in has not been resolved yet.
  await recordAuthEvent({
    kind: "sign_in",
    authUserId: data.user?.id ?? null,
    sessionId: sessionIdFromAccessToken(data.session?.access_token),
  });

  revalidatePath("/", "layout");
  redirect(safeNext(next));
}

/**
 * Ends the Supabase session and returns to the sign-in page.
 *
 * ── WHY THIS DOES MORE THAN CALL signOut() ─────────────────────────────────
 *
 * `signOut()` defaults to `scope: "global"`, which POSTs to Supabase to revoke
 * every refresh token for the user. When that request fails - an already
 * expired access token answers 401/403, and a network blip answers nothing -
 * supabase-js throws, and it throws BEFORE clearing the local cookies. The
 * whole action then unwinds: no cookie cleared, no redirect, and from the
 * outside the button simply does nothing while the operator is still signed in.
 * On a shared machine that is the failure that matters.
 *
 * So: local scope, errors swallowed, and the auth cookies deleted by hand
 * afterwards regardless of what Supabase said. `scope: "local"` ends the
 * session in THIS browser without depending on a successful server round trip,
 * which is what the button claims to do. Sessions on other devices survive;
 * "Log out from all devices" is the separate, clearly-labelled control below.
 *
 * The manual delete is the belt to that braces. Supabase-SSR stores the session
 * in cookies named `sb-<project-ref>-auth-token`, sometimes chunked into
 * `.0`/`.1` suffixes when the JWT is large, so this clears anything in the
 * `sb-` namespace rather than guessing the project ref.
 */
export async function signOutAction() {
  if (AUTH_ENABLED) {
    // Recorded BEFORE the session goes, while there is still a verified
    // subject to attach it to. Best effort; it never blocks the sign-out.
    const user = await getSessionUser().catch(() => null);
    if (user) {
      const where = await currentConsole();
      await recordAuthEvent({ kind: "sign_out", authUserId: user.id, sessionId: user.sessionId, ...where });
    }

    const supabase = await createClient();
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // Deliberately ignored - the cookie clear below is what actually ends
      // the session as far as this browser is concerned, and it must happen
      // whether or not Supabase was reachable.
    }
  }

  // Runs even when AUTH_ENABLED is false: if the console was configured, used,
  // and then had its Supabase env removed, the stale cookies are still sitting
  // in the browser and this is the only thing that clears them.
  await clearAuthCookies();

  revalidatePath("/", "layout");
  redirect("/login");
}

export interface SignOutEverywhereResult {
  error?: string;
}

/**
 * Shown in the dialog when GoTrue could not be reached. Nothing changed.
 * Not exported: a "use server" module may export async functions only.
 */
const SIGN_OUT_EVERYWHERE_FAILED =
  "We couldn't reach the sign-in service, so nothing was changed. You're still signed in here. Try again.";

/**
 * "Log out from all devices" (doc 27 §3): end every Supabase session of THIS
 * person - every browser, both consoles, this one included.
 *
 * ── THE OPPOSITE OF signOutAction, DELIBERATELY ───────────────────────────
 *
 * signOutAction swallows errors and clears cookies regardless, because its
 * promise is "this browser is signed out". This one's promise is "EVERY
 * browser is", and somebody pressing it may believe their account is
 * compromised. Clearing only this browser while the other sessions survive,
 * and then saying "done", is the one outcome that must never happen. So if the
 * revoke fails, nothing is cleared, nobody is redirected, and the dialog says
 * so in orange.
 *
 * ── WHY NOT supabase.auth.signOut({ scope: "global" }) ────────────────────
 *
 * Checked in auth-js 2.110.8 (`_signOut`): on a failed revoke it REMOVES THE
 * LOCAL SESSION FIRST and then returns the error - so the cookie client would
 * write this browser's cookies away while the other sessions lived on, the
 * exact outcome above. And it treats a 401/403/404 from GoTrue as success. So
 * the revoke goes through `auth.admin.signOut(token, "global")` - the same
 * POST /logout?scope=global, authenticated by the person's OWN access token
 * (not a service key), which returns its error and touches no local state.
 *
 * Handsets are not affected: they hold device keys and a device JWT, never a
 * Supabase session, so they keep recording. The confirm text says so.
 */
export async function signOutEverywhereAction(): Promise<SignOutEverywhereResult> {
  if (AUTH_ENABLED) {
    const supabase = await createClient();
    // The middleware's getClaims() refreshed this request's session a moment
    // ago, so the access token is current. GoTrue verifies it on /logout.
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return { error: SIGN_OUT_EVERYWHERE_FAILED };

    const user = await getSessionUser().catch(() => null);
    const where = await currentConsole();

    let failed = false;
    try {
      const { error } = await supabase.auth.admin.signOut(token, "global");
      failed = Boolean(error);
    } catch {
      failed = true;
    }
    if (failed) return { error: SIGN_OUT_EVERYWHERE_FAILED };

    // A failure to record must not block the sign-out - recordAuthEvent never
    // throws, and its result is ignored here on purpose.
    await recordAuthEvent({
      kind: "sign_out_all",
      authUserId: user?.id ?? null,
      sessionId: user?.sessionId ?? null,
      ...where,
    });
  }

  await clearAuthCookies();
  revalidatePath("/", "layout");
  redirect("/login?signedOut=everywhere");
}
