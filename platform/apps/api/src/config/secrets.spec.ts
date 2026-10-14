import { jwtSecret, REJECTED_JWT_SECRETS } from "./secrets";
import { REQUIRED } from "./assert-env";

/**
 * THE SECOND DEFENCE, AND THE TEST THAT KEEPS IT A SECOND ONE.
 *
 * `JWT_SECRET` signs device access tokens, the enrollment nonces and the
 * erasure receipt HMAC. Four production paths used to read
 * `process.env.JWT_SECRET ?? "dev-jwt-secret-change-me"`, a literal published
 * in this repository's own `.env.example`. That was never live exposure -
 * `assertRequiredEnv()` rejects it at boot under NODE_ENV=production - but it
 * was the ONLY defence, where `ADMIN_API_KEY` has two, and the repository is
 * public.
 *
 * `jwtSecret()` is the second defence: a `??` that substitutes a known-public
 * value fails OPEN, and this fails closed.
 *
 * Two things have to stay true for that to be worth anything, and neither is
 * visible to a typechecker:
 *
 *   1. it must throw rather than return anything when unset or defaulted; and
 *   2. its rejected-value list must not drift from `assert-env.ts`'s. The two
 *      lists are deliberately separate - a second defence that imports the
 *      first shares its single point of failure - which is exactly the shape
 *      that drifts silently. This is the test that notices.
 */
describe("jwtSecret", () => {
  const saved = process.env.JWT_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  });

  it("returns a configured secret", () => {
    process.env.JWT_SECRET = "a-real-production-secret-9f8e7d";
    expect(jwtSecret()).toBe("a-real-production-secret-9f8e7d");
  });

  it("throws when unset, in every environment", () => {
    // NOT gated on NODE_ENV. The earlier plan for this fix was "no fallback
    // under production", which leaves a dev machine happily accepting
    // forgeries and leaves the failure mode one env var away from being live.
    delete process.env.JWT_SECRET;
    for (const env of ["production", "development", "test", undefined]) {
      const savedEnv = process.env.NODE_ENV;
      if (env === undefined) delete (process.env as Record<string, unknown>).NODE_ENV;
      else (process.env as Record<string, unknown>).NODE_ENV = env;
      try {
        expect(() => jwtSecret()).toThrow(/JWT_SECRET is not configured/);
      } finally {
        if (savedEnv === undefined) delete (process.env as Record<string, unknown>).NODE_ENV;
        else (process.env as Record<string, unknown>).NODE_ENV = savedEnv;
      }
    }
  });

  it("throws on the empty string, which is how a blank line in an env file arrives", () => {
    process.env.JWT_SECRET = "";
    expect(() => jwtSecret()).toThrow(/not configured/);
  });

  it("throws on every published default, even when explicitly set", () => {
    // The case an unset-check alone would miss: a deployment that copied
    // .env.example and filled in everything except this one is
    // indistinguishable from one that forgot the variable.
    for (const bad of REJECTED_JWT_SECRETS) {
      process.env.JWT_SECRET = bad;
      expect(() => jwtSecret()).toThrow(/published development default/);
    }
  });

  it("rejects at least everything assert-env rejects", () => {
    // THE DRIFT GUARD. `assert-env.ts` refuses these at boot; `jwtSecret()`
    // refuses them per call. A value on the boot list but not here would pass
    // the second defence - which is the only one that still applies after a
    // refactor moves a boot path or adds an entry point that skips the
    // assertion.
    //
    // One-directional on purpose: this list may be a superset. Nothing breaks
    // if jwtSecret() is stricter than the boot check.
    const bootList = REQUIRED.find((r) => r.name === "JWT_SECRET");
    expect(bootList).toBeDefined();
    const missing = (bootList!.rejected ?? []).filter((v) => !REJECTED_JWT_SECRETS.has(v));
    expect(missing).toEqual([]);
  });
});
