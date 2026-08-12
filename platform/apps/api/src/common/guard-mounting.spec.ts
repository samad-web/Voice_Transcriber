/**
 * Are the guards MOUNTED where inventory 13 §1.1 says they are?
 *
 * The other five suites prove each guard is correct in isolation. None of them
 * would notice a route that simply forgot to mount one — and an unmounted guard
 * is indistinguishable from no tenant boundary at all. `scripts/check-tenancy.js`
 * covers part of this, but it is a GREP over controller source: it can be
 * satisfied by a `@UseGuards(AdminKeyGuard, TenantGuard)` inside a comment or a
 * string, and it cannot see mounting order, class-vs-handler inheritance, or a
 * guard applied through a decorator alias. This file reads the same metadata
 * Nest reads at request time (`__guards__`, via `GuardsContextCreator`), so it
 * cannot be fooled by formatting.
 *
 * The four route classes are exhaustive and their sizes are asserted: 57
 * tenant-scoped, 21 cross-tenant, 6 device-authenticated, 6 unguarded = 90. A
 * new route lands in one of those buckets and moves a count, so "I added an
 * endpoint and forgot the guards" is a red test rather than a live hole.
 *
 * Inventory 13 §1.1 documents 75 of those. The extra twelve are the marketing
 * funnel's operator surface (LeadsModule), which post-dates the inventory; the
 * doc is the older artefact, not the authority.
 *
 * SAFETY: this imports controller CLASSES only. It never constructs one, never
 * builds a Nest application, and deliberately does NOT import `app.module.ts` —
 * that module's `ConfigModule.forRoot({ envFilePath: [...] })` (app.module.ts:27-30)
 * would read `.env`, and in this repository `.env` points at production. Reading
 * class metadata needs none of that. Controller modules do run their top-level
 * `z.object(...)` and `new S3Client(...)` statements on import; both are pure
 * in-memory construction (AWS SDK v3 resolves credentials and opens sockets at
 * request time, not at construction).
 *
 * Paths below are as DECLARED. The live URLs carry the `v1` prefix that
 * `main.ts:35` adds at bootstrap; it is omitted here because it is not part of
 * the controller metadata this file reflects over.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { RequestMethod, type Type } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { HealthController } from "../health/health.controller";
import { AdminController } from "../modules/admin/admin.controller";
import { AgentsController } from "../modules/agents/agents.controller";
import { AnalyticsController } from "../modules/analytics/analytics.controller";
import { SearchController } from "../modules/analytics/search.controller";
import { ApiKeysController } from "../modules/auth/apikeys.controller";
import { AuthController } from "../modules/auth/auth.controller";
import { BillingController } from "../modules/billing/billing.controller";
import { CallsController } from "../modules/calls/calls.controller";
import { NotesController } from "../modules/calls/notes.controller";
import { CrmController } from "../modules/crm/crm.controller";
import { AccountsController } from "../modules/crm-objects/accounts.controller";
import { ContactsController } from "../modules/crm-objects/contacts.controller";
import { DealsController } from "../modules/crm-objects/deals.controller";
import { InteractionsController } from "../modules/crm-objects/interactions.controller";
import { ReportsController } from "../modules/reports/reports.controller";
import { TasksController } from "../modules/tasks/tasks.controller";
import { PipelinesController } from "../modules/crm-objects/pipelines.controller";
import { CustomFieldsController } from "../modules/custom-fields/custom-fields.controller";
import { DeviceTelemetryController } from "../modules/devices/device-telemetry.controller";
import { DevicesController } from "../modules/devices/devices.controller";
import { InstancesController } from "../modules/devices/instances.controller";
// Two different controllers are both called `LeadsController` — the owner's
// view of their own leads, and the platform operator's view of marketing funnel
// enquiries. Aliased rather than renamed: they are genuinely both "leads" to
// their own audience, and the filesystem check below compares normalised names,
// so a rename purely to satisfy an import would make the two lists disagree.
import { LeadsController as FunnelLeadsController } from "../modules/leads/leads.controller";
import { MessageTemplatesController } from "../modules/leads/message-templates.controller";
import { SlotsController } from "../modules/leads/slots.controller";
import { FunnelCriteriaController } from "../modules/leads/funnel-criteria.controller";
import { WhatsAppCheckController } from "../modules/leads/whatsapp-check.controller";
import { MergeController } from "../modules/merge/merge.controller";
import { LeadsController } from "../modules/owner/leads.controller";
import { OwnerController } from "../modules/owner/owner.controller";
import { OwnersController } from "../modules/owner/owners.controller";
import { RolesController } from "../modules/roles/roles.controller";
import { ErasureController } from "../modules/tenancy/erasure.controller";
import { MembersController } from "../modules/tenancy/members.controller";
import { TenancyController } from "../modules/tenancy/tenancy.controller";
import { WorkspacesController } from "../modules/tenancy/workspaces.controller";
import { CROSS_TENANT_KEY } from "./tenant.guard";

/** Every controller in `app.module.ts`'s module graph, in inventory 13 §1.1 order. */
const CONTROLLERS: Array<Type<unknown>> = [
  HealthController,
  AuthController,
  ApiKeysController,
  AdminController,
  AgentsController,
  AnalyticsController,
  SearchController,
  BillingController,
  CallsController,
  NotesController,
  CrmController,
  DevicesController,
  DeviceTelemetryController,
  InstancesController,
  LeadsController,
  OwnerController,
  OwnersController,
  ErasureController,
  MembersController,
  TenancyController,
  WorkspacesController,
  // ── the marketing funnel's operator surface (LeadsModule) ─────────────────
  // Added late. These three shipped without being listed here, so for the
  // duration of that gap this suite's "reflects over EVERY controller file"
  // assertion was red — which is the check working, not a formality: none of
  // the guard assertions below were seeing ten live cross-tenant routes that
  // carry the root ADMIN_API_KEY and read every enquirer's phone number.
  FunnelLeadsController,
  SlotsController,
  MessageTemplatesController,
  WhatsAppCheckController,
  FunnelCriteriaController,
  // ── the CRM object model (CRM Phase 1, migrations 0034-0039) ──────────────
  // Same story as the funnel block above, and the reason this suite's
  // filesystem check exists: all seven shipped across M2-M6 without being
  // listed here, so every assertion below was blind to 33 live tenant-scoped
  // routes carrying the root ADMIN_API_KEY over every tenant's contacts,
  // accounts and deals. Adding them is behaviour-neutral — it only makes the
  // suite see what was already mounted.
  AccountsController,
  ContactsController,
  DealsController,
  InteractionsController,
  TasksController,
  ReportsController,
  PipelinesController,
  CustomFieldsController,
  MergeController,
  RolesController,
];

