import { createPublicKey, type KeyObject } from "node:crypto";
import * as jwt from "jsonwebtoken";

/**
 * VERIFY A SUPABASE SESSION IN THE API ITSELF (doc 49 P5-A).
 *
 * ── THE ARCHITECTURE THIS CHANGES, AND THE ONE IT DOES NOT ──────────────────
 *
 * Today `ADMIN_API_KEY` authenticates every `/v1/admin/*` route and crosses
 * tenant boundaries BY DESIGN: `x-org-id` selects the tenant and is trusted,
 * validated for existence rather than for entitlement. That holds, because the
 * web tier is the only holder of the key, resolves the org from a verified
 * Supabase session, and never from the request.
 *
 * It holds *as long as the console is the only client*. Three futures break it
 * and two are already on the roadmap: a mobile or third-party client talking to
 * the API directly (doc 39's portals are exactly this), a leaked key - in a
 * log, a screenshot, a CI variable, an `.env` inside a backup - which is full
 * cross-tenant compromise with nothing in the way, and an operator account
 * compromise, since a signed-in operator is implicitly an admin.
 *
 * So this adds a THIRD principal source beside the admin key and the API's own
 * `aus_` sessions. It does not remove either. Nothing regresses, and the
 * console can be moved off the root key afterwards (P5-B) one route at a time.
 *
 * ── THE WHOLE POINT IS THE PIN ──────────────────────────────────────────────
 *
 * On this path the org is NOT something a caller can state. It is resolved
 * `claims.sub` → `users.sso_subject` → `memberships`, and `x-org-id` is
 * ignored unless it names one of that user's own active memberships - in which
 * case it SELECTS among them rather than asserting one. A JWT for org A
 * therefore cannot reach org B even while sending `x-org-id: B`, which is the
 * case that proves the pin works and the one `isolation.test.ts` asserts.
 *
 * ── HOW THE SIGNATURE IS CHECKED ────────────────────────────────────────────
 *
 * Both of Supabase's schemes, because this deployment is self-hosted and has
 * historically used the symmetric one:
 *
 *   HS256  `SUPABASE_JWT_SECRET` - the shared secret GoTrue signs with. No
 *          network call, which matters: the alternative is a JWKS fetch on the
 *          auth path of every request, and an auth path that depends on
 *          something being reachable is an auth path that fails closed on a
 *          blip. Preferred when configured.
 *
 *   JWKS   asymmetric keys (RS256/ES256), fetched from the issuer's
 *          `/.well-known/jwks.json` and cached. Self-hosted, so the endpoint is
 *          internal and cheap. Node can turn a JWK into a key object natively
 *          (`createPublicKey({ format: "jwk" })`), so this needs no dependency.
 *
 * `algorithms` is always passed explicitly. Omitting it is how a verifier gets
 * talked into accepting `alg: none`, or into verifying an RS256 token's
 * signature using the public key as an HMAC secret.
 */

export interface SupabaseClaims {
  /** The Supabase auth user id. The only claim anything is resolved from. */
  sub: string;
  email?: string;
  /** 'authenticated' for a signed-in user; anything else is refused. */
  role?: string;
  exp?: number;
  iss?: string;
}

/** What the API will accept as a verified Supabase session. */
export class SupabaseTokenError extends Error {}

function hmacSecret(): string | null {
  const raw = process.env.SUPABASE_JWT_SECRET?.trim();
  // The same reasoning as `jwtSecret()`: a published placeholder is worse than
  // nothing, because nothing fails closed and a placeholder fails open.
  if (!raw || raw === "super-secret-jwt-token-with-at-least-32-characters-long") return null;
  return raw;
}

