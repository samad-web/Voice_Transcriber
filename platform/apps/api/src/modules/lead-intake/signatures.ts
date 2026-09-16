import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Payload signature verification for the intake webhooks (migration 0078).
 *
 * ── WHAT A SIGNATURE IS FOR HERE, AND WHAT IT IS NOT ──────────────────────
 *
 * The token in the URL already authenticates the caller and names the tenant.
 * A signature adds the one thing a token cannot: proof that THIS vendor sent
 * THIS body. It matters because an intake token is not a secret - a web form
 * token ships in the tenant's own HTML, and a telephony token sits in a
 * vendor's dashboard where several people can read it.
 *
 * So signatures are OPTIONAL and per-source: configured, they are enforced;
 * unconfigured, the token stands alone, which is the same posture the
 * messaging webhook (0056) has had since it shipped. What is NOT allowed is a
 * source that declares a scheme and then accepts unsigned traffic - that is a
 * control that looks present and is not, so `verifyIntakeSignature` fails
 * closed on a missing signature whenever a secret exists.
 *
 * Every comparison is timing-safe. Not because a timing attack on a webhook is
 * likely, but because the safe primitive costs nothing and the unsafe one is
 * indistinguishable from it in review.
 */

/** Constant-time compare of two ASCII digests of any length. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare a fixed-size digest of each instead so every path costs
  // the same.
  const digest = (buf: Buffer) => createHmac("sha256", "length-guard").update(buf).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/**
 * Twilio's own scheme: HMAC-SHA1, base64, over the full request URL with every
 * POST parameter appended in key-sorted order as `keyvalue`.
 *
 * The URL must be exactly the one Twilio was configured with, including scheme
 * and any port - which is why it is passed in rather than derived from headers
 * here. Behind a proxy, `X-Forwarded-Proto` matters and getting it wrong makes
 * every signature fail; the caller owns that decision.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, unknown>,
  signature: string | undefined,
  authToken: string,
): boolean {
  if (!signature) return false;
  let payload = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    payload += key + (value === null || value === undefined ? "" : String(value));
  }
  const expected = createHmac("sha1", authToken).update(Buffer.from(payload, "utf8")).digest("base64");
  return safeEqual(expected, signature);
}

/**
 * Mailgun signs in the body, not a header: HMAC-SHA256 hex over
 * `timestamp + token` with the webhook signing key.
 *
 * The timestamp is also checked for freshness. Without it a captured POST can
 * be replayed forever, and replaying an inbound email means re-creating a lead
 * that was already handled - which the intake ledger would catch by
 * Message-Id, but only because that happens to be present. Five minutes is
 * Mailgun's own recommendation.
 */
export function verifyMailgunSignature(
  timestamp: string | undefined,
  token: string | undefined,
  signature: string | undefined,
  signingKey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !token || !signature) return false;
  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > 300) return false;
  const expected = createHmac("sha256", signingKey).update(`${timestamp}${token}`).digest("hex");
  return safeEqual(expected, signature);
}

/** The common case: hex HMAC-SHA256 of the raw body in a header. */
export function verifyHmacSha256Body(
  rawBody: Buffer | string | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!rawBody || !signature) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  // Vendors disagree about whether to prefix the algorithm; accept both rather
  // than have a tenant debug a mismatch that is purely cosmetic.
  const offered = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  return safeEqual(expected, offered);
}

export interface SignatureContext {
  scheme: "none" | "twilio" | "hmac_sha256_body" | "mailgun";
  secret: string | null;
  /** Absolute URL the vendor posted to. Twilio only. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  rawBody?: Buffer;
}

function header(headers: SignatureContext["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Apply whichever scheme this source declares.
 *
 * Returns a REASON on failure rather than a boolean, because the reason is
 * written to the intake ledger and is the only thing that tells a tenant
 * whether they pasted the wrong signing key or their vendor is not signing at
 * all. It is never returned in the HTTP response - a caller that failed
 * verification learns nothing beyond a 404.
 */
export function verifyIntakeSignature(ctx: SignatureContext): string | null {
  // No secret stored: the token is the credential, by the tenant's own choice.
  if (!ctx.secret) return null;

  switch (ctx.scheme) {
    case "twilio": {
      const signature = header(ctx.headers, "x-twilio-signature");
      if (!signature) return "no X-Twilio-Signature header on a source configured to require one";
      return verifyTwilioSignature(ctx.url, ctx.body, signature, ctx.secret)
        ? null
        : "X-Twilio-Signature did not match - check the auth token and the exact callback URL";
    }
    case "mailgun": {
      const ok = verifyMailgunSignature(
        String(ctx.body.timestamp ?? ""),
        String(ctx.body.token ?? ""),
        String(ctx.body.signature ?? ""),
        ctx.secret,
      );
      return ok ? null : "Mailgun signature did not match, or the payload is older than 5 minutes";
    }
    case "hmac_sha256_body": {
      const signature = header(ctx.headers, "x-aura-signature") ?? header(ctx.headers, "x-signature");
      if (!signature) return "no X-Aura-Signature header on a source configured to require one";
      return verifyHmacSha256Body(ctx.rawBody, signature, ctx.secret)
        ? null
        : "X-Aura-Signature did not match the request body";
    }
    case "none":
    default:
      // A secret stored against a provider with no scheme is a configuration
      // mistake, not a reason to reject traffic. Say so in the ledger.
      return null;
  }
}
