import { createHash, randomBytes } from "node:crypto";
import { getAdminPool } from "@aura/db";

/**
 * Minting the link that puts somebody back into their own half-finished form.
 *
 * ── THE TOKEN IS A BEARER CREDENTIAL ───────────────────────────────────────
 *
 * Whoever holds it can read and complete one stranger's enquiry. That is a low
 * ceiling — the data behind it is the name, email and phone THEY typed, plus
 * six multiple-choice answers — but it is not nothing, and it travels over
 * WhatsApp where it will sit in a chat log indefinitely.
 *
 * So it is treated like a session token, not like an id:
 *
 *   · 32 bytes from a CSPRNG. Not a uuid — uuids are for identifying rows, and
 *     v4 gives 122 bits with a recognisable shape that invites guessing at the
 *     rest of the table.
 *   · Only sha256 of it is stored. A dump of `funnel_resume_tokens` is then not
 *     a set of working links into other people's enquiries.
 *   · It expires, and the form refuses it once the enquiry is finished, so the
 *     window in which a leaked link is useful is bounded from both ends.
 *
 * ── WHY THE WORKER MINTS AND NOT THE WEBSITE ───────────────────────────────
 *
 * Migration 0033 gives `aura_marketing` SELECT and `UPDATE (used_at)` and
 * nothing else. An internet-facing server that can INSERT here is one that can
 * mint a working link into any enquiry in the table. The worker is not
 * reachable from the internet — the same boundary the outbox draws.
 */

/** 14 days. Must comfortably outlive the second nudge, which lands at 2 days. */
const TTL_DAYS = positiveInt(process.env.FUNNEL_RESUME_TTL_DAYS, 14);

/**
 * Where the public site lives, for building the link.
 *
 * FUNNEL_SITE_URL wins so a deployment can point the link somewhere else, but
 * SITE_DOMAIN is what production actually sets and is the realistic path.
 * Returns null rather than guessing: a nudge carrying `undefined/continue/…`
 * is worse than a nudge that does not go out, because the second is visible in
 * the outbox and the first is only visible on someone's phone.
 */
export function funnelSiteUrl(): string | null {
  const explicit = process.env.FUNNEL_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.SITE_DOMAIN?.trim();
  if (!domain) return null;
  return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

export function hashResumeToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Mint a token for this submission and return the full link.
 *
 * A NEW token every call, deliberately. Only the hash is stored, so the first
 * nudge's raw token cannot be recovered to reuse in the second. Both remain
 * valid until they expire, which is harmless: they are two links to the same
 * form, and the form refuses either once the enquiry is finished.
 *
 * Returns null when there is no site URL to build against — see funnelSiteUrl.
 */
export async function mintResumeLink(submissionId: string): Promise<string | null> {
  const site = funnelSiteUrl();
  if (!site) {
    console.error(
      "[resume-tokens] neither FUNNEL_SITE_URL nor SITE_DOMAIN is set, cannot build a resume link",
    );
    return null;
  }

  // base64url so it is safe in a path segment with no escaping, and so it
  // survives being copied out of WhatsApp by hand.
  const raw = randomBytes(32).toString("base64url");

  await getAdminPool().query(
    `INSERT INTO marketing.funnel_resume_tokens (token_hash, submission_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashResumeToken(raw), submissionId, TTL_DAYS],
  );

  return `${site}/continue/${raw}`;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
