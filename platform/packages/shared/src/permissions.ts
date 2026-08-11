import { z } from "zod";

/**
 * The role -> object -> action(+scope/field) permission model
 * (packages/db/migrations/0039), layered ALONGSIDE — not replacing —
 * memberships.role (operator RBAC) and memberships.owner_role (console
 * persona, see roles.ts). Schema only for now: nothing in the API enforces
 * these grants yet, and a membership cannot be assigned a genuinely custom
 * role yet — see the migration's header for why.
 */

/** The 5 system roles seeded for every org — mirrors memberships.role's CHECK. */
export const SystemRoleKey = z.enum([
  "platform_admin",
  "org_admin",
  "workspace_admin",
  "workspace_member",
  "viewer",
]);
export type SystemRoleKey = z.infer<typeof SystemRoleKey>;

export const PermissionObjectType = z.enum(["contact", "account", "deal"]);
export type PermissionObjectType = z.infer<typeof PermissionObjectType>;

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