// ── the four route classes, named exactly as inventory 13 §1.1/§1.2 do ───────

/** §1.2 — the six routes with no `@UseGuards` metadata at all. */
const UNGUARDED = [
  "GET /health",
  "POST /auth/login",
  "POST /auth/logout",
  "POST /devices/register",
  "POST /devices/challenge",
  "POST /devices/authenticate",
];

/** §1.1 rows 22, 23, 44, 48–50 — the handset fleet's entire surface. */
const DEVICE_AUTHED = [
  "POST /calls",
  "POST /calls/:id/complete",
  "GET /devices/me/config",
  "POST /devices/me/health",
  "POST /devices/me/events",
  "GET /devices/me/calls/:callId",
];

/** §1.1 rows 3, 4, 9, 10, 18 — the operator surface, all on the RLS-bypassing pool. */
const CROSS_TENANT = [
  "GET /auth/context",
  "GET /auth/me",
  "POST /admin/tenants",
  "GET /admin/tenants",
  "GET /admin/health",
  "GET /analytics/fleet",
  // The marketing funnel. Cross-tenant by nature rather than by exception: an
  // enquiry has no org yet — that is what makes it an enquiry — so there is no
  // tenant for TenantGuard to scope these to. They still carry AdminKeyGuard,
  // which is the credential that actually gates them.
  "GET /admin/leads",
  "POST /admin/leads/:id/send-confirmation",
  "POST /admin/leads/:id/reject",
  "POST /admin/leads/delete",
  "POST /admin/leads/:id/link",
  "GET /admin/slots",
  "GET /admin/slots/booked",
  "POST /admin/slots",
  "POST /admin/slots/generate",
  "DELETE /admin/slots/:id",
  "GET /admin/message-templates",
  "PUT /admin/message-templates/:key",
  "POST /admin/message-templates/:key/reset",
  // Presence lookup on the WhatsApp network for numbers an enquirer typed.
  // Same reasoning as the rest of the funnel: no org exists yet to scope to.
  "POST /admin/whatsapp/check",
  // Who counts as a qualified lead. Cross-tenant for the same reason as
  // the rest of the funnel: these rules belong to the funnel, not to a
  // tenant, because a lead has no tenant until it is converted.
  "GET /admin/funnel-criteria",
  "PUT /admin/funnel-criteria",
];

