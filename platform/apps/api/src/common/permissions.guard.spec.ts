/**
 * `PermissionsGuard` - the recordings privacy grants (inventory 13 §2.3, P1-P8).
 *
 * Mounted on exactly ONE route in the whole platform today,
 * `GET /v1/calls/:id/audio` with `@RequirePermission("recordings:listen")`
 * (calls.controller.ts:393). That makes the guard's behaviour easy to change by
 * accident and hard to notice - hence the table.
 */
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSIONS, principalHasPermission } from "./auth-principal";
import { RequirePermission, PermissionsGuard } from "./permissions.guard";
import {
  adminKeyPrincipal,
  expectHttpError,
  makeExecutionContext,
  sessionPrincipal,
} from "./guard-harness.spec";

/** Mirrors CallsController: the decorator sits on the handler, not the class. */
class AudioController {
  @RequirePermission("recordings:listen")
  audio(): void {}

  /** Every other route on the controller - no decorator, guard inert. */
  list(): void {}
}

/** Class-level grant with a handler-level override, to pin the resolution order. */
@RequirePermission("recordings:export")
class ExportController {
  @RequirePermission("recordings:listen")
  listen(): void {}

  exportAll(): void {}
}

describe("principalHasPermission", () => {
  it("declares exactly the two permissions the platform knows about", () => {
    // If a third is added, the guard's table below is incomplete - fail here.
    expect([...PERMISSIONS]).toEqual(["recordings:listen", "recordings:export"]);
  });

  it("short-circuits for admin-key and platform_admin REGARDLESS of the two flags", () => {
    // auth-principal.ts:35. The flags are not even read on this path, which is
    // why P3/P4 below matter more than they look.
    const viaKey = adminKeyPrincipal({ recordingsListen: false, recordingsExport: false });
    expect(principalHasPermission(viaKey, "recordings:listen")).toBe(true);
    expect(principalHasPermission(viaKey, "recordings:export")).toBe(true);

    const platformAdmin = sessionPrincipal({
      role: "platform_admin",
      recordingsListen: false,
      recordingsExport: false,
    });
    expect(principalHasPermission(platformAdmin, "recordings:listen")).toBe(true);
  });

  it("reads the membership flags for a session principal", () => {
    const listener = sessionPrincipal({ recordingsListen: true, recordingsExport: false });
    expect(principalHasPermission(listener, "recordings:listen")).toBe(true);
    expect(principalHasPermission(listener, "recordings:export")).toBe(false);
  });
});

describe("PermissionsGuard", () => {
  let guard: PermissionsGuard;
  beforeEach(() => {
    guard = new PermissionsGuard(new Reflector());
  });

  it("P1 · allows any request on a route with no @RequirePermission", () => {
    const { context } = makeExecutionContext({
      cls: AudioController,
      handler: AudioController.prototype.list,
      principal: sessionPrincipal({ role: "viewer", recordingsListen: false }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("P2 · 403s when no principal was set (guard-order bug)", async () => {
    const { context } = makeExecutionContext({
      cls: AudioController,
      handler: AudioController.prototype.audio,
    });

    // Note this is a 403, not the 401 TenantGuard raises for the same missing
    // principal - asserting the type here is what makes that distinction real.
    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "missing permission: recordings:listen",
      status: 403,
    });
  });

  it("P3 · allows the admin-key principal - every console request today", () => {
    // CONSEQUENCE WORTH KNOWING (inventory 13 §2.3): the web tier holds the
    // admin key (server-api.ts:17), so every console request arrives
    // viaAdminKey:true and `recordings:listen` is NOT enforced for any console
    // user. The permission is real only for a `Bearer aus_` session. Stage 2.4
    // changes how the web tier authenticates; when it does, this test tells you
    // whether that changed.
    const { context } = makeExecutionContext({
      cls: AudioController,
      handler: AudioController.prototype.audio,
      principal: adminKeyPrincipal({ recordingsListen: false }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("P4 · allows a platform_admin session", () => {
    const { context } = makeExecutionContext({
      cls: AudioController,
      handler: AudioController.prototype.audio,
      principal: sessionPrincipal({ role: "platform_admin", recordingsListen: false }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("P5 · allows an org_admin session holding the grant", () => {
    const { context } = makeExecutionContext({
      cls: AudioController,
      handler: AudioController.prototype.audio,
      principal: sessionPrincipal({ role: "org_admin", recordingsListen: true }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("P6 · 403s a VIEWER without the grant", async () => {
    const { context } = makeExecutionContext({
      cls: AudioController,
      handler: AudioController.prototype.audio,
      principal: sessionPrincipal({ role: "viewer", recordingsListen: false }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "missing permission: recordings:listen",
      status: 403,
    });
  });

  it("P8 · 403s an org_admin whose grant was revoked - role does not imply the grant", async () => {
    // recordings_listen/export default FALSE in 0001:67-68 and POST /v1/members
    // writes both false, so "org_admin but no grant" is the common shape, not
    // an exotic one.
    const { context } = makeExecutionContext({
      cls: AudioController,
      handler: AudioController.prototype.audio,
      principal: sessionPrincipal({ role: "org_admin", recordingsListen: false }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "missing permission: recordings:listen",
      status: 403,
    });
  });

  it("P7 · enforces recordings:export where it is declared (no route requires it today)", async () => {
    const { context } = makeExecutionContext({
      cls: ExportController,
      handler: ExportController.prototype.exportAll,
      principal: sessionPrincipal({ recordingsExport: false }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "missing permission: recordings:export",
      status: 403,
    });
  });

  it("resolves the handler's permission over the controller's", async () => {
    // getAllAndOverride([handler, class]): a handler needing `listen` inside a
    // controller needing `export` must be checked against `listen`.
    const { context } = makeExecutionContext({
      cls: ExportController,
      handler: ExportController.prototype.listen,
      principal: sessionPrincipal({ recordingsListen: false, recordingsExport: true }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "missing permission: recordings:listen",
      status: 403,
    });
  });
});
