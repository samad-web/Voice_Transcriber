/**
 * `OwnerRoleGuard` — the owner console's personas (inventory 13 §2.4, O1–O9).
 *
 * This guard is ADVISORY today and the tests below say so out loud. Two
 * separate fail-opens (`:53` for an admin-key caller with no asserted persona,
 * and `resolveOwnerRole`'s null default at roles.ts:22) mean a request can hold
 * a restricted persona and still pass. Both are pinned as today's behaviour with
 * a `.skip`ped sibling asserting the correct behaviour, so closing either one is
 * a deliberate act with a test that turns green, not a silent change.
 *
 * Mounted on one controller: `OwnerController`. Only
 * `PATCH /v1/owner/telecallers/:deviceId` declares roles — `GET /v1/owner/overview`
 * mounts the guard and declares none, which case O1 shows is inert.
 */
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OwnerRoleGuard, RequireOwnerRole } from "./owner-role.guard";
import {
  adminKeyPrincipal,
  expectHttpError,
  makeExecutionContext,
  sessionPrincipal,
} from "./guard-harness.spec";

/** Mirrors OwnerController: class-level guard, per-handler role requirements. */
class OwnerFixtureController {
  /** `GET /v1/owner/overview` — guard mounted, no @RequireOwnerRole. */
  overview(): void {}

  /** `PATCH /v1/owner/telecallers/:deviceId` — the only route that declares roles. */
  @RequireOwnerRole("owner", "manager")
  updateTelecaller(): void {}

  @RequireOwnerRole("owner")
  ownerOnly(): void {}

  /** Declared with no roles at all — the empty-array branch. */
  @RequireOwnerRole()
  empty(): void {}
}

describe("OwnerRoleGuard", () => {
  let guard: OwnerRoleGuard;
  beforeEach(() => {
    guard = new OwnerRoleGuard(new Reflector());
  });

  it("O1 · is INERT on a route that declares no roles (GET /v1/owner/overview)", () => {
    // Mounting the guard is not enforcement. A telecaller persona reads the
    // whole-org dashboard today because this route never declares a
    // requirement — the guard returns at owner-role.guard.ts:36.
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.overview,
      principal: adminKeyPrincipal({ ownerRole: "telecaller" }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("O2 · allows when @RequireOwnerRole() names no roles", () => {
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.empty,
      principal: adminKeyPrincipal({ ownerRole: "telecaller" }),
    });

    expect(guard.canActivate(context)).toBe(true);
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

  it("O4 · FAILS OPEN for an admin-key caller that asserted no persona", async () => {
    // PINNED DELIBERATELY (checklist 08 §2.5, owner-role.guard.ts:53). The
    // persona comes only from the caller-supplied `x-caller-owner-role` header,
    // so ANY holder of the admin key bypasses EVERY @RequireOwnerRole on the
    // platform by simply not sending it. This is the transition state while
    // seed scripts and ops tooling still call the API without a persona.
    // Deleting the fail-open must be a deliberate act — that is what this test
    // and its skipped sibling are for.
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ ownerRole: null }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it.skip("O4 (correct) · denies an admin-key caller that asserted no persona", async () => {
    // Un-skip when Stage 2.5 lands: the API must resolve the persona itself
    // from memberships.owner_role (migration 0018) instead of reading it off the
    // request, at which point "no persona asserted" is a denial, not a pass.
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
  });

  it("O5 · FAILS OPEN for a session principal with a null persona (resolveOwnerRole → owner)", () => {
    // The second fail-open, in @aura/shared (roles.ts:22): null resolves to the
    // MOST permissive persona. Deliberate — it covers memberships that predate
    // 0018 — and it is why the seeded dev membership, whose owner_role is NULL
    // (fixture trap 5), behaves as an owner.
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: sessionPrincipal({ ownerRole: null }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("O6 · 403s a telecaller on an owner-or-manager route", async () => {
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ ownerRole: "telecaller" }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires owner role: owner or manager",
      status: 403,
    });
  });

  it("O7 · allows a manager on an owner-or-manager route", () => {
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ ownerRole: "manager" }),
    });

    expect(guard.canActivate(context)).toBe(true);
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

  it("O9 · a CASE VARIANT of a restricted persona is allowed — via the O4 fail-open", () => {
    // The HTTP-reachable half of the escalation in report 12 §5.1. Over HTTP,
    // `x-caller-owner-role: Telecaller` never reaches `resolveOwnerRole` at all:
    // `OwnerRole.safeParse` nulls it at admin-key.guard.ts:95, so the principal
    // arrives here with ownerRole null and takes the :53 fail-open. Same
    // outcome as the skipped roles.test.ts:76 case (a restricted persona gets
    // owner-level access), DIFFERENT mechanism — which is why the planned
    // lower-case-and-trim fix in `resolveOwnerRole` does NOT close this path.
    // `null` below is exactly what admin-key.guard.ts produces for "Telecaller".
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ ownerRole: null }),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it.skip("O9 (correct) · a case variant of a restricted persona is denied", async () => {
    // Un-skip only when BOTH fixes land: the case-insensitive parse in
    // `resolveOwnerRole` AND server-side persona resolution. Fixing either
    // alone leaves this path open — that is the finding.
    const { context } = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: adminKeyPrincipal({ ownerRole: "telecaller" }),
      headers: { "x-caller-owner-role": "Telecaller" },
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires owner role: owner or manager",
      status: 403,
    });
  });

  it("enforces the persona for a session principal that HAS one", () => {
    // The only non-advisory path today: a Bearer aus_ session whose membership
    // carries owner_role. No route on the platform writes anything but 'owner'
    // (owners.controller.ts:154), so this shape exists only by direct INSERT —
    // and is exactly what Stage 2.5 makes the norm.
    const allowed = makeExecutionContext({
      cls: OwnerFixtureController,
      handler: OwnerFixtureController.prototype.updateTelecaller,
      principal: sessionPrincipal({ ownerRole: "owner" }),
    });
    expect(guard.canActivate(allowed.context)).toBe(true);
  });

  it("denies a session telecaller — the persona is enforced when it is known", async () => {
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