/** §2.3 — one route on the whole platform. */
const PERMISSION_ROUTES = ["GET /calls/:id/audio"];

/** §2.4 — one controller, two routes. */
const OWNER_ROLE_ROUTES = ["GET /owner/overview", "PATCH /owner/telecallers/:deviceId"];

/**
 * The CRM object model's enforced surface — every route that consults the
 * `role_permissions` grid (migration 0039) via `CrmPermissionsGuard`.
 *
 * Pinned as an exhaustive list for the same reason PERMISSION_ROUTES is: a
 * route that quietly LOSES its guard is a silent authorization hole, and a
 * route that gains one unexpectedly is a silent lockout. `pipelines`,
 * `custom-field-definitions` and `merge` are deliberately absent —
 * `PermissionObjectType` is contact|account|deal only, so there is no grant
 * for them to check yet; they remain AdminKeyGuard+TenantGuard as before.
 */
const CRM_PERMISSION_ROUTES = [
  "GET /accounts",
  "GET /accounts/:id",
  "POST /accounts",
  "PATCH /accounts/:id",
  "GET /contacts",
  "GET /contacts/:id",
  "GET /contacts/:id/deals",
  "POST /contacts",
  "PATCH /contacts/:id",
  "GET /deals",
  "GET /deals/board",
  "GET /deals/:id",
  "POST /deals",
  "PATCH /deals/:id",
  // Track A2's timeline. Declared on InteractionsController, which has an
  // EMPTY @Controller() prefix and spells each parent out in the path — so
  // these read as contacts/accounts/deals routes here even though they live
  // in a different file, the same way NotesController's routes appear under
  // `calls`. Each is gated on its parent object, which is the whole reason
  // the routes are nested rather than one filtered `/interactions` list.
  "GET /accounts/:id/interactions",
  "POST /accounts/:id/interactions",
  "GET /contacts/:id/interactions",
  "POST /contacts/:id/interactions",
  "GET /deals/:id/interactions",
  "POST /deals/:id/interactions",
  // Track A3. `task` joined PermissionObjectType with migration 0041, which
  // also seeds every system role's task grants — so these are enforced from
  // the moment they ship, rather than being a retrofit later.
  "GET /tasks",
  "GET /tasks/:id",
  "POST /tasks",
  "PATCH /tasks/:id",
  // PRD Layer 3. Viewing a report needs `deal:view`; the CSV export needs
  // `deal:export` — the first route on the platform to use that action, and
  // the reason the export is its own route rather than a `?format=` param.
  "GET /reports/pipeline",
  "GET /reports/performance",
  "GET /reports/conversion",
  "GET /reports/:report/export",
];

interface Route {
  /** `"GET /calls/:id"` — verb plus the declared path, no `v1` prefix. */
  route: string;
  /** Class guards then handler guards, which is the order Nest runs them in. */
  guards: string[];
  crossTenant: boolean;
}

/**
 * `GuardsContextCreator.create` concatenates CLASS metadata then HANDLER
 * metadata (`ContextCreator.createContext`), so this ordering is Nest's, not a
 * convention chosen here. It matters: `@UseGuards(AdminKeyGuard, TenantGuard)`
 * on the class with `@UseGuards(PermissionsGuard)` on the handler yields
 * [AdminKey, Tenant, Permissions] — the dependency order tenant.guard.spec.ts
 * pins behaviourally.
 */
function guardNames(target: object): string[] {
  const meta = Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined;
  return (meta ?? []).map((g) => (typeof g === "function" ? g.name : String(g)));
}

function routesOf(cls: Type<unknown>): Route[] {
  const base = (Reflect.getMetadata(PATH_METADATA, cls) as string | undefined) ?? "";
  const classGuards = guardNames(cls);
  const routes: Route[] = [];
  for (const name of Object.getOwnPropertyNames(cls.prototype)) {
    if (name === "constructor") continue;
    const handler = (cls.prototype as Record<string, unknown>)[name];
    if (typeof handler !== "function") continue;
    // PATH_METADATA on a method is what @Get/@Post/@Patch/@Delete set; a helper
    // method on the controller has none and is skipped.
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    if (path === undefined) continue;
    const verb = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
    routes.push({
      route: `${verb} /${base}/${path}`.replace(/\/+/g, "/").replace(/\/$/, ""),
      guards: [...classGuards, ...guardNames(handler)],
      // getAllAndOverride([handler, class]) semantics, hand-rolled because a
      // Reflector needs an ExecutionContext: handler wins, class applies to all.
      crossTenant:
        Reflect.getMetadata(CROSS_TENANT_KEY, handler) === true ||
        Reflect.getMetadata(CROSS_TENANT_KEY, cls) === true,
    });
  }
  return routes;
}

