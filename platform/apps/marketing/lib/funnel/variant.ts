/**
 * Split-test assignment — doc 16 §3.5, slice 5.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE STOPPING RULE, WRITTEN DOWN BEFORE THE FIRST VISITOR ARRIVES.         │
 * │                                                                           │
 * │ Call the test at 200 VISITORS PER VARIANT, or 4 WEEKS, whichever comes    │
 * │ first. Whatever the numbers look like at that point is the answer.        │
 * │                                                                           │
 * │ THE METRIC IS QUALIFIED SUBMISSIONS PER 100 VISITORS.                     │
 * │   numerator:   funnel_submissions WHERE status = 'qualified'              │
 * │                GROUP BY variant                                           │
 * │   denominator: unique visitors assigned to that variant                   │
 * │                                                                           │
 * │ NOT raw submissions. Form-first will win on volume — it asks for a phone  │
 * │ number before it has earned one — and will probably lose on quality.      │
 * │ Measuring the top of the funnel would therefore pick the variant that     │
 * │ produces more work and less revenue, and the dashboard would look great   │
 * │ while it happened.                                                        │
 * │                                                                           │
 * │ Deciding when to stop AFTER seeing the numbers is how split tests lie: at │
 * │ n=40 the lead is noise, and an experimenter who peeks and stops on a good │
 * │ day is running a random number generator with extra steps. That is the    │
 * │ only reason this paragraph is here instead of in a wiki nobody reads.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ── Mechanics ───────────────────────────────────────────────────────────────
 * Assignment happens ONCE, in middleware.ts, and is pinned in a signed httpOnly
 * cookie. A returning visitor stays in their variant; if they did not, a person
 * who bounced off the demo on Monday and converted on the form on Thursday would
 * be counted in both arms and the comparison would measure nothing.
 *
 * Signed because a client-writable variant is a client-writable experiment.
 * httpOnly because nothing on the page has any business reading it — and because
 * the analytics story here is Plausible, which is cookieless: a consent banner on
 * a site selling data protection is a bad look (§3.5).
 *
 * ── Why Web Crypto and not ./signing.ts ─────────────────────────────────────
 * This module is imported by `middleware.ts`, which runs on the Edge runtime
 * where `node:crypto` does not exist. `crypto.subtle` is present in BOTH the
 * Edge runtime and Node 22, so one implementation covers both. It produces
 * exactly the same HMAC-SHA256 as ./signing.ts — same secret, same base64url —
 * so the two are interchangeable on the wire; they differ only in being async.
 */

import { FUNNEL_VARIANTS, type FunnelVariant } from "./shared";

export { FUNNEL_VARIANTS };
export type { FunnelVariant };

export const VARIANT_COOKIE = "aura_funnel_variant";

/**
 * 90 days. Longer than the 4-week stopping rule on purpose: the cookie has to
 * outlive the experiment, or a visitor assigned in week 4 who converts in week 5
 * gets re-rolled and lands in the other arm's numerator.
 */
export const VARIANT_MAX_AGE_S = 90 * 24 * 60 * 60;

/** The route each variant's entry composition lives at (§3.5). */
export const VARIANT_ROUTE: Record<FunnelVariant, string> = {
  demo_first: "/",
  form_first: "/start",
};

export interface VariantPayload {
  v: FunnelVariant;
  /** issued-at, epoch ms — only for debugging cohort boundaries. */
  iat: number;
}

export function isFunnelVariant(value: unknown): value is FunnelVariant {
  return typeof value === "string" && (FUNNEL_VARIANTS as readonly string[]).includes(value);
}

/**
 * A fair coin.
 *
 * `Math.random()` and not a hash of the IP: hashing an identifier makes
 * assignment deterministic, which sounds tidier and quietly correlates the arms
 * with whatever the identifier correlates with — carrier NAT ranges, in this
 * market, which is to say geography. A coin has no such structure.
 */
export function pickVariant(random: number = Math.random()): FunnelVariant {
  return random < 0.5 ? "demo_first" : "form_first";
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

/** Same fail-closed rule as ./signing.ts — no secret, no cookie, no experiment. */
function secret(): string | null {
  const s = process.env.FUNNEL_COOKIE_SECRET;
  return s && s.length >= 32 ? s : null;
}

export async function signVariantCookie(variant: FunnelVariant): Promise<string | null> {
  const key = secret();
  if (!key) return null;
  const body = b64url(new TextEncoder().encode(JSON.stringify({ v: variant, iat: Date.now() })));
  return `${body}.${await hmac(key, body)}`;
}

/**
 * Verify and read. Null on any failure, including a missing secret.
 *
 * Constant-time comparison over the signature bytes: this is a low-value target,
 * but the same helper shape will be copied the next time a cookie matters, and
 * a `===` here is what gets copied with it.
 */
export async function readVariantCookie(value: string | undefined | null): Promise<FunnelVariant | null> {
  const key = secret();
  if (!key || !value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const expected = await hmac(key, body);
  const sig = value.slice(dot + 1);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as VariantPayload;
    return isFunnelVariant(payload.v) ? payload.v : null;
  } catch {
    return null;
  }
}
