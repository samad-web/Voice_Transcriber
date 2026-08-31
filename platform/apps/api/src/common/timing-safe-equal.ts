import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for credentials (the admin key, checked in
 * both admin-key.guard.ts and config/throttling.ts - one helper so the two
 * can't drift, per throttling.ts's own note that this was "one finding, to
 * fix in one place").
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false,
 * and a plain length check first would itself leak the secret's length
 * through timing - so a mismatch is folded into an equal-length dummy
 * comparison instead of an early return.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