/** The issuer base, e.g. http://supabase-kong:8000/auth/v1 on the private stack. */
function issuerBase(): string | null {
  const raw =
    process.env.SUPABASE_INTERNAL_URL?.trim() ??
    process.env.SUPABASE_URL?.trim() ??
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

interface CachedKeys {
  at: number;
  keys: Map<string, KeyObject>;
}
let jwksCache: CachedKeys | null = null;

/** How long a fetched JWKS is reused. Supabase rotates rarely; an hour is cheap. */
const JWKS_TTL_MS = Number(process.env.SUPABASE_JWKS_TTL_MS ?? 60 * 60 * 1000);

export function resetSupabaseJwksCache(): void {
  jwksCache = null;
}

async function jwks(): Promise<Map<string, KeyObject>> {
  if (jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const base = issuerBase();
  if (!base) throw new SupabaseTokenError("no Supabase URL configured");

  const res = await fetch(`${base}/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(Number(process.env.SUPABASE_JWKS_TIMEOUT_MS ?? 4000)),
  });
  if (!res.ok) throw new SupabaseTokenError(`JWKS fetch returned HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };

  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    const kid = typeof jwk.kid === "string" ? jwk.kid : null;
    if (!kid) continue;
    try {
      // `format: "jwk"` is native since Node 16 - no dependency, and no
      // hand-rolled DER assembly, which is where JWK-to-PEM helpers go wrong.
      keys.set(kid, createPublicKey({ key: jwk as never, format: "jwk" }));
    } catch {
      // One unusable key in the set must not make the whole set unusable: a
      // rotation in progress legitimately publishes a type we do not support.
    }
  }
  if (keys.size === 0) throw new SupabaseTokenError("JWKS contained no usable keys");
  jwksCache = { at: Date.now(), keys };
  return keys;
}

/** A JWT at all? Used to route between `aus_` sessions and Supabase tokens. */
export function looksLikeJwt(token: string): boolean {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
}

/** True when this process can verify a Supabase token at all. */
export function supabaseJwtConfigured(): boolean {
  return hmacSecret() !== null || issuerBase() !== null;
}

/**
 * Verify and return the claims, or throw.
 *
 * Throws rather than returning null so the caller cannot accidentally treat a
 * verification failure as an anonymous request - the mistake that turns an auth
 * guard into a decoration.
 */
export async function verifySupabaseJwt(token: string): Promise<SupabaseClaims> {
  const secret = hmacSecret();
  let payload: jwt.JwtPayload;

  if (secret) {
    try {
      payload = jwt.verify(token, secret, {
        algorithms: ["HS256"],
        // `audience` is deliberately not asserted. Self-hosted GoTrue emits
        // `aud: "authenticated"` for a signed-in user and the same value is
        // checked below as `role`, so asserting it here would only duplicate
        // that - and an `aud` mismatch on a legitimate upgrade of the Supabase
        // stack would lock every owner out with a message that names the wrong
        // cause.
        clockTolerance: 5,
      }) as jwt.JwtPayload;
    } catch (err) {
      throw new SupabaseTokenError(`token did not verify: ${(err as Error).message}`);
    }
  } else {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const alg = decoded?.header?.alg;
    if (!kid || !alg || alg === "none") {
      throw new SupabaseTokenError("token has no usable key id or algorithm");
    }
    const keys = await jwks();
    const key = keys.get(kid);
    if (!key) {
      // A key id we do not have is the normal shape of a ROTATION, so the cache
      // is dropped and the set re-fetched exactly once. Without this, a rotation
      // locks every signed-in owner out for the length of the TTL.
      resetSupabaseJwksCache();
      const refreshed = await jwks();
      const retry = refreshed.get(kid);
      if (!retry) throw new SupabaseTokenError(`no published key with id ${kid}`);
      payload = verifyWith(token, retry, alg);
    } else {
      payload = verifyWith(token, key, alg);
    }
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new SupabaseTokenError("token carries no subject");
  }
  // An anon-key token also verifies against the same secret - it is signed by
  // the same GoTrue - and carries `role: "anon"`. Accepting it would make the
  // PUBLIC browser key an API credential, which is the single worst outcome
  // available on this path.
  if (payload.role !== "authenticated") {
    throw new SupabaseTokenError(`token role is ${String(payload.role)}, not authenticated`);
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    role: payload.role,
    exp: payload.exp,
    iss: typeof payload.iss === "string" ? payload.iss : undefined,
  };
}

function verifyWith(token: string, key: KeyObject, alg: string): jwt.JwtPayload {
  const allowed: jwt.Algorithm[] = ["RS256", "RS512", "ES256", "ES384", "ES512"];
  if (!allowed.includes(alg as jwt.Algorithm)) {
    throw new SupabaseTokenError(`algorithm ${alg} is not accepted`);
  }
  try {
    // The algorithm is pinned to the ONE the header names, from an allowlist of
    // asymmetric algorithms only. Passing the whole allowlist would let a token
    // choose, and a key object plus a chosen algorithm is how the classic
    // "verify an RS256 public key as an HMAC secret" confusion happens.
    return jwt.verify(token, key, {
      algorithms: [alg as jwt.Algorithm],
      clockTolerance: 5,
    }) as jwt.JwtPayload;
  } catch (err) {
    throw new SupabaseTokenError(`token did not verify: ${(err as Error).message}`);
  }
}
