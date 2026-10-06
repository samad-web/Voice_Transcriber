import { RequestMethod, type Type } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { CROSS_TENANT_KEY } from "../../common/tenant.guard";
import { PartnersController } from "./partners.controller";
import { PortalController } from "./portal.controller";
import { PortalInvitesController } from "./portal-invites.controller";

/**
 * P4's route inventory, in the shape `guard-mounting.spec.ts` reads.
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 *
 * `guard-mounting.spec.ts` is the authority on where guards are mounted and it
 * owns the route-class partition - but it reflects over a hand-maintained
 * `CONTROLLERS` list, and until these three classes are added to it the suite
 * cannot see a single one of the eighteen routes below. Doc 39 §17 rule 2 asks
 * for a SIXTH route class beside tenant / cross-tenant / device / unguarded /
 * internal, and a class nothing enumerates is a class nothing checks.
 *
 * So this pins the same facts, read from the same Nest metadata, for this
 * module alone. It is NOT a replacement: when the three controllers land in
 * `CONTROLLERS`, that suite's counts move by exactly the numbers asserted here
 * and this file becomes the per-module statement of why they moved.
 *
 * ── AND WHY IT IS PINNED AS A SET RATHER THAN A COUNT ─────────────────────
 *
 * A total catches a route that was added. It does not catch a route that moved
 * BETWEEN classes - dropping `TenantGuard` from the tenant-facing controller,
 * say - which leaves the total unchanged and the boundary gone. The three
 * route lists below are exhaustive and exact, which is the same decision
 * guard-mounting.spec.ts explains at length for its own partition.
 */

interface Route {
  route: string;
  guards: string[];
  crossTenant: boolean;
}