const ROUTES: Route[] = CONTROLLERS.flatMap(routesOf);
const byRoute = new Map(ROUTES.map((r) => [r.route, r]));
const sorted = (values: string[]): string[] => [...values].sort();

describe("guard mounting (inventory 13 §1.1)", () => {
  it("reflects over EVERY controller file in the tree", () => {
    // The one hand-maintained list in this file is CONTROLLERS, and a new
    // controller that nobody adds to it would be invisible to every assertion
    // below — the exact failure this suite exists to prevent. So the list is
    // checked against the filesystem: add `foo.controller.ts` without importing
    // it here and this fails, naming the file.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith(".controller.ts")) files.push(entry.name);
      }
    };
    walk(join(__dirname, ".."));

    // Compared on a case- and separator-insensitive key, because the file and
    // class names do not agree on word boundaries: `apikeys.controller.ts`
    // declares `ApiKeysController`, `device-telemetry.controller.ts` declares
    // `DeviceTelemetryController`. Both normalise to the same key.
    const key = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const fromDisk = files.map((f) => key(f.replace(/\.controller\.ts$/, "")));
    const imported = CONTROLLERS.map((c) => key(c.name.replace(/Controller$/, "")));
    expect(sorted(imported)).toEqual(sorted(fromDisk));
  });

  it("has 138 routes, partitioned 104 tenant / 22 cross-tenant / 6 device / 6 unguarded", () => {
    // The counts inventory 13 §1.1 closes with, plus the funnel's ten, plus the
    // CRM object model's 33 (all tenant-scoped: 4 accounts + 5 contacts + 5
    // deals + 4 pipelines + 4 custom-field-definitions + 6 merge + 5 roles),
    // plus Track A2's 6 interaction-timeline routes Track A3's 4 task routes, and Layer 3's 4 report routes. They are asserted as a
    // set, not just a total, so moving a route BETWEEN classes (dropping
    // TenantGuard from a tenant route, say) fails even though the total is
    // unchanged.
    expect(ROUTES).toHaveLength(138);
    expect(new Set(ROUTES.map((r) => r.route)).size).toBe(138);

    const unguarded = ROUTES.filter((r) => r.guards.length === 0);
    const device = ROUTES.filter((r) => r.guards.includes("DeviceAuthGuard"));
    const crossTenant = ROUTES.filter((r) => r.crossTenant);
    const tenantScoped = ROUTES.filter((r) => r.guards.includes("TenantGuard") && !r.crossTenant);

    expect(sorted(unguarded.map((r) => r.route))).toEqual(sorted(UNGUARDED));
    expect(sorted(device.map((r) => r.route))).toEqual(sorted(DEVICE_AUTHED));
    expect(sorted(crossTenant.map((r) => r.route))).toEqual(sorted(CROSS_TENANT));
    expect(tenantScoped).toHaveLength(104);
    // Exhaustive: every route is in exactly one class.
    expect(unguarded.length + device.length + crossTenant.length + tenantScoped.length).toBe(138);
  });

  it("mounts AdminKeyGuard FIRST and TenantGuard SECOND on all 126 principal routes", () => {
    // 104 tenant-scoped + 22 cross-tenant. `TenantGuard` reads `req.principal`,
    // which only `AdminKeyGuard` writes, so the order is a correctness
    // requirement and not a style — tenant.guard.spec.ts's chain-order block
    // shows the reversed pair 401s a perfectly valid request. Asserting the
    // INDICES (not just membership) is what makes a reordered `@UseGuards`
    // fail here.
    const principalRoutes = ROUTES.filter((r) => r.guards.includes("AdminKeyGuard"));
    expect(principalRoutes).toHaveLength(126);

    for (const { route, guards } of principalRoutes) {
      expect([route, guards[0]]).toEqual([route, "AdminKeyGuard"]);
      expect([route, guards[1]]).toEqual([route, "TenantGuard"]);
    }
  });

  it("never mounts TenantGuard without AdminKeyGuard", () => {
    // The other direction of the same dependency: a route with only
    // `TenantGuard` would reject every request with a 401 that reads like an
    // auth outage. Cheap to assert, and it is the shape a copy-paste error
    // actually takes.
    for (const { route, guards } of ROUTES) {
      if (guards.includes("TenantGuard")) {
        expect([route, guards.includes("AdminKeyGuard")]).toEqual([route, true]);
      }
    }
  });

  it("keeps the device credential and the principal credential on disjoint routes", () => {
    // Inventory 13 §2.0: `DeviceAuthGuard` never coexists with the principal
    // chain — `req.device` and `req.principal` are separate properties on
    // separate route sets, and device-auth.guard.spec.ts pins that a device
    // token sets neither `principal` nor `tenantOrgId`. A route carrying both
    // would authenticate under one and scope under the other.
    for (const { route, guards } of ROUTES) {
      if (guards.includes("DeviceAuthGuard")) {
        expect([route, guards]).toEqual([route, ["DeviceAuthGuard"]]);
      }
    }
  });

  it("mounts PermissionsGuard and OwnerRoleGuard only where inventory 13 §2.3/§2.4 say", () => {
    // Both read `req.principal`, so both must come after AdminKeyGuard — and
    // both are mounted on so few routes that an accidental extra mount (or a
    // lost one) is worth failing over. `GET /owner/overview` carrying
    // OwnerRoleGuard while declaring no `@RequireOwnerRole` is inventory 13 §7
    // finding 3: the guard is mounted and inert. That is asserted here as
    // today's shape, with the behavioural half in owner-role.guard.spec.ts O1.
    const withPermissions = ROUTES.filter((r) => r.guards.includes("PermissionsGuard"));
    const withOwnerRole = ROUTES.filter((r) => r.guards.includes("OwnerRoleGuard"));

    expect(sorted(withPermissions.map((r) => r.route))).toEqual(sorted(PERMISSION_ROUTES));
    expect(sorted(withOwnerRole.map((r) => r.route))).toEqual(sorted(OWNER_ROLE_ROUTES));

    for (const { route, guards } of [...withPermissions, ...withOwnerRole]) {
      const last = guards.indexOf("TenantGuard");
      const index = guards.findIndex((g) => g === "PermissionsGuard" || g === "OwnerRoleGuard");
      expect([route, index > last]).toEqual([route, true]);
    }
  });

  it("mounts CrmPermissionsGuard on exactly the contact/account/deal routes, after TenantGuard", () => {
    // The guard reads `req.principal` (AdminKeyGuard) and `req.tenantOrgId`
    // (TenantGuard), so like the other two metadata guards its position in the
    // chain is a correctness requirement — it 401s if it runs first.
    const withCrm = ROUTES.filter((r) => r.guards.includes("CrmPermissionsGuard"));
    expect(sorted(withCrm.map((r) => r.route))).toEqual(sorted(CRM_PERMISSION_ROUTES));

    for (const { route, guards } of withCrm) {
      expect([route, guards.indexOf("CrmPermissionsGuard") > guards.indexOf("TenantGuard")]).toEqual(
        [route, true],
      );
    }
  });

  it("leaves pipelines, custom-field-definitions and merge unenforced, as scoped", () => {
    // Asserted rather than assumed: these carry the root ADMIN_API_KEY like
    // every other tenant route, and the reason they are NOT permission-checked
    // is that `PermissionObjectType` has no value for them yet — not that
    // somebody forgot. If that enum grows, this test is where the decision
    // gets revisited.
    const unenforced = ROUTES.filter(
      (r) =>
        r.route.includes("/pipelines") ||
        r.route.includes("/custom-field-definitions") ||
        r.route.includes("/merge"),
    );
    expect(unenforced).toHaveLength(14);
    for (const { route, guards } of unenforced) {
      expect([route, guards]).toEqual([route, ["AdminKeyGuard", "TenantGuard"]]);
    }
  });

  it("pins GET /calls/:id/audio as the full four-guard chain", () => {
    // The single most-guarded route on the platform and the only consumer of
    // PermissionsGuard. Spelled out in full because the chain IS the contract:
    // authenticate, scope to a tenant, then check the recordings grant.
    expect(byRoute.get("GET /calls/:id/audio")?.guards).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "PermissionsGuard",
    ]);
  });

  it("pins the six unguarded routes as an explicit allowlist", () => {
    // Inventory 13 §1.2. Each of these is unguarded for a reason recorded in
    // that section (liveness, credential minting, pre-enrollment), and
    // `POST /auth/logout` is a known finding — an anonymous DELETE on the
    // RLS-bypassing pool. A SEVENTH unguarded route is not a judgement call
    // this suite can make, so it fails and asks for one.
    for (const route of UNGUARDED) {
      expect([route, byRoute.get(route)?.guards]).toEqual([route, []]);
    }
  });
});
