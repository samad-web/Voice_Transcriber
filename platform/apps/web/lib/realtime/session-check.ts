import "server-only";
import { createClient as createStatelessClient } from "@supabase/supabase-js";
import { AUTH_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

/**
 * Re-checking a live stream's session (doc 27 §3.4).
 *
 * An open `/events` stream resolves its scope once, at connect. Without this it
 * would outlive "Log out from all devices" until the next reconnect - hours,
 * for a tab left open on a wall screen. So every few minutes the stream asks
 * GoTrue whether the access token it connected with still names a live
 * session, and closes when it does not. The browser's reconnect then passes
 * through the middleware, which sends a revoked session to /login.
 *
 * ── WHY getUser(token), NOT getClaims() ──────────────────────────────────
 *
 * getClaims() verifies a JWT's signature, and with asymmetric keys it does so
 * locally - so it would happily accept a token whose session was revoked a
 * second ago, until the token expired. getUser(token) is a round trip, and
 * GoTrue refuses a token whose session row is gone. At one call per stream per
 * five minutes the round trip is cheap.
 *
 * ── AND WHY NOT THE COOKIE CLIENT ────────────────────────────────────────
 *
 * The cookie client would REFRESH an expired token, rotating the browser's
 * refresh token from inside a stream that cannot write the new one back - and
 * the browser's next navigation would then present a spent refresh token and
 * be signed out for no reason. A stateless client with the connect-time
 * access token never refreshes; when that token simply expires (an hour), the
 * check fails, the stream closes, and the reconnect goes through the
 * middleware, which refreshes properly. A closed stream is a blip; a spent
 * refresh token is a sign-out.
 */

/** How often an open stream re-checks. */
export const SESSION_RECHECK_MS = 5 * 60 * 1000;

/** The access token this request arrived with, or null (auth off, or none). */
export async function connectTimeAccessToken(): Promise<string | null> {
  if (!AUTH_ENABLED) return null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Does this token still name a live session? A network failure answers TRUE:
 * an auth server that is briefly unreachable must not close every open stream
 * in the fleet at once. Only GoTrue positively refusing the token closes one.
 */
export async function sessionStillLive(token: string): Promise<boolean> {
  try {
    const client = createStatelessClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (!error) return Boolean(data.user);
    const status = (error as { status?: number }).status;
    return !(status === 401 || status === 403 || status === 404);
  } catch {
    return true;
  }
}
