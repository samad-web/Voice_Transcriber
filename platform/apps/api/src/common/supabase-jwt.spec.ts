import { generateKeyPairSync } from "node:crypto";
import * as jwt from "jsonwebtoken";
import {
  looksLikeJwt,
  resetSupabaseJwksCache,
  supabaseJwtConfigured,
  SupabaseTokenError,
  verifySupabaseJwt,
} from "./supabase-jwt";

/**
 * THE API VERIFYING A SESSION FOR ITSELF (doc 49 P5-A).
 *
 * Until this existed, the API verified no Supabase JWT at all: the web tier
 * called `getClaims()` and forwarded the result as trusted facts
 * (`x-caller-user-id`, `x-caller-auth-id`, `x-operator-email`) alongside the
 * root admin key. Coherent, and with one consequence: `ADMIN_API_KEY` is a
 * single credential that reads and writes every tenant, with no second factor,
 * no per-tenant scoping and no expiry.
 *
 * Every case here is a way that verifier could be wrong in a manner no
 * typechecker and no happy-path test would notice. Three of them are the
 * classic JWT verification holes, and all three have shipped in real products:
 *
 *   * `alg: none` accepted because `algorithms` was not pinned;
 *   * an RS256 token accepted by verifying its own PUBLIC KEY as an HMAC
 *     secret, because the verifier chose the algorithm from the token;
 *   * the ANON key accepted as a user session, because both are signed by the
 *     same GoTrue with the same secret and only `role` tells them apart. That
 *     one would make the key published in every browser bundle an API
 *     credential.
 */

const SECRET = "test-supabase-jwt-secret-at-least-32-chars-long";
const SUBJECT = "11111111-1111-4111-8111-111111111111";

function hs256(payload: Record<string, unknown>, secret = SECRET): string {
  return jwt.sign({ sub: SUBJECT, role: "authenticated", ...payload }, secret, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
}

beforeEach(() => {
  resetSupabaseJwksCache();
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.SUPABASE_INTERNAL_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
  jest.restoreAllMocks();
});

describe("looksLikeJwt", () => {
  it("recognises a JWT and not the API's own session token", () => {
    expect(looksLikeJwt(hs256({}))).toBe(true);
    // The routing property: `aus_` sessions are handled by a different branch,
    // and this must not claim them.
    expect(looksLikeJwt("aus_abcdef0123456789")).toBe(false);
    expect(looksLikeJwt("")).toBe(false);
    expect(looksLikeJwt("not.a.jwt")).toBe(false);
  });
});

describe("supabaseJwtConfigured", () => {
  it("is false with neither a secret nor a URL, so the branch is skipped entirely", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(supabaseJwtConfigured()).toBe(false);
  });

  it("is false for the published placeholder secret", () => {
    // The Supabase self-host default, which appears in their own docs and in
    // every copied .env. A placeholder fails OPEN if accepted, so it is treated
    // as absent - the same rule `jwtSecret()` applies to its own literal.
    process.env.SUPABASE_JWT_SECRET =
      "super-secret-jwt-token-with-at-least-32-characters-long";
    expect(supabaseJwtConfigured()).toBe(false);
  });

  it("is true with a URL alone, so an asymmetric-key deployment works", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_INTERNAL_URL = "http://supabase-kong:8000/auth/v1";
    expect(supabaseJwtConfigured()).toBe(true);
  });
});

describe("HS256 (the self-hosted shared secret)", () => {
  it("verifies a signed-in user's token and returns the subject", async () => {
    const claims = await verifySupabaseJwt(hs256({ email: "asha@example.com" }));
    expect(claims.sub).toBe(SUBJECT);
    expect(claims.email).toBe("asha@example.com");
  });

  it("refuses a token signed with the wrong secret", async () => {
    await expect(verifySupabaseJwt(hs256({}, "a-different-secret"))).rejects.toThrow(
      SupabaseTokenError,
    );
  });

  it("refuses an expired token", async () => {
    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "-1h",
    });
    await expect(verifySupabaseJwt(token)).rejects.toThrow(/did not verify/);
  });

  it("REFUSES THE ANON KEY, which is signed by the same GoTrue", async () => {
    // The worst outcome available on this path. `anon` is the PUBLIC key in
    // every browser bundle and on the marketing site; it verifies against this
    // same secret because the same GoTrue issued it, and only `role`
    // distinguishes it from a signed-in person.
    await expect(verifySupabaseJwt(hs256({ role: "anon" }))).rejects.toThrow(/not authenticated/);
    await expect(verifySupabaseJwt(hs256({ role: "service_role" }))).rejects.toThrow(
      /not authenticated/,
    );
    await expect(verifySupabaseJwt(hs256({ role: undefined }))).rejects.toThrow(
      /not authenticated/,
    );
  });

  it("refuses a token with no subject", async () => {
    const token = jwt.sign({ role: "authenticated" }, SECRET, { algorithm: "HS256" });
    await expect(verifySupabaseJwt(token)).rejects.toThrow(/no subject/);
  });

  it("refuses alg:none", async () => {
    // Hand-assembled, because `jsonwebtoken` will not sign one. This is the
    // oldest JWT hole there is and it only stays closed because `algorithms` is
    // passed explicitly on every verify call in this file.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: SUBJECT,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    await expect(verifySupabaseJwt(token)).rejects.toThrow(SupabaseTokenError);
  });

  it("refuses an RS256 token while configured for HS256", async () => {
    // The algorithm-confusion case. With `algorithms: ["HS256"]` pinned, an
    // asymmetric token cannot be smuggled past a symmetric verifier - which is
    // the shape where a public key gets used as an HMAC secret.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, privateKey, {
      algorithm: "RS256",
      expiresIn: "1h",
    });
    await expect(verifySupabaseJwt(token)).rejects.toThrow(SupabaseTokenError);
  });
});

