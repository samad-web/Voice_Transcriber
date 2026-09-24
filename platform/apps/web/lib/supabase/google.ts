import "server-only";
import { AUTH_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/**
 * "Continue with Google" - the parts shared by the sign-in page, the invite
 * page and the OAuth callback.
 *
 * Google is a Supabase Auth provider, not something this app talks to itself:
 * GoTrue holds the Google client ID/secret, runs the consent round trip, and
 * hands back a PKCE code that `/auth/callback` exchanges for the same kind of
 * session a password sign-in produces. Everything downstream (getClaims,
 * users.sso_subject, memberships) is unchanged.
 */

/** Holds an invite token across the Google round trip (see startGoogleInviteAction). */
export const INVITE_COOKIE = "aura_invite";
/** Ten minutes is plenty for a consent screen; the invite's own expiry still applies. */
export const INVITE_COOKIE_MAX_AGE_S = 60 * 10;

/**
 * Is the Google provider switched on in GoTrue?
 *
 * Asked of GoTrue's public `/auth/v1/settings` (anon key; it lists enabled
 * providers and nothing secret) rather than a second env flag here that could
 * disagree with it - a button for a provider GoTrue refuses is a dead end.
 * Cached five minutes: Supabase is ~125ms away (Mumbai -> Seoul), and the
 * answer changes when somebody edits the dashboard, not per request.
 */
export async function googleSignInEnabled(): Promise<boolean> {
  if (!AUTH_ENABLED || !publicAuthBase()) return false;
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_ANON_KEY },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { external?: Record<string, unknown> };
    return body.external?.google === true;
  } catch {
    return false;
  }
}

/**
 * Where a BROWSER reaches GoTrue's OAuth endpoints (`/auth/v1/authorize`, and
 * Google's return to `/auth/v1/callback`).
 *
 * On Supabase Cloud that is simply the project URL. The self-hosted stack is
 * private: the console talks to GoTrue at `http://supabase-gateway:8000`,
 * which no browser can resolve, and the public Supabase hostname is kept dark.
 * So `SUPABASE_AUTH_PUBLIC_URL` names the public origin that nginx forwards
 * those two paths from - and only those two (see supabase/selfhost/README.md).
 *
 * Null when neither applies: Google sign-in is then reported as unavailable
 * rather than sending people to an address that cannot load.
 */
export function publicAuthBase(): string | null {
  const configured = process.env.SUPABASE_AUTH_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return SUPABASE_URL.startsWith("https://") ? SUPABASE_URL.replace(/\/+$/, "") : null;
}

/**
 * The authorize URL supabase-js built (on the internal base) re-pointed at
 * {@link publicAuthBase}. The query - provider, redirect_to, PKCE challenge -
 * is carried over untouched.
 */
export function browserAuthorizeUrl(authorizeUrl: string): string | null {
  const base = publicAuthBase();
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(authorizeUrl);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/auth/v1/authorize")) return null;
  return `${base}/auth/v1/authorize${url.search}`;
}
