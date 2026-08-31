/**
 * `OwnerRoleGuard` - the owner console's personas (inventory 13 §2.4, O1-O10).
 *
 * STAGE 2.5 (checklist 08 §2.5) - CLOSED. This guard used to trust the
 * caller's own claim about its persona (`principal.ownerRole`, populated by
 * admin-key.guard.ts purely from the caller-supplied `x-caller-owner-role`
 * header) - any admin-key holder could assert `owner` and be believed, or
 * omit the header and be waved through unchecked. It now derives the persona
 * itself from `memberships` via `AuthService.ownerRoleFor`, the same table a
 * Bearer session's `ownerRole` already came from (that path was never the
 * bypass and is unchanged below). The two fail-opens that remain (O1/O2 -
 * mounting without a requirement is not enforcement, and O5 - a membership
 * that predates 0018 defaults to the most permissive persona) are unrelated
 * to Stage 2.5 and stay exactly as documented.
 *
 * Mounted on one controller: `OwnerController`. Only
 * `PATCH /v1/owner/telecallers/:deviceId` declares roles - `GET /v1/owner/overview`
 * mounts the guard and declares none, which case O1 shows is inert.
 */
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OwnerRoleGuard, RequireOwnerRole } from "./owner-role.guard";
import { AuthService } from "../modules/auth/auth.service";
import {
  ORG_A,
  USER_A,
  adminKeyPrincipal,
  expectHttpError,
  makeExecutionContext,
  sessionPrincipal,
} from "./guard-harness.spec";

/** Mirrors OwnerController: class-level guard, per-handler role requirements. */
class OwnerFixtureController {
  /** `GET /v1/owner/overview` - guard mounted, no @RequireOwnerRole. */
  overview(): void {}

  /** `PATCH /v1/owner/telecallers/:deviceId` - the only route that declares roles. */
  @RequireOwnerRole("owner", "manager")
  updateTelecaller(): void {}

  @RequireOwnerRole("owner")
  ownerOnly(): void {}

  /** Declared with no roles at all - the empty-array branch. */
  @RequireOwnerRole()
  empty(): void {}
}

describe("OwnerRoleGuard", () => {
  const auth = { ownerRoleFor: jest.fn() };
  let guard: OwnerRoleGuard;

  beforeEach(() => {
    auth.ownerRoleFor.mockReset();
    guard = new OwnerRoleGuard(new Reflector(), auth as unknown as AuthService);
  });

  it("O1 · is INERT on a route that declares no roles (GET /v1/owner/overview)", async () => {
    // Mounting the guard is not enforcement. A telecaller persona reads the
    // whole-org dashboard today because this route never declares a
    // requirement - the guard returns at owner-role.guard.ts's first check,
    // before it would ever need to resolve a persona.
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.overview,
      principal: adminKeyPrincipal({ ownerRole: "telecaller" }),
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(auth.ownerRoleFor).not.toHaveBeenCalled();
  });

  it("O2 · allows when @RequireOwnerRole() names no roles", async () => {
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.empty,
      principal: adminKeyPrincipal({ ownerRole: "telecaller" }),
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(auth.ownerRoleFor).not.toHaveBeenCalled();
  });

  it("O3 · 403s when no principal was set (guard-order bug)", async () => {
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "owner role required",
      status: 403,
    });
  });

  it("O4 · DENIES an admin-key caller with no resolvable user (the bare key itself)", async () => {
    // `adminKeyPrincipal()` defaults `userId` to the literal string
    // "admin-key" - not a uuid, so there is no membership row to look up at
    // all. This used to fail OPEN (any admin-key caller that omitted
    // `x-caller-owner-role` was waved through unchecked); it now fails
    // CLOSED, and does so without even reaching the database - a credential
    // with no user behind it has no persona to grant.
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ ownerRole: null }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires owner role: owner or manager",
      status: 403,
    });
    expect(auth.ownerRoleFor).not.toHaveBeenCalled();
  });

  it("O5 · FAILS OPEN for a session principal with a null persona (resolveOwnerRole → owner)", async () => {
    // The remaining fail-open, in @aura/shared (roles.ts): null resolves to
    // the MOST permissive persona. Deliberate - it covers memberships that
    // predate 0018 - and unrelated to Stage 2.5, since a session's ownerRole
    // never came from a caller-suppliable header in the first place.
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: sessionPrincipal({ ownerRole: null }),
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("O5b · the SAME null-persona default applies to an admin-key caller with a real, pre-0018 membership", async () => {
    // Parity check: the default in O5 is a property of a membership row
    // whose owner_role predates 0018, not of the session auth mechanism -
    // an admin-key caller resolving to the SAME row must get the SAME
    // default, not a denial just because of which door it came in.
    auth.ownerRoleFor.mockResolvedValue(null);
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ userId: USER_A, ownerRole: "owner" }),
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(auth.ownerRoleFor).toHaveBeenCalledWith(USER_A, ORG_A);
  });

  it("O6 · 403s an admin-key caller whose REAL membership (from the database) is telecaller", async () => {
    // The caller's own claim (`principal.ownerRole: "owner"`, as if it had
    // sent x-caller-owner-role: owner) is deliberately WRONG here - proving
    // the guard follows what `ownerRoleFor` returns, not what the request
    // asserts about itself.
    auth.ownerRoleFor.mockResolvedValue("telecaller");
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ userId: USER_A, ownerRole: "owner" }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires owner role: owner or manager",
      status: 403,
    });
    expect(auth.ownerRoleFor).toHaveBeenCalledWith(USER_A, ORG_A);
  });

  it("O7 · allows an admin-key caller whose REAL membership (from the database) is manager", async () => {
    auth.ownerRoleFor.mockResolvedValue("manager");
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ userId: USER_A, ownerRole: "telecaller" }),
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(auth.ownerRoleFor).toHaveBeenCalledWith(USER_A, ORG_A);
  });

  it("O8 · 403s a manager on an owner-only route, and names the requirement", async () => {
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.ownerOnly,
      principal: sessionPrincipal({ ownerRole: "manager" }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires owner role: owner",
      status: 403,
    });
  });

  it("O9 · a mis-cased persona claim on the admin-key principal itself is IGNORED, not enforced", async () => {
    // The historical version of this case (report 12 §5.1 / inventory 13's
    // O9) was about `x-caller-owner-role: Telecaller` slipping past
    // enforcement via the old null-means-pass fail-open - a DIFFERENT bug
    // from a DIFFERENT mechanism than O4's. That header is no longer read
    // for an admin-key principal AT ALL (see owner-role.guard.ts), so the
    // vector it described no longer exists: whatever `principal.ownerRole`
    // says, correctly or mis-cased, is irrelevant once `viaAdminKey` is
    // true. This asserts that directly - a maximally-permissive local claim
    // does not survive contact with a real (and here, restrictive) database
    // answer.
    auth.ownerRoleFor.mockResolvedValue("telecaller");
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ userId: USER_A, ownerRole: "owner" }),
      headers: { "x-caller-owner-role": "Owner" },
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires owner role: owner or manager",
      status: 403,
    });
  });

  it("O10 · enforces the persona for a session principal that HAS one", async () => {
    // The only path where enforcement was ever non-advisory: a Bearer aus_
    // session whose membership carries owner_role. Unchanged by Stage 2.5.
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: sessionPrincipal({ ownerRole: "owner" }),
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies a session telecaller - the persona is enforced when it is known", async () => {
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: sessionPrincipal({ ownerRole: "telecaller" }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires owner role: owner or manager",
      status: 403,
    });
  });
});