function routesOf(cls: Type<unknown>): Route[] {
  const base = (Reflect.getMetadata(PATH_METADATA, cls) as string | undefined) ?? "";
  const classGuards = guardNames(cls);
  const classCrossTenant = Reflect.getMetadata(CROSS_TENANT_KEY, cls) === true;

  return Object.getOwnPropertyNames(cls.prototype)
    .filter((key) => key !== "constructor")
    .map((key) => (cls.prototype as Record<string, unknown>)[key])
    .filter((handler): handler is (...args: unknown[]) => unknown => typeof handler === "function")
    .filter((handler) => Reflect.getMetadata(PATH_METADATA, handler) !== undefined)
    .map((handler) => {
      const path = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? "";
      const verb = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const full = `/${[base, path].filter((p) => p && p !== "/").join("/")}`;
      return {
        route: `${verb} ${full}`,
        // Class guards first, then handler guards - the order Nest applies them.
        guards: [...classGuards, ...guardNames(handler)],
        crossTenant:
          classCrossTenant || Reflect.getMetadata(CROSS_TENANT_KEY, handler) === true,
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route));
}

function guardNames(target: object): string[] {
  const meta = Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined;
  return (meta ?? []).map((g) => (typeof g === "function" ? g.name : String(g)));
}

describe("P4 route inventory (doc 39 §17-§19)", () => {
  /**
   * CLASS 6 - the new one. `PartnerScopeGuard` and nothing else: no
   * `TenantGuard`, so these are not tenant-scoped; no `@CrossTenant()`, so they
   * are not cross-tenant; not device, not unguarded, not internal.
   *
   * Seven routes for five screens. Submissions is three (write, list, read)
   * and Profile is two (read, rename); Resources has none at all, because the
   * table it reads is migration 0165 and an endpoint that returned a hard-coded
   * empty array would be counted here as though it did something.
   */
  it("mounts PartnerScopeGuard alone on all seven portal routes", () => {
    expect(routesOf(PortalController)).toEqual([
      { route: "GET /portal/commissions", guards: ["PartnerScopeGuard"], crossTenant: false },
      { route: "GET /portal/context", guards: ["PartnerScopeGuard"], crossTenant: false },
      { route: "GET /portal/profile", guards: ["PartnerScopeGuard"], crossTenant: false },
      { route: "GET /portal/submissions", guards: ["PartnerScopeGuard"], crossTenant: false },
      { route: "GET /portal/submissions/:id", guards: ["PartnerScopeGuard"], crossTenant: false },
      { route: "PATCH /portal/profile", guards: ["PartnerScopeGuard"], crossTenant: false },
      { route: "POST /portal/submissions", guards: ["PartnerScopeGuard"], crossTenant: false },
    ]);
  });

  /** Ordinary TENANT routes: the client's own console managing its roster. */
  it("keeps the tenant's eight partner routes on the tenant stack", () => {
    const stack = ["AdminKeyGuard", "TenantGuard", "CrmPermissionsGuard"];
    expect(routesOf(PartnersController)).toEqual([
      { route: "GET /partners", guards: stack, crossTenant: false },
      { route: "GET /partners/:id", guards: stack, crossTenant: false },
      { route: "GET /partners/submissions", guards: stack, crossTenant: false },
      { route: "PATCH /partners/:id", guards: stack, crossTenant: false },
      { route: "PATCH /partners/submissions/:id", guards: stack, crossTenant: false },
      { route: "POST /partners", guards: stack, crossTenant: false },
      { route: "POST /partners/:id/invites", guards: stack, crossTenant: false },
      { route: "POST /partners/invites/:inviteId/revoke", guards: stack, crossTenant: false },
    ]);
  });

  /**
   * CROSS-TENANT, like `AuthInvitesController`: the person holding the link has
   * no principal at all until they accept, and the TOKEN is what names the org.
   */
  it("keeps the three invite routes cross-tenant", () => {
    const stack = ["AdminKeyGuard", "TenantGuard"];
    expect(routesOf(PortalInvitesController)).toEqual([
      { route: "GET /portal/invites/preview", guards: stack, crossTenant: true },
      { route: "POST /portal/invites/accept", guards: stack, crossTenant: true },
      { route: "POST /portal/invites/prepare", guards: stack, crossTenant: true },
    ]);
  });

  /**
   * What `guard-mounting.spec.ts`'s counts move by when these three classes are
   * added to its `CONTROLLERS` list. Stated as arithmetic rather than prose so
   * whoever does that reconciliation has the numbers rather than a paragraph
   * about them.
   *
   * At 0156 that file asserted 555 routes. 0157/0158 took it to 560 -
   * 470 tenant / 50 cross-tenant / 18 device / 21 unguarded / 1 internal - and
   * other phases are moving it concurrently, so these are DELTAS, not totals.
   */
  it("moves the partition by +8 tenant, +3 cross-tenant and +7 in a sixth class", () => {
    const all = [
      ...routesOf(PortalController),
      ...routesOf(PartnersController),
      ...routesOf(PortalInvitesController),
    ];
    expect(all).toHaveLength(18);
    expect(new Set(all.map((r) => r.route)).size).toBe(18);

    const tenant = all.filter((r) => r.guards.includes("TenantGuard") && !r.crossTenant);
    const crossTenant = all.filter((r) => r.crossTenant);
    const partner = all.filter((r) => r.guards.includes("PartnerScopeGuard"));
    const device = all.filter((r) => r.guards.includes("DeviceAuthGuard"));
    const unguarded = all.filter((r) => r.guards.length === 0);

    expect(tenant).toHaveLength(8);
    expect(crossTenant).toHaveLength(3);
    expect(partner).toHaveLength(7);
    // P4 adds nothing to the other three classes. An unguarded portal route
    // would be a public endpoint over a tenant's partner roster.
    expect(device).toHaveLength(0);
    expect(unguarded).toHaveLength(0);
    // Exhaustive: every route in exactly one class.
    expect(tenant.length + crossTenant.length + partner.length).toBe(18);
  });

  it("never puts PartnerScopeGuard on the same route as TenantGuard", () => {
    // The two express different boundaries and mounting both would be a route
    // that is tenant-scoped by header AND partner-scoped by lookup. Whichever
    // the handler then believed, the other would be decoration - and the route
    // would silently leave the sixth class, because `guard-mounting.spec.ts`
    // partitions on TenantGuard's presence.
    const all = [
      ...routesOf(PortalController),
      ...routesOf(PartnersController),
      ...routesOf(PortalInvitesController),
    ];
    for (const { route, guards } of all) {
      const both = guards.includes("PartnerScopeGuard") && guards.includes("TenantGuard");
      expect([route, both]).toEqual([route, false]);
    }
  });
});
