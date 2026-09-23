import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { AUTH_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/**
 * Supabase client for server components, route handlers and server actions.
 * Reads/writes the session cookies Next hands us.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot set cookies. The middleware refreshes the
          // session on every request, so dropping the write here is safe.
        }
      },
    },
  });
}

export interface SessionUser {
  id: string;
  email: string;
  /**
   * `claims.session_id` - which GoTrue session this browser holds. Login
   * activity (doc 27 §5.4) marks the row carrying it as "This session".
   * Optional: a token minted before GoTrue added the claim has none.
   */
  sessionId?: string | null;
}

/**
 * The signed-in principal, or null.
 *
 * Uses getClaims() rather than getUser(): both VERIFY the token rather than
 * trusting the cookie, but they pay very different prices for it.
 *
 *   getUser()   - POSTs the token to /auth/v1/user and waits for the auth
 *                 server to vouch for it. One network round trip, every call.
 *   getClaims() - fetches the project's public JWKS once, then verifies the
 *                 signature locally with WebCrypto. Zero network per call.
 *
 * That distinction is worth ~250ms here. This project's Supabase instance is
 * in AWS Seoul while the app runs on a VPS in Mumbai, so every avoidable round
 * trip to the auth server costs ~125ms each way - and this used to run on
 * EVERY request, on top of the identical call the middleware had already made
 * microseconds earlier.
 *
 * The security property is unchanged. getClaims() checks `exp` and verifies
 * the ES256 signature against the key published at
 * /auth/v1/.well-known/jwks.json; it is emphatically NOT getSession(), which
 * would trust the cookie blindly. If the project ever reverts to a symmetric
 * (HS256) signing key, auth-js has no public key to verify against and falls
 * back to getUser() internally - so this degrades to exactly the previous
 * behaviour rather than to a weaker check.
 *
 * Token refresh is preserved: with no argument, getClaims() reads the session
 * through getSession(), which still refreshes an expired access token before
 * returning it.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!AUTH_ENABLED) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;

  // `sub` is the Supabase user id - the same value getUser() returned as
  // `user.id`, and what getPrincipal() matches against users.sso_subject.
  const subject = data.claims.sub;
  if (!subject) return null;
  const email = typeof data.claims.email === "string" ? data.claims.email : "";
  const sessionId = typeof data.claims.session_id === "string" ? data.claims.session_id : null;
  return { id: subject, email, sessionId };
}