describe("JWKS (asymmetric keys)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const KID = "key-one";

  function serveJwks(keys: Array<Record<string, unknown>>) {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys }),
    })) as unknown as typeof fetch;
  }

  function jwk() {
    return { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };
  }

  beforeEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_INTERNAL_URL = "http://supabase-kong:8000/auth/v1";
  });

  it("verifies against a published key", async () => {
    serveJwks([jwk()]);
    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, privateKey, {
      algorithm: "ES256",
      keyid: KID,
      expiresIn: "1h",
    });
    await expect(verifySupabaseJwt(token)).resolves.toMatchObject({ sub: SUBJECT });
  });

  it("re-fetches once for an unknown key id, so a rotation does not lock everyone out", async () => {
    // Served empty first, then with the key: the retry is what turns a
    // rotation from an hour-long outage (the cache TTL) into one extra fetch.
    let call = 0;
    global.fetch = jest.fn(async () => {
      call++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ keys: call === 1 ? [] : [jwk()] }),
      };
    }) as unknown as typeof fetch;

    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, privateKey, {
      algorithm: "ES256",
      keyid: KID,
      expiresIn: "1h",
    });
    // The first fetch returns no usable keys at all, which throws; the point of
    // this case is the SECOND attempt succeeding once the key is published.
    await expect(verifySupabaseJwt(token)).rejects.toThrow();
    await expect(verifySupabaseJwt(token)).resolves.toMatchObject({ sub: SUBJECT });
  });

  it("caches, so the auth path is not a fetch per request", async () => {
    serveJwks([jwk()]);
    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, privateKey, {
      algorithm: "ES256",
      keyid: KID,
      expiresIn: "1h",
    });
    await verifySupabaseJwt(token);
    await verifySupabaseJwt(token);
    await verifySupabaseJwt(token);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a token whose key id is not published", async () => {
    serveJwks([{ ...jwk(), kid: "some-other-key" }]);
    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, privateKey, {
      algorithm: "ES256",
      keyid: KID,
      expiresIn: "1h",
    });
    await expect(verifySupabaseJwt(token)).rejects.toThrow(/no published key/);
  });

  it("refuses an HS256 token on the asymmetric path", async () => {
    // The mirror of the confusion case above. A token claiming HS256 names no
    // key this path can use, and `verifyWith`'s allowlist is asymmetric-only,
    // so a forged HS256 token signed with a guessed secret cannot be verified
    // against a published public key.
    serveJwks([jwk()]);
    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, "guessed-secret", {
      algorithm: "HS256",
      keyid: KID,
      expiresIn: "1h",
    });
    await expect(verifySupabaseJwt(token)).rejects.toThrow(/not accepted/);
  });

  it("does not fail closed on ONE unusable key in the set", async () => {
    // A rotation legitimately publishes a key type we do not support. One bad
    // entry must not make the whole set unusable.
    serveJwks([{ kty: "OKP", crv: "Ed25519", x: "nonsense", kid: "weird" }, jwk()]);
    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, privateKey, {
      algorithm: "ES256",
      keyid: KID,
      expiresIn: "1h",
    });
    await expect(verifySupabaseJwt(token)).resolves.toMatchObject({ sub: SUBJECT });
  });

  it("refuses when the JWKS endpoint is unreachable", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const token = jwt.sign({ sub: SUBJECT, role: "authenticated" }, privateKey, {
      algorithm: "ES256",
      keyid: KID,
      expiresIn: "1h",
    });
    // Fails CLOSED. An auth path that accepts a token because it could not
    // check it is not an auth path.
    await expect(verifySupabaseJwt(token)).rejects.toThrow();
  });
});
