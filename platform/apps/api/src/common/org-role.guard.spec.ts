/**
 * `OrgRoleGuard` — enforces `@RequireOrgRole(...)` against `principal.role`
 * directly, for the org-administration routes that are not CRM records at
 * all (members, api keys, org policy/branding, a role's own grant grid,
 * device wipe/logout, workspace creation, GDPR/DPDP erasure).
 *
 * Same harness as the other guard suites: a real `Reflector` over real
 * decorator metadata, no database, no HTTP server.
 */
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  adminKeyPrincipal,
  expectHttpError,
  makeExecutionContext,
  sessionPrincipal,
} from "./guard-harness.spec";
import { OrgRoleGuard, RequireOrgRole } from "./org-role.guard";

class FixtureController {
  @RequireOrgRole("org_admin")
  promoteMember(): void {}

  undecorated(): void {}
}

function contextFor(handler: (...args: never[]) => unknown, principal: ReturnType<typeof sessionPrincipal> | undefined) {
  return makeExecutionContext({ principal, handler, cls: FixtureController });
}

describe("OrgRoleGuard", () => {
  it("O1 ignores a route carrying no @RequireOrgRole", async () => {
    const guard = new OrgRoleGuard(new Reflector());
    const { context } = contextFor(FixtureController.prototype.undecorated, sessionPrincipal());

    expect(guard.canActivate(context)).toBe(true);
  });

  it("O2 allows an org_admin session", async () => {
    const guard = new OrgRoleGuard(new Reflector());
    const { context } = contextFor(
      FixtureController.prototype.promoteMember,
      sessionPrincipal({ role: "org_admin" }),
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it("O3 denies a viewer session — the escalation this guard exists to close", async () => {
    // Before this guard, a freshly-invited viewer could PATCH their own
    // membership's role to org_admin: nothing downstream ever read
    // `principal.role`. This is that exact scenario.
    const guard = new OrgRoleGuard(new Reflector());
    const { context } = contextFor(
      FixtureController.prototype.promoteMember,
      sessionPrincipal({ role: "viewer" }),
    );

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires org role: org_admin",
      status: 403,
    });
  });

  it("O4 denies a workspace_admin and a workspace_member session too", async () => {
    const guard = new OrgRoleGuard(new Reflector());
    for (const role of ["workspace_admin", "workspace_member"] as const) {
      const { context } = contextFor(
        FixtureController.prototype.promoteMember,
        sessionPrincipal({ role }),
      );
      await expectHttpError(() => guard.canActivate(context), {
        type: ForbiddenException,
        message: "requires org role: org_admin",
        status: 403,
      });
    }
  });

  it("O5 allows the admin key — the platform's own root credential, not a tenant role", async () => {
    const guard = new OrgRoleGuard(new Reflector());
    const { context } = contextFor(FixtureController.prototype.promoteMember, adminKeyPrincipal());

    expect(guard.canActivate(context)).toBe(true);
  });

  it("O6 rejects when no principal is present (guard mounted before AdminKeyGuard)", async () => {
    const guard = new OrgRoleGuard(new Reflector());
    const { context } = contextFor(FixtureController.prototype.promoteMember, undefined);

    await expectHttpError(() => guard.canActivate(context), {
      type: UnauthorizedException,
      message: "authentication required",
      status: 401,
    });
  });
});
