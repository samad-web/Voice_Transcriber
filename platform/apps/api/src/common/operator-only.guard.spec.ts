import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { OperatorOnlyGuard } from "./operator-only.guard";
import type { Principal } from "./auth-principal";

/**
 * The guard that keeps tenant console users off the operator's instance
 * routes - the ones that mint enrollment tokens.
 *
 * Both directions matter equally here, and each has a real failure behind it:
 * letting a console user through re-opens the gap this closed, and refusing the
 * bare admin key would break operator provisioning and every ops script.
 */
function ctx(principal: Partial<Principal> | null) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as never;
}

const OPERATOR: Partial<Principal> = {
  // What admin-key.guard.ts writes when no caller header is present.
  userId: "admin-key",
  orgId: "00000000-0000-4000-8000-000000000001",
  role: "platform_admin",
  viaAdminKey: true,
};

const CONSOLE_USER: Partial<Principal> = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "00000000-0000-4000-8000-000000000001",
  role: "org_admin",
  viaAdminKey: true,
};

describe("OperatorOnlyGuard", () => {
  const guard = new OperatorOnlyGuard();

  it("admits the bare platform admin key", () => {
    // The operator console and the ops scripts. Refusing this would break the
    // people these routes exist for.
    expect(guard.canActivate(ctx(OPERATOR))).toBe(true);
  });

  it("refuses an owner-console user, whatever persona they claim", () => {
    // The whole point: the web tier proxies owner-console requests on the
    // platform admin key, so `viaAdminKey` is true for them too and every
    // admin-key-based check is inert. The user id is what separates them.
    expect(() => guard.canActivate(ctx(CONSOLE_USER))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx({ ...CONSOLE_USER, ownerRole: "owner" }))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(ctx({ ...CONSOLE_USER, role: "platform_admin" }))).toThrow(
      ForbiddenException,
    );
  });

  it("refuses a direct Bearer session too", () => {
    // A real person either way. The rule is "no user identity", not "no
    // caller header", so a different transport cannot slip past it.
    expect(() =>
      guard.canActivate(ctx({ ...CONSOLE_USER, viaAdminKey: false })),
    ).toThrow(ForbiddenException);
  });

  it("401s when it runs before AdminKeyGuard", () => {
    // Guard order is wrong. Same status and reasoning as TenantGuard's
    // equivalent branch - this is a misconfiguration, not a denial.
    expect(() => guard.canActivate(ctx(null))).toThrow(UnauthorizedException);
  });

  it("does not treat a non-uuid caller id as a user", () => {
    // Anything that is not a uuid came from the credential rather than from a
    // person, and must not be mistaken for one in either direction.
    expect(guard.canActivate(ctx({ ...OPERATOR, userId: "dev-admin" }))).toBe(true);
    expect(guard.canActivate(ctx({ ...OPERATOR, userId: "" }))).toBe(true);
  });
});
