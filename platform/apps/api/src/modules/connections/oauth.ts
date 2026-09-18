import { createHash, randomBytes } from "node:crypto";
import type { ResolvedOAuthClient } from "@aura/db";
import type { ConnectionProviderSpec } from "@aura/shared";

/**
 * The provider-agnostic half of the OAuth handshake (PRD Layer 1).
 *
 * Pure functions, no database and no network, so the parts that are easy to
 * get subtly wrong - PKCE, state, the redirect URI - are directly testable
 * without standing up a provider.
 */

/**
 * Where providers send the browser back. Must match the app registration
 * exactly - and every organisation registering its own app (migration 0120)
 * pastes this same value, which is why the owner console shows it verbatim
 * rather than making anybody work it out.
 */
export function redirectUri(): string {
  const base = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}/owner/connections/callback`;
}

/**
 * PKCE pair. The verifier is kept server-side (oauth_authorizations) and the
 * challenge travels in the authorize URL, so an attacker who intercepts the
 * authorization code still cannot redeem it.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function newState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizeUrl(
  spec: ConnectionProviderSpec,
  client: ResolvedOAuthClient,
  state: string,
  challenge: string | null,
): string {
  if (!spec.oauth) throw new Error(`${spec.id} is not an oauth provider`);
  // The resolved app's URL, not the catalogue's: an organisation's Microsoft
  // app may be pinned to its own directory.
  const url = new URL(client.authorizeUrl);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", spec.oauth.scopes.join(" "));
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(spec.oauth.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  if (challenge) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export async function exchangeCode(
  spec: ConnectionProviderSpec,
  client: ResolvedOAuthClient,
  code: string,
  verifier: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  if (!spec.oauth) throw new Error(`${spec.id} is not an oauth provider`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  if (verifier) body.set("code_verifier", verifier);

  const res = await fetchImpl(client.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Truncated: a provider's error body can be a whole HTML page, and this
    // string reaches an operator-visible error field.
    throw new Error(`token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * The account's own address, read from the id_token when the provider issued
 * one.
 *
 * The payload is NOT verified here, and that is safe for this one use only:
 * it arrived over TLS directly from the provider's token endpoint in response
 * to our own client-authenticated request, not from the browser. It is used
 * as a display label and a dedup key, never as an authorization decision -
 * `user_id` on the row comes from our own session, never from this token.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
      preferred_username?: unknown;
    };
    const email = decoded.email ?? decoded.preferred_username;
    return typeof email === "string" && email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

/**
 * Only a same-site path may be returned to after a handshake.
 *
 * The provider bounces the browser back with whatever we stored, so an
 * absolute or protocol-relative value here would be an open redirect wearing
 * an OAuth callback as a disguise.
 */
export function safeRedirectPath(path: string | null | undefined): string {
  if (!path) return "/owner/connections";
  if (!path.startsWith("/") || path.startsWith("//")) return "/owner/connections";
  return path;
}
