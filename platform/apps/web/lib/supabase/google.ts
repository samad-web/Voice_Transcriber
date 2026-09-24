import "server-only";
import { headers } from "next/headers";
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
  if (!AUTH_ENABLED) return false;
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
 * The console's public base URL - origin plus basePath - for the OAuth
 * `redirectTo`.
 *
 * `PUBLIC_APP_URL` when set (production: docker-compose.prod.yml derives it
 * from APP_DOMAIN + CONSOLE_BASE_PATH, as it does for the API). Otherwise the
 * request's own host, which is what local dev wants. Either way GoTrue only
 * honours a `redirectTo` on its Redirect URLs allowlist and falls back to the
 * Site URL for anything else, so a forged Host header cannot send a sign-in
 * code somewhere foreign.
 */
export async function consolePublicBase(): Promise<string> {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
  return `${proto}://${host}${basePath}`;
}
