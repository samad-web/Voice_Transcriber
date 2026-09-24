import { z } from "zod";

/**
 * The role -> object -> action(+scope/field) permission model
 * (packages/db/migrations/0039), layered ALONGSIDE - not replacing -
 * memberships.role (operator RBAC) and memberships.owner_role (console
 * persona, see roles.ts).
 *
 * NO LONGER SCHEMA-ONLY, and this header used to say it was. `CrmPermissions
 * Guard` has enforced the grid since 0079, and `PUT /v1/owner/team/:userId/role`
 * (0102) assigns it - so both halves of 0039's deferral are closed. What is
 * still true is the reason it was deferred: `memberships.role` remains the
 * five-value CHECK enum every authorization call site reads, and nothing here
 * writes it.
 *
 * The three axes, and all three must say yes:
 *   memberships.role        the tenant tier - API keys, consent policy, erasure.
 *   memberships.owner_role  the console persona - which console, whose records.
 *   role_permissions        this grid - what may be done with a record.
 */

/** The 5 system roles seeded for every org - mirrors memberships.role's CHECK. */
export const SystemRoleKey = z.enum([
  "platform_admin",
  "org_admin",
  "workspace_admin",
  "workspace_member",
  "viewer",
]);
export type SystemRoleKey = z.infer<typeof SystemRoleKey>;

/**
 * What a grant can be about. `task` joined in with Track A3 (migration 0041),
 * which also seeds every system role's task grants to match its contact ones -
 * widening this enum without that seeding would lock every existing user out
 * of the new object, since CrmPermissionsGuard denies whatever it finds no
 * grant for.
 *
 * Still absent, deliberately: `pipeline`, `custom_field` and `merge`. Those
 * are org-configuration surfaces rather than records, and they stay on
 * AdminKeyGuard+TenantGuard until there is a reason to model them here.
 *
 * `product`/`quotation`/`invoice` joined in with the Kailash-gap Milestone 1
 * work (migrations 0059/0060), seeded the same way `task` and `conversation`
 * were - every system role gets a matching grant in the same migration that
 * widens this enum, so nobody is locked out the day it ships.
 *
 * `lead` joined in with 0103, and it is the first entry here that is NOT a CRM
 * object. Until then this grid governed the CRM half of the console and
 * nothing else: the lead board and the full lead list - the pages an Aura
 * tenant actually spends the day in - were gated by the console PERSONA alone,
 * so an owner could rearrange forty checkboxes and change nothing about them.
 * See `PERMISSION_OBJECT_MODULE` below for what widening it required.
 *
 * `lead_board` joined in with 0136: making, reshaping, routing and deleting
 * lead boards. Like `pipeline` it is configuration rather than a record, but
 * unlike `pipeline` an owner asked to decide per role who may do it, so it is
 * modelled here. Only `all` scope is meaningful - the console shows its cells
 * as No / Yes.
 *
 * `call` is deliberately still ABSENT, and that is a decision rather than an
 * omission. Reading a call already has three gates - the `call_intel` module,
 * the `recordings_listen` flag on the membership, and the persona - and 0039's
 * own header ruled the recordings mechanism out of scope for exactly this
 * reason. A fourth axis over one object is how "why can Priya not hear this
 * call" acquires four possible answers and no one of them is authoritative.
 */
export const PermissionObjectType = z.enum([
  "contact",
  "account",
  "deal",
  "task",
  "conversation",
  "product",
  "quotation",
  "invoice",
  "lead",
  "lead_board",
]);
export type PermissionObjectType = z.infer<typeof PermissionObjectType>;

/**
 * The product module each object needs (migration 0072's `enabled_modules`).
 *
 * ── WHY THIS HAD TO EXIST BEFORE `lead` COULD ───────────────────────────────
 *
 * `CrmPermissionsGuard` used to hard-code `'crm' = ANY(enabled_modules)` in its
 * lookup, which was right while every object in this enum was a CRM object: a
 * tenant with the CRM switched off should be denied exactly as if the grant
 * were missing, or their leftover `role_permissions` rows would keep granting
 * access to a module they no longer have.
 *
 * `lead` is core Aura. Leaving the module hard-coded would have taken the lead
 * board away from every recording-only tenant the moment the guard was mounted
 * on it - the single most damaging regression this change could have shipped.
 * So the requirement now comes from the object.
 */
