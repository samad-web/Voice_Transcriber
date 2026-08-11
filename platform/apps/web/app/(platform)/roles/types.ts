/** Shapes returned by /v1/roles — CRM Phase 1 foundation (E0.4). */

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export type PermissionObjectType = "contact" | "account" | "deal";
export type PermissionAction = "view" | "create" | "edit" | "delete" | "export";
export type PermissionScope = "all" | "owned";

/**
 * GET /v1/roles/:id/permissions returns raw snake_case DB rows (this
 * codebase's convention — see e.g. owner/types.ts's Lead vs. UpdateLeadBody).
 * PUT expects camelCase (packages/shared's RolePermissionGrant, a write
 * body). Two shapes, not a bug — the manager converts between them.
 */
export interface PermissionGrantRow {
  object_type: PermissionObjectType;
  action: PermissionAction;
  scope: PermissionScope;
  field_restrictions: Record<string, "hidden" | "readonly">;
}

export interface PermissionGrant {
  objectType: PermissionObjectType;
  action: PermissionAction;
  scope: PermissionScope;
  fieldRestrictions: Record<string, "hidden" | "readonly">;
}

export const PERMISSION_OBJECT_TYPES: PermissionObjectType[] = ["contact", "account", "deal"];
export const PERMISSION_ACTIONS: PermissionAction[] = ["view", "create", "edit", "delete", "export"];
