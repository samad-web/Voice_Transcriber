/**
 * `DeviceAuthGuard` - the handset fleet's only credential (inventory 13 §2.5, D1-D10).
 *
 * This guard authenticates EVERY device route: `POST /v1/calls` (ingest),
 * `POST /v1/calls/:id/complete`, `GET /v1/devices/me/config` and the three
 * telemetry routes (inventory 13 §1.1 rows 22, 23, 44, 48-50). It is also the
 * one guard on the platform that trusts a bearer token's CONTENTS: `org_id`,
 * `instance_id` and the device id are copied verbatim off the JWT
 * (`device-auth.guard.ts:38-43`) and nothing is re-read from the database. So a
 * token forged against the signing secret does not merely impersonate one
 * handset - it names its own tenant. The signature IS the tenant boundary here,
 * which is why D4 and the `alg`/algorithm cases below are pinned as hard as the
 * happy path.
 *
 * `JWT_SECRET` IS SET EXPLICITLY in `beforeEach` (inventory 13 §5.5). The guard
 * reads it through `jwtSecret()` at call time, so a runner or CI shell
 * exporting a real value would otherwise fail every case in this file with no
 * defect present - the `pipeline.test.ts:74` failure mode report 12 §5.6
 * records. Several cases deliberately override it; all restore.
 *
 * The harness signs with `DEV_JWT_SECRET`, which is NO LONGER the published
 * `dev-jwt-secret-change-me` - `jwtSecret()` now refuses that literal outright
 * (doc 49 P6a), so a harness still signing with it would exercise a path
 * production cannot take. `PUBLISHED_DEV_JWT_SECRET` is kept for the two cases
 * that prove the refusal.
 *
 * Nothing here opens a socket or a database connection: the guard has no
 * injected dependencies at all, which is itself asserted below.
 */
import { generateKeyPairSync } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { DeviceAuthGuard } from "./device-auth.guard";
import { TenantGuard } from "./tenant.guard";
import {
  DEVICE_A,
  DEV_JWT_SECRET,
  PUBLISHED_DEV_JWT_SECRET,
  INSTANCE_A,
  MALFORMED_INSTANCE_ID,
  ORG_A,
  ORG_B,
  expectHttpError,
  makeExecutionContext,
} from "./guard-harness.spec";

/** `:28` - the header is absent or is not a `Bearer ` credential. */
const NO_TOKEN = "device access token required";
/** `:46` - everything else, from a bad signature to the wrong scope. */
const BAD_TOKEN = "invalid or expired device token";

const bearer = (token: string): string => `Bearer ${token}`;

/**
 * Exactly the claim set `devices.controller.ts:186-195` signs. `sub` is NOT in
 * here - it is set by the `subject` sign option (inventory 13 §5.5), and a test
 * that put it in the literal instead would be testing a token this platform
 * never mints.
 */
function devicePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scope: "device", org_id: ORG_A, instance_id: INSTANCE_A, cfg_ver: 3, ...overrides };
}

interface SignOpts {
  secret?: string;
  /** Omitted entirely when undefined - that is how the D7 "no sub" case is built. */
  subject?: string;
  expiresIn?: string;
  algorithm?: jwt.Algorithm;
}

function signToken(payload: Record<string, unknown> | string, opts: SignOpts = {}): string {
  const signOptions: jwt.SignOptions = {};
  if (opts.subject !== undefined) signOptions.subject = opts.subject;
  if (opts.expiresIn !== undefined) {
    // The @types/jsonwebtoken `expiresIn` is a template-literal union in v9;
    // the cast keeps "-1s" (the D5 fixture) expressible without widening the
    // helper's own signature to `any`.
    signOptions.expiresIn = opts.expiresIn as jwt.SignOptions["expiresIn"];
  }
  if (opts.algorithm !== undefined) signOptions.algorithm = opts.algorithm;
  return jwt.sign(payload, opts.secret ?? DEV_JWT_SECRET, signOptions);
}

