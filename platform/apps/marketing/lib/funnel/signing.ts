import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed cookie payloads and salted hashes. SERVER ONLY.
 *
 * Two cookies in this funnel are security-relevant and neither may be
 * client-writable:
 *
 *   the step-1 session — carries the submission id that step 2 attaches to. A
 *   forgeable value would let anyone overwrite a stranger's enquiry, which is
 *   why the id never appears in the DOM as a hidden field.
 *
 *   the split-test variant (§3.5) — a forgeable value would let a visitor (or a
 *   bot, or a curious developer) reassign themselves, and the experiment's whole
 *   claim is that assignment is stable and unbiased.
 *
 * HMAC-SHA256 over a JSON payload, not encryption: the contents are not secret,
 * only their authorship. `httpOnly` keeps them out of document.cookie as well.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/funnel/signing is server-only");
}

/**
 * FAIL CLOSED. Returns null when unset — there is no development default and no
 * generated-at-boot fallback.
 *
 * A generated fallback would be worse than useless here: it would work perfectly
 * in a single-process dev server, then silently invalidate every session the
 * moment production runs two Node processes behind nginx, and would leave the
 * variant assignment re-rolling per instance while the dashboard reported a
 * clean split. An unset secret must stop the funnel, visibly.
 */
export function funnelSecret(): string | null {
  const s = process.env.FUNNEL_COOKIE_SECRET;
  return s && s.length >= 32 ? s : null;
}

/**
 * Salt for hashing IPs and identities into rate-limit keys.
 *
 * Separate from the cookie secret so rotating one does not blow away the other —
 * rotating the cookie secret logs everyone out of a half-finished form, which is
 * cheap; rotating the hash salt resets every rate-limit counter, which is not.
 * Falls back to the cookie secret rather than to a constant, because a constant
 * salt makes the stored hashes a rainbow-table exercise over the /32 space.
 */
export function funnelHashSalt(): string | null {
  return process.env.FUNNEL_HASH_SALT ?? funnelSecret();
}

/** Is every server-side secret the funnel needs present? */
export function funnelSecretsConfigured(): boolean {
  return funnelSecret() !== null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(secret: string, data: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

/**
 * `<payload>.<signature>`, both base64url.
 *
 * Throws when the secret is missing rather than returning an unsigned value:
 * a caller that forgot to check `funnelSecretsConfigured()` must fail, never
 * quietly issue a cookie anyone can mint.
 */
export function signPayload(payload: unknown): string {
  const secret = funnelSecret();
  if (!secret) throw new Error("FUNNEL_COOKIE_SECRET is not set");
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${hmac(secret, body)}`;
}

/**
 * Verify and parse. Returns null on ANY failure — wrong shape, bad signature,
 * unparseable JSON, missing secret. One return value for every failure mode,
 * because a caller that could tell them apart would eventually branch on it.
 */
export function verifyPayload<T>(value: string | undefined | null): T | null {
  const secret = funnelSecret();
  if (!secret || !value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expected = Buffer.from(hmac(secret, body), "utf8");
  const actual = Buffer.from(sig, "utf8");
  // Length check first: timingSafeEqual THROWS on a length mismatch, and an
  // uncaught throw inside a cookie read is a 500 on every page that reads it.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * A salted, one-way key for the rate-limit table.
 *
 * The table must not become a second, unregulated copy of the personal data the
 * submissions table is careful about — and an IP address is personal data under
 * both the GDPR and the DPDP Act. Truncated to 32 hex characters: 128 bits is
 * far past any collision concern at this volume, and a shorter row is a smaller
 * index.
 */
export function rateLimitKey(kind: "ip" | "identity", value: string): string {
  const salt = funnelHashSalt();
  if (!salt) throw new Error("FUNNEL_HASH_SALT/FUNNEL_COOKIE_SECRET is not set");
  return `${kind}:${createHmac("sha256", salt).update(value).digest("hex").slice(0, 32)}`;
}
