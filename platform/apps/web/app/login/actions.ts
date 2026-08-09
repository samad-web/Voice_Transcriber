"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export interface LoginResult {
  error?: string;
}

/** Only allow same-origin relative paths back from ?next= — no open redirect. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  return next;
}

/**
 * Supabase email + password sign-in. On success the session cookies are set on
 * this response, the middleware picks them up on the next request, and we
 * redirect into the app.
 */
export async function signInAction(
  email: string,
  password: string,
  next?: string,
): Promise<LoginResult> {
  if (!AUTH_ENABLED) {
    return { error: "Supabase auth is not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) {
    // Supabase returns the same message for unknown user and wrong password,
    // which is what we want — don't leak which accounts exist.
    return { error: error.message };
  }

  revalidatePath("/", "layout");
  redirect(safeNext(next));
}

/**
 * Ends the Supabase session and returns to the sign-in page.
 *
 * ── WHY THIS DOES MORE THAN CALL signOut() ─────────────────────────────────
 *
 * `signOut()` defaults to `scope: "global"`, which POSTs to Supabase to revoke
 * every refresh token for the user. When that request fails — an already
 * expired access token answers 401/403, and a network blip answers nothing —
 * supabase-js throws, and it throws BEFORE clearing the local cookies. The
 * whole action then unwinds: no cookie cleared, no redirect, and from the
 * outside the button simply does nothing while the operator is still signed in.
 * On a shared machine that is the failure that matters.
 *
 * So: local scope, errors swallowed, and the auth cookies deleted by hand
 * afterwards regardless of what Supabase said. `scope: "local"` ends the
 * session in THIS browser without depending on a successful server round trip,
 * which is what the button claims to do. Sessions on other devices survive; a
 * "sign out everywhere" would be a different, clearly-labelled control.
 *
 * The manual delete is the belt to that braces. Supabase-SSR stores the session
 * in cookies named `sb-<project-ref>-auth-token`, sometimes chunked into
 * `.0`/`.1` suffixes when the JWT is large, so this clears anything in the
 * `sb-` namespace rather than guessing the project ref.
 */
export async function signOutAction() {
  if (AUTH_ENABLED) {
    const supabase = await createClient();
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // Deliberately ignored — the cookie clear below is what actually ends
      // the session as far as this browser is concerned, and it must happen
      // whether or not Supabase was reachable.
    }
  }

  // Runs even when AUTH_ENABLED is false: if the console was configured, used,
  // and then had its Supabase env removed, the stale cookies are still sitting
  // in the browser and this is the only thing that clears them.
  const cookieStore = await cookies();
  for (const cookie of cookieStore.getAll()) {
    if (cookie.name.startsWith("sb-")) cookieStore.delete(cookie.name);
  }

  revalidatePath("/", "layout");
  redirect("/login");
}
