import { pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The one-time code an administrator reads off their phone (migration 0122).
 *
 * ── WHY IT IS HASHED AT ALL ───────────────────────────────────────────────
 *
 * Six digits is about twenty bits. Stored in clear, a leaked `otp_hash`
 * column would be exactly as useful to an attacker as no code at all, and
 * every live request in the table would be redeemable. Stored as PBKDF2 with
 * a real work factor, a leaked column is worth very little in the ten minutes
 * before the codes expire.
 *
 * The work factor is NOT what makes guessing hopeless, though - twenty bits
 * falls to a determined online attacker whatever the hash costs. The attempt
 * cap in the controller is what does that, and the two are meant to be read
 * together: the cap stops online guessing, the hash stops offline guessing.
 *
 * Same self-describing format and the same OWASP-2023 iteration count as
 * `app-lock-hash.ts`, so a future bump to either does not invalidate codes
 * already issued.
 */
const KEY_LENGTH_BYTES = 32;
const ITERATIONS = 210_000;

/**
 * Six digits from a CSPRNG.
 *
 * `randomInt` and not `Math.random()`, and not `randomBytes(n) % 1000000`
 * either: the modulo of a byte string over a range that does not divide the
 * space evenly is biased toward the low codes, and a biased code is a smaller
 * keyspace than it looks. `randomInt` rejects and resamples for us.
 *
 * Padded rather than ranged from 100000 so that every code is six characters
 * and "042913" is as likely as any other - a code that can never start with a
 * zero has lost a tenth of its space for cosmetic reasons.
 */
export function generateCallAccessOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashCallAccessOtp(code: string): string {
  // 16 bytes from the CSPRNG, same as app-lock-hash.ts. NOT `randomInt` over
  // MAX_SAFE_INTEGER: Node caps that range at 2^48, so it throws at runtime -
  // and it would have given a salt with barely more entropy than the code it
  // is meant to protect.
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(code, salt, ITERATIONS, KEY_LENGTH_BYTES, "sha256");
  return `pbkdf2$${ITERATIONS}$${salt}$${hash.toString("hex")}`;
}

/**
 * Constant-time check of a presented code against a stored hash.
 *
 * Returns false rather than throwing on a malformed or absent hash: the
 * caller's question is "may this person in", and an unreadable stored value
 * is a no. Throwing would turn a corrupt row into a 500 that an attacker
 * could tell apart from a wrong code.
 */
export function verifyCallAccessOtp(code: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(parts[3], "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH_BYTES) return false;

  const actual = pbkdf2Sync(code, parts[2], iterations, KEY_LENGTH_BYTES, "sha256");
  // Lengths are equal by construction above, which `timingSafeEqual` requires -
  // it throws on a mismatch rather than returning false.
  return timingSafeEqual(actual, expected);
}

/**
 * The last three digits of a phone number, for the record of where a code
 * went.
 *
 * Three, not four and not the whole thing: enough for an administrator to
 * recognise their own number in an audit trail, not enough for the trail to
 * become a second copy of it. Matches the `otp_sent_to_last3` CHECK in 0122
 * and the same choice `calls.remote_number_last3` made in 0001.
 */
export function lastThreeDigits(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 3 ? digits.slice(-3) : null;
}
