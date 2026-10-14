/**
 * ONE PLACE THAT READS A SECRET, AND IT THROWS RATHER THAN GUESSING.
 *
 * ── WHAT THIS REPLACES, AND WHY IT WAS NOT "FINE" ───────────────────────────
 *
 * Four production code paths read a published literal as their default:
 *
 *   common/device-auth.guard.ts          process.env.JWT_SECRET ?? "dev-jwt-secret-change-me"
 *   common/device-nonce.ts
 *   modules/devices/devices.controller.ts
 *   modules/tenancy/erasure.controller.ts
 *
 * That was never live exposure. `assert-env.ts` rejects that exact literal and
 * an unset variable under NODE_ENV=production, so the process cannot reach
 * those lines carrying it - it dies in its restart loop first.
 *
 * The problem is the number of defences, not the current state.
 * `ADMIN_API_KEY` has two independent ones; this had exactly one, and this
 * repository is PUBLIC. A refactor that moves a boot path, an
 * `assertRequiredEnv()` call that stops running, a new entry point that skips
 * `instrumentation.ts`, a worker or a script that imports one of those four
 * modules without going through `main.ts` - any of those makes the fallback
 * live, and at that moment anyone who has read this repo can mint a device
 * token for any device in any tenant.
 *
 * A `??` that silently substitutes a known-public value is a defence that
 * fails OPEN. This one fails closed: a caller with no secret gets an
 * exception, which is a 500 and a loud log line rather than a working forgery.
 *
 * ── WHY THE DEV STORY DOES NOT GET WORSE ────────────────────────────────────
 *
 * Dev and test set a real value instead of inheriting a shared constant:
 * `.env.local` for development, and `guard-harness.spec.ts` already exports
 * `DEV_JWT_SECRET` for the suites that need to sign a token. The test side was
 * already done; only the production side was reading the constant.
 */

/**
 * Values that must never BE the secret, even where one is set.
 *
 * `assert-env.ts` holds the same list for the boot check. Repeated here
 * deliberately, and the duplication is the point: this is the second defence,
 * and a second defence that imports the first one shares its single point of
 * failure. `secrets.spec.ts` pins the two lists together so they cannot drift.
 */
const REJECTED = new Set([
  "dev-jwt-secret-change-me",
  "dev-secret",
  "changeme",
  "change-me",
  "replace-with-a-long-random-secret",
]);

/**
 * The HMAC secret for device access tokens, enrollment nonces and the erasure
 * receipt.
 *
 * Throws when unset or when it holds a published default. Call it at USE time,
 * never at module load: a module-scope `const secret = jwtSecret()` would make
 * every importing file - including the test harness and any script that
 * happens to import a controller - throw at import rather than at the call
 * that actually needs a secret.
 */
export function jwtSecret(): string {
  const raw = process.env.JWT_SECRET;
  if (!raw || REJECTED.has(raw)) {
    throw new Error(
      "JWT_SECRET is not configured" +
        (raw ? " (it holds a published development default)" : "") +
        ". It signs device tokens, enrollment nonces and erasure receipts; there is no " +
        "safe fallback, so this request fails rather than accepting a forgeable token.",
    );
  }
  return raw;
}

/** The rejected list, for the drift test. Not for use at a call site. */
export const REJECTED_JWT_SECRETS: ReadonlySet<string> = REJECTED;