/** A token indistinguishable from one `POST /v1/devices/authenticate` just issued. */
function validDeviceToken(overrides: Record<string, unknown> = {}, opts: SignOpts = {}): string {
  return signToken(devicePayload(overrides), {
    subject: DEVICE_A,
    expiresIn: "15m",
    ...opts,
  });
}

/**
 * An `alg: "none"` token: real header, real payload, EMPTY signature. Hand-built
 * because `jwt.sign` refuses to produce one - which is the point. The attack is
 * "strip the signature and tell the verifier there never was one".
 */
function algNoneToken(payload: Record<string, unknown>): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none", typ: "JWT" })}.${seg(payload)}.`;
}

describe("DeviceAuthGuard", () => {
  let guard: DeviceAuthGuard;

  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.JWT_SECRET = DEV_JWT_SECRET;
    guard = new DeviceAuthGuard();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("has no injected dependencies - it can never consult the database", async () => {
    // Not a triviality: it is the structural reason the device's `status` and
    // its org's `status` are unknown to this guard, which is what the
    // "stale token" group below asserts behaviourally. If a dependency is ever
    // added, that group's comments stop being true and this fails first.
    expect(DeviceAuthGuard.length).toBe(0);
    const moduleRef = await Test.createTestingModule({ providers: [DeviceAuthGuard] }).compile();
    expect(moduleRef.get(DeviceAuthGuard)).toBeInstanceOf(DeviceAuthGuard);
  });

  // ── the credential itself ──────────────────────────────────────────────────
  describe("the Authorization header", () => {
    it("D1 · 401s a request with no Authorization header", async () => {
      const { context, req } = makeExecutionContext();

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: NO_TOKEN,
        status: 401,
      });
      expect(req.device).toBeUndefined();
    });

    it("D2 · 401s a non-Bearer scheme, and the LOWER-CASE `bearer` too", async () => {
      // `startsWith("Bearer ")` (`:27`) is case-sensitive and includes the
      // trailing space. RFC 7235 says the scheme is case-insensitive, so a
      // client sending `bearer` is refused by this platform specifically - pin
      // it, because "it works in curl but not from the handset" is otherwise a
      // day of debugging.
      for (const header of [
        "Basic ZGV2aWNlOnNlY3JldA==",
        `bearer ${validDeviceToken()}`,
        `BEARER ${validDeviceToken()}`,
        validDeviceToken(), // the raw token with no scheme at all
        `Bearer${validDeviceToken()}`, // no space
        "Bearer", // the word alone
      ]) {
        const { context, req } = makeExecutionContext({ headers: { authorization: header } });

        await expectHttpError(() => guard.canActivate(context), {
          type: UnauthorizedException,
          message: NO_TOKEN,
          status: 401,
        });
        expect(req.device).toBeUndefined();
      }
    });

    it("D2/D3 · `Bearer ` with an EMPTY token takes the other branch and other message", async () => {
      // The prefix check passes, so this is a 401 `invalid or expired device
      // token`, not `device access token required`. Same status, different
      // message - and the message is what an on-call engineer greps for.
      const { context } = makeExecutionContext({ headers: { authorization: "Bearer " } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
    });

    it("D3 · 401s garbage that is not a JWT at all", async () => {
      for (const token of ["garbage", "a.b", "a.b.c", "....", "eyJhbGciOiJIUzI1NiJ9"]) {
        const { context, req } = makeExecutionContext({
          headers: { authorization: bearer(token) },
        });

        await expectHttpError(() => guard.canActivate(context), {
          type: UnauthorizedException,
          message: BAD_TOKEN,
          status: 401,
        });
        expect(req.device).toBeUndefined();
      }
    });
  });

  // ── the signature: this is the whole tenant boundary ───────────────────────
  describe("signature and algorithm", () => {
    it("D4 · 401s a well-formed token signed with a DIFFERENT secret", async () => {
      // THE case. Every claim in this token is correct - right scope, right
      // device, unexpired, ORG_A - and it is refused solely because the HMAC
      // does not verify. Since `org_id` is read verbatim (`:40`), the signature
      // is the only thing standing between an attacker and ingest into any
      // tenant they name.
      const token = validDeviceToken({}, { secret: "wrong-secret" });
      const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
      expect(req.device).toBeUndefined();
    });

    it("D4 · 401s a token whose signature was truncated or swapped", async () => {
      const [header, payload, signature] = validDeviceToken().split(".");
      const other = validDeviceToken({ cfg_ver: 99 }).split(".")[2];

      for (const token of [
        `${header}.${payload}.`, // signature removed
        `${header}.${payload}.${signature.slice(0, -2)}`, // truncated
        `${header}.${payload}.${other}`, // a valid signature over DIFFERENT claims
      ]) {
        const { context } = makeExecutionContext({ headers: { authorization: bearer(token) } });

        await expectHttpError(() => guard.canActivate(context), {
          type: UnauthorizedException,
          message: BAD_TOKEN,
          status: 401,
        });
      }
    });

    it("401s an `alg: none` token", async () => {
      // The signature-stripping attack, stated as its own case because the
      // guard passes NO `algorithms` option to `jwt.verify` (`:31-34`) - the
      // rejection comes from jsonwebtoken's own default, not from this code.
      // If that library default ever changed, or the call gained an
      // `algorithms: [...]` list that included "none", this is the test that
      // fires.
      const { context, req } = makeExecutionContext({
        headers: { authorization: bearer(algNoneToken({ ...devicePayload(), sub: DEVICE_A })) },
      });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
      expect(req.device).toBeUndefined();
    });

    it("401s an RS256 token - the classic algorithm-confusion attempt", async () => {
      // jsonwebtoken v9 defaults `algorithms` to the HMAC family when the key is
      // a string secret, so an asymmetrically signed token cannot be presented
      // and verified against the shared secret as though it were public key
      // material. That default is doing security work the guard does not do for
      // itself; pin it here so an upgrade that relaxes it is caught.
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const token = jwt.sign(devicePayload(), privateKey, {
        algorithm: "RS256",
        subject: DEVICE_A,
        expiresIn: "15m",
      });
      const { context } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
    });

    it("401s HS384/HS512 over the same secret - only HS256 is accepted", async () => {
      // The guard now passes `algorithms: ["HS256"]` to `jwt.verify` (`:31-35`),
      // defense in depth against algorithm confusion even though the platform
      // only ever mints HS256 (`devices.controller.ts:193` passes a string key
      // and no `algorithm`). This replaces the old "no algorithm is pinned"
      // case: HS384/HS512 tokens over the same secret are no longer accepted.
      for (const algorithm of ["HS384", "HS512"] as const) {
        const token = validDeviceToken({}, { algorithm });
        const { context, req } = makeExecutionContext({
          headers: { authorization: bearer(token) },
        });

        await expectHttpError(() => guard.canActivate(context), {
          type: UnauthorizedException,
          message: BAD_TOKEN,
          status: 401,
        });
        expect(req.device).toBeUndefined();
      }
    });
  });

  // ── the secret itself (report 12 §2.3) ─────────────────────────────────────
  describe("the JWT_SECRET fallback (report 12 §2.3)", () => {
    it("refuses a token when JWT_SECRET is unset - in EVERY environment", async () => {
      // THIS CASE USED TO ASSERT THE OPPOSITE, and the inversion is the fix
      // (doc 49 P6a). The guard read
      // `process.env.JWT_SECRET ?? "dev-jwt-secret-change-me"`, one of four
      // sites doing the same, and that literal is published in this
      // repository's .env.example. A deployment that forgot JWT_SECRET
      // therefore accepted device tokens minted by anyone who had read the
      // repo, for any org_id they cared to name.
      //
      // `assertRequiredEnv()` meant the process could not reach that line in
      // production - but that was the ONLY defence, where ADMIN_API_KEY has
      // two, and this repository is public. A refactor that moves a boot path
      // or an entry point that skips the assertion made it live.
      //
      // Not gated on NODE_ENV, deliberately. The previous plan for this fix was
      // "no fallback under production", which leaves a dev machine happily
      // accepting forgeries and leaves the failure mode one env var away. There
      // is no environment in which signing with a published constant is right.
      delete process.env.JWT_SECRET;
      const token = validDeviceToken({}, { secret: PUBLISHED_DEV_JWT_SECRET });
      const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
      expect(req.device).toBeUndefined();
    });

    it("refuses a token even when JWT_SECRET is EXPLICITLY the published literal", async () => {
      // The second half, and the one an "unset check" would have missed. A
      // deployment that copied .env.example and filled in everything except
      // this is indistinguishable from one that forgot the variable, so the
      // rejected-value list matters as much as the unset check.
      process.env.JWT_SECRET = PUBLISHED_DEV_JWT_SECRET;
      const token = validDeviceToken({}, { secret: PUBLISHED_DEV_JWT_SECRET });
      const { context } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
    });

    it("refuses a dev-literal token once a REAL JWT_SECRET is configured", async () => {
      // The rotation property: after `JWT_SECRET` is set, every token minted
      // against the published literal is dead. Without this, the case above
      // could pass for the wrong reason (a guard that verified nothing at all
      // would satisfy it).
      process.env.JWT_SECRET = "a-real-production-secret";
      const token = validDeviceToken({}, { secret: PUBLISHED_DEV_JWT_SECRET });
      const { context } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
    });

    it("reads JWT_SECRET per request, not once at module load", async () => {
      // A rotated secret must take effect on the next request. If the guard ever
      // hoists the secret into a module-level const, the old secret keeps
      // working until the process restarts - silently, and for as long as the
      // container lives.
      process.env.JWT_SECRET = "rotated-secret";
      const rotated = makeExecutionContext({
        headers: { authorization: bearer(validDeviceToken({}, { secret: "rotated-secret" })) },
      });
      expect(guard.canActivate(rotated.context)).toBe(true);

      const stale = makeExecutionContext({
        headers: { authorization: bearer(validDeviceToken()) },
      });
      await expectHttpError(() => guard.canActivate(stale.context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
    });
  });

  // ── expiry ─────────────────────────────────────────────────────────────────
  describe("expiry", () => {
    it("D5 · 401s an EXPIRED token, mapping TokenExpiredError to the generic 401", async () => {
      // The 15-minute window (`devices.controller.ts:194`) is the only thing
      // bounding a leaked token's usefulness. Note the guard's `catch` (`:45`)
      // swallows jsonwebtoken's `TokenExpiredError` and emits the same message
      // as a bad signature - deliberate (it tells an attacker nothing) and worth
      // pinning, because a handset seeing this message must re-authenticate
      // rather than retry.
      const token = validDeviceToken({}, { expiresIn: "-1s" });
      const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
      expect(req.device).toBeUndefined();
    });

    it("D5 · allows a token still inside its 15-minute window", () => {
      const { context } = makeExecutionContext({
        headers: { authorization: bearer(validDeviceToken({}, { expiresIn: "15m" })) },
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it("allows a token with NO exp claim at all - nothing forces expiry here", async () => {
      // Pinned as today's behaviour. `expiresIn` is supplied by the SIGNING side
      // (`devices.controller.ts:194`), and `jwt.verify` is called with no
      // `maxAge` and no required-claims option (`:31-34`), so a token minted
      // without `exp` never expires. Only `devices.controller.ts` mints these
      // today, so this is reachable only with the signing secret - but it means
      // the 15-minute bound is a property of the issuer, not of the guard.
      const token = signToken(devicePayload(), { subject: DEVICE_A });
      const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      expect(guard.canActivate(context)).toBe(true);
      expect(req.device?.deviceId).toBe(DEVICE_A);
    });
  });

  // ── payload shape ──────────────────────────────────────────────────────────
  describe("payload claims", () => {
    it("allows a well-formed token and lands the full principal on the request", () => {
      const { context, req } = makeExecutionContext({
        headers: { authorization: bearer(validDeviceToken()) },
      });

      expect(guard.canActivate(context)).toBe(true);
      // The exact shape every device handler reads. `deviceId` comes from `sub`
      // (set by the `subject` sign option), NOT from a `device_id` claim.
      expect(req.device).toEqual({
        deviceId: DEVICE_A,
        orgId: ORG_A,
        instanceId: INSTANCE_A,
        cfgVer: 3,
      });
    });

    it("D6 · 401s a valid signature carrying the WRONG scope", async () => {
      // A session token, an erasure token - anything the platform signs with the
      // same secret for another purpose must not open the device routes. The
      // throw at `:36` is caught by the guard's own `catch` at `:45` and
      // remapped, so this is indistinguishable from a bad signature to the
      // caller by design.
      for (const scope of ["user", "session", "erasure", "", null, undefined, 1]) {
        const token = signToken(devicePayload({ scope }), {
          subject: DEVICE_A,
          expiresIn: "15m",
        });
        const { context, req } = makeExecutionContext({
          headers: { authorization: bearer(token) },
        });

        await expectHttpError(() => guard.canActivate(context), {
          type: UnauthorizedException,
          message: BAD_TOKEN,
          status: 401,
        });
        expect(req.device).toBeUndefined();
      }
    });

    it("D7 · 401s a token whose `sub` is missing or not a string", async () => {
      // `deviceId` is `payload.sub` (`:39`) and flows straight into
      // `WHERE d.id = $1` (`devices.controller.ts:228`,
      // `calls.controller.ts:136`). A numeric or absent `sub` reaching the
      // handler would be a parameterised query against a non-uuid - the
      // `typeof === "string"` check at `:35` is what stops it.
      const cases: Array<Record<string, unknown>> = [
        devicePayload({ sub: 12345 }),
        devicePayload({ sub: null }),
        devicePayload({ sub: { id: DEVICE_A } }),
        devicePayload(), // no `subject` option and no `sub` claim
      ];
      for (const payload of cases) {
        const token = signToken(payload, { expiresIn: "15m" });
        const { context, req } = makeExecutionContext({
          headers: { authorization: bearer(token) },
        });

        await expectHttpError(() => guard.canActivate(context), {
          type: UnauthorizedException,
          message: BAD_TOKEN,
          status: 401,
        });
        expect(req.device).toBeUndefined();
      }
    });

    it("401s a token whose payload is a bare string, not an object", async () => {
      // `jwt.verify` returns a string for a non-JSON payload; the guard casts to
      // `JwtPayload` (`:34`) and reads `.scope` off it, which is `undefined`.
      // The scope check catches it - this asserts the cast is not load-bearing.
      const token = signToken("device");
      const { context } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
    });

    it("D8 · defaults cfgVer to 0 when `cfg_ver` is absent or null", () => {
      // `payload.cfg_ver ?? 0` (`:42`). `instances.config_version` defaults to 0
      // (`0001:81`) and the handset compares it to decide whether to re-fetch
      // its config, so a wrong default here means either a config-fetch storm or
      // a fleet that never picks up a `PATCH /v1/org/policy` change.
      for (const [claim, expected] of [
        [undefined, 0],
        [null, 0],
        [0, 0],
        [7, 7],
      ] as Array<[unknown, number]>) {
        const payload = devicePayload({ cfg_ver: claim });
        if (claim === undefined) delete payload.cfg_ver;
        const token = signToken(payload, { subject: DEVICE_A, expiresIn: "15m" });
        const { context, req } = makeExecutionContext({
          headers: { authorization: bearer(token) },
        });

        expect(guard.canActivate(context)).toBe(true);
        expect(req.device?.cfgVer).toBe(expected);
      }
    });
  });

  // ── the tenant claims: finding 4, inventory 13 §7, CLOSED by doc 49 P6b ────
  describe("every claim the handlers trust is validated (P6b)", () => {
    it("D9 · rejects a token that names no tenant", async () => {
      // WAS "D9 · ALLOWS ...", and the inversion is the fix. Neither claim was
      // validated - no presence check, no uuid parse - so `req.device.orgId`
      // reached `withOrg(undefined, …)` in every device handler, which sets
      // `app.org_id` from nothing and hands RLS a null tenant. What RLS does
      // with that is not a question worth having an answer to.
      const token = signToken(
        { scope: "device", cfg_ver: 3 },
        { subject: DEVICE_A, expiresIn: "15m" },
      );
      const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
      expect(req.device).toBeUndefined();
    });

    it("D9 · rejects org_id / instance_id that are not uuids at all", async () => {
      // The SQL-injection-shaped org_id is not the threat - every query in this
      // codebase is parameterised - but it is the clearest possible evidence
      // that nothing was parsing the claim. Compare `TenantGuard:77`, which has
      // always parsed the org with zod before pinning it; the device path now
      // has its equivalent.
      for (const payload of [
        { org_id: "'; DROP TABLE calls; --" },
        { instance_id: 42 },
        { org_id: MALFORMED_INSTANCE_ID },
        { instance_id: MALFORMED_INSTANCE_ID },
        { org_id: "" },
        { org_id: null },
      ]) {
        const token = validDeviceToken(payload);
        const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

        await expectHttpError(() => guard.canActivate(context), {
          type: UnauthorizedException,
          message: BAD_TOKEN,
          status: 401,
        });
        expect(req.device).toBeUndefined();
      }
    });

    it("rejects a subject that is not a device id", async () => {
      // `sub` becomes `WHERE d.id = $1`. A non-uuid there is a type error from
      // Postgres - a 500 on an unauthenticated route - rather than a 401.
      const token = signToken(
        { scope: "device", org_id: ORG_A, instance_id: INSTANCE_A, cfg_ver: 3 },
        { subject: "not-a-uuid", expiresIn: "15m" },
      );
      const { context } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
    });

    it("D10 · WRONG TENANT - a token naming another org is scoped to that org", () => {
      // PINNED DELIBERATELY, and this is the concrete mechanism behind report
      // 12 §2.3. DEVICE_A belongs to ORG_A (inventory 13 §5.6). A token whose
      // `org_id` says ORG_B is accepted and every subsequent query runs under
      // ORG_B, because the guard never asks the database which org this device
      // actually belongs to. Forging the signature is the ONLY barrier - which
      // is why the D4 and JWT_SECRET cases above matter as much as they do.
      const token = validDeviceToken({ org_id: ORG_B });
      const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      expect(guard.canActivate(context)).toBe(true);
      expect(req.device?.orgId).toBe(ORG_B);
      expect(req.device?.deviceId).toBe(DEVICE_A);
    });

    it.skip("D10 (correct) · rejects a token whose org_id is not the device's own org", async () => {
      // STAYS SKIPPED, and after doc 49 P6b that is a decision rather than a
      // backlog item. Read it with the two cases above and the guard's own
      // class comment.
      //
      // The guard cannot tell whether DEVICE_A belongs to ORG_B without a
      // database read, and it deliberately does not do one: this is the hottest
      // `@SkipThrottle()`d route on the platform, and a round trip per ingest
      // request is a real cost for a check that is already made one layer down.
      //
      // WHERE IT IS ACTUALLY CLOSED. Every device handler opens
      // `db.withOrg(req.device.orgId, …)` and then reads its own device row by
      // id. A token claiming ORG_B therefore enters ORG_B's RLS context and
      // finds NO row for DEVICE_A - because the row is in ORG_A - so
      // `calls.controller.ts` throws 409 "device or org is not active" and
      // `devices.controller.ts` throws 401 "device not found". The claim does
      // not grant access to the named tenant; it grants a context in which the
      // caller owns nothing.
      //
      // That is enforced by RLS rather than by this file, so the assertion
      // belongs in the isolation suite (which runs against a real database),
      // not here. What this suite CAN pin, and now does, is that the claim is a
      // well-formed uuid - so the context is never opened from undefined.
      //
      // Un-skip only if the guard is given a cached device lookup. If somebody
      // does that, delete the three paragraphs above rather than leaving them
      // to contradict the code.
      const token = validDeviceToken({ org_id: ORG_B });
      const { context } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: BAD_TOKEN,
        status: 401,
      });
    });
  });

  // ── the guard/handler split for device state ───────────────────────────────
  describe("stale tokens: revocation is the HANDLER's job, not this guard's", () => {
    it("allows a token for a device that is logged out, wiped, deleted, or in a suspended org", () => {
      // Inventory 13 §2.5: nothing in `req.device` is re-read from the database,
      // so `POST /v1/devices/:id/logout` and `/wipe` do NOT invalidate an
      // already-issued token - it stays cryptographically valid for its full 15
      // minutes. What actually refuses it is the handler:
      //   · `calls.controller.ts:131-142` - SELECTs `d.status` and `o.status`
      //     and throws **409** `device or org is not active - recording is
      //     disabled`;
      //   · `devices.controller.ts:225-235` - 401 `device not found` for a
      //     deleted row, and `recordingEnabled:false` for a non-active device or
      //     a suspended org.
      // That split is the contract, and asserting it here is what stops someone
      // "tidying up" by moving the status check into the guard (which would need
      // a database round-trip on the hottest, `@SkipThrottle()`d route on the
      // platform) or out of the handlers (which would un-revoke the fleet).
      // Note the DIFFERENT status codes: 409 on ingest, 401 on config. A test
      // asserting only "it threw" would not tell those apart.
      const token = validDeviceToken();
      const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      expect(guard.canActivate(context)).toBe(true);
      expect(req.device?.deviceId).toBe(DEVICE_A);
    });

    it("allows a token naming a device id that exists in no tenant", () => {
      // Same property from the other side: `sub` is any string the signer chose.
      // A device row deleted by `DELETE /v1/instances/:id` (cascade) leaves its
      // token verifying fine; the 401 comes from `devices.controller.ts:230`
      // when the row lookup misses. The guard cannot and does not know.
      const token = validDeviceToken({}, { subject: "00000000-0000-4000-8000-00000000dead" });
      const { context, req } = makeExecutionContext({ headers: { authorization: bearer(token) } });

      expect(guard.canActivate(context)).toBe(true);
      expect(req.device?.deviceId).toBe("00000000-0000-4000-8000-00000000dead");
    });
  });

  // ── separation from the console's guard chain ──────────────────────────────
  describe("separation from the principal-based guards", () => {
    it("never sets req.principal, so a device token cannot reach a tenant-scoped route", async () => {
      // Inventory 13 §2.0: `DeviceAuthGuard` is independent of the
      // AdminKey/Tenant chain and never coexists with it - `req.device` and
      // `req.principal` are separate properties on separate route sets. This
      // pins the consequence that matters: replay a device token against a
      // console route and `TenantGuard` 401s, because the device guard populated
      // nothing it reads. If `DeviceAuthGuard` ever started setting
      // `req.principal` as a convenience, a handset credential would become an
      // org-scoped console credential.
      const { context, req } = makeExecutionContext({
        headers: { authorization: bearer(validDeviceToken()) },
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(req.principal).toBeUndefined();
      expect(req.tenantOrgId).toBeUndefined();

      await expectHttpError(() => new TenantGuard(new Reflector()).canActivate(context), {
        type: UnauthorizedException,
        message: "authentication required",
        status: 401,
      });
    });
  });
});
