import "server-only";
import { createClient as createStatelessClient } from "@supabase/supabase-js";
import { passwordAttempts } from "@/lib/password-attempts";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/config";

/**
 * Prove the signed-in person knows their password, without touching their
 * session (doc 27 §4.1). Used before a password change and before a phone
 * change - the phone is where call-access approval codes go.
 *
 * A throwaway client (no storage, no refresh) signs in with the password. That
 * proves it without writing a cookie, and the throwaway's own session is
 * revoked straight after so it does not linger as a live refresh token. Wrong
 * passwords count against a per-account cap (password-attempts.ts), so this
 * cannot become an oracle; a GoTrue outage does not count against anybody.
 *
 * `email` MUST come from the verified session's claims, never from a form.
 */
export async function verifyCurrentPassword(
  user: { id: string; email: string },
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const waitMs = passwordAttempts.retryAfterMs(user.id);
  if (waitMs > 0) {
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    return { ok: false, error: `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  const throwaway = createStatelessClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const check = await throwaway.auth.signInWithPassword({ email: user.email, password });
  if (check.error || !check.data.session) {
    const err = check.error as { status?: number; code?: string } | null;
    // GoTrue answers a wrong password with 400 `invalid_credentials`.
    if (err?.code === "invalid_credentials" || err?.status === 400) {
      passwordAttempts.fail(user.id);
      return { ok: false, error: "Your current password is incorrect." };
    }
    return { ok: false, error: "We couldn't reach the sign-in service. Nothing was changed." };
  }

  // Revoke only the throwaway's own session. Best effort: it expires on its own.
  await throwaway.auth.admin.signOut(check.data.session.access_token, "local").catch(() => undefined);
  passwordAttempts.clear(user.id);
  return { ok: true };
}