export const PERMISSION_OBJECT_MODULE: Record<PermissionObjectType, "aura" | "crm"> = {
  contact: "crm",
  account: "crm",
  deal: "crm",
  task: "crm",
  conversation: "crm",
  product: "crm",
  quotation: "crm",
  invoice: "crm",
  lead: "aura",
  lead_board: "aura",
};

/** Objects whose grants are whole-org powers, where "own records" means nothing. */
export const ALL_SCOPE_ONLY_OBJECTS: ReadonlySet<PermissionObjectType> = new Set(["lead_board"]);

export const PermissionAction = z.enum(["view", "create", "edit", "delete", "export"]);
export type PermissionAction = z.infer<typeof PermissionAction>;

export const PermissionScope = z.enum(["all", "owned"]);
export type PermissionScope = z.infer<typeof PermissionScope>;

export const FieldRestriction = z.enum(["hidden", "readonly"]);
export type FieldRestriction = z.infer<typeof FieldRestriction>;

/** One row of role_permissions. */
export const RolePermissionGrant = z.object({
  objectType: PermissionObjectType,
  action: PermissionAction,
  scope: PermissionScope.default("all"),
  fieldRestrictions: z.record(z.string(), FieldRestriction).default({}),
});
export type RolePermissionGrant = z.infer<typeof RolePermissionGrant>;

export const RoleInput = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier required")
    .max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});
export type RoleInput = z.infer<typeof RoleInput>;

/**
 * The (object, action) pairs the API ACTUALLY enforces.
 *
 * ── WHY A CONSOLE NEEDS THIS ────────────────────────────────────────────────
 *
 * The grid is a full cross product - nine objects by five actions, forty-five
 * cells - and the API mounts a guard on twenty-seven of them. The other
 * eighteen are checkboxes that change nothing: ticking Export on Contacts, or
 * Delete on Invoices, writes a `role_permissions` row that no route ever reads.
 *
 * A permissions screen that silently ignores half of what you set is worse
 * than one that offers less. Somebody removes Delete from a role, tells their
 * team the records are safe, and they are not. So the console renders the
 * unenforced cells as inert and says so, and this list is where it learns
 * which.
 *
 * ── AND WHY IT IS A LIST RATHER THAN A COMMENT ──────────────────────────────
 *
 * `permissions-inventory.spec.ts` reflects over every controller's real
 * `@RequireCrmPermission` metadata and asserts this list matches it exactly.
 * Mount a guard on a new route and the test fails until the cell is marked
 * live; delete a route and it fails until the cell is marked inert. A hand-
 * maintained list would be wrong within a month and wrong in the direction
 * that over-promises.
 */
export const ENFORCED_PERMISSIONS: ReadonlyArray<`${PermissionObjectType}:${PermissionAction}`> = [
  "account:create",
  "account:edit",
  "account:view",
  "contact:create",
  "contact:edit",
  "contact:view",
  "conversation:edit",
  "conversation:view",
  "deal:create",
  // No "deal:delete". The decorator exists in crm-permissions.guard.spec.ts as a
  // FIXTURE and nowhere else - a grep over source finds it and reports a delete
  // gate that does not exist. `permissions-inventory.spec.ts` reflects over real
  // controller metadata instead, and caught exactly this on its first run.
  "deal:edit",
  "deal:export",
  "deal:view",
  "invoice:create",
  "invoice:edit",
  "invoice:view",
  "lead:create",
  "lead:edit",
  "lead:view",
  "lead_board:create",
  "lead_board:delete",
  "lead_board:edit",
  "product:create",
  "product:edit",
  "product:view",
  "quotation:create",
  "quotation:edit",
  "quotation:view",
  "task:create",
  "task:edit",
  "task:view",
];

/** Does any route actually check this cell? See ENFORCED_PERMISSIONS. */
export function isPermissionEnforced(
  objectType: PermissionObjectType | string,
  action: PermissionAction | string,
): boolean {
  return (ENFORCED_PERMISSIONS as readonly string[]).includes(`${objectType}:${action}`);
}
