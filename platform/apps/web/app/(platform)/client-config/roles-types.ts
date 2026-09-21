/** Shapes returned by /v1/roles for one client - CRM Phase 1 foundation (E0.4). */

import type { PermissionAction, PermissionObjectType, PermissionScope } from "@aura/shared";

export type { PermissionAction, PermissionObjectType, PermissionScope };

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

/**
 * GET /v1/roles/:id/permissions returns raw snake_case DB rows (this
 * codebase's convention - see e.g. owner/types.ts's Lead vs. UpdateLeadBody).
 * PUT expects camelCase (packages/shared's RolePermissionGrant, a write
 * body). Two shapes, not a bug - the manager converts between them.
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

/**
 * The grid's rows and columns.
 *
 * These three types used to be hand-copied unions in this file, which drifted
 * the moment `task` joined PermissionObjectType in Track A3 - the API accepted
 * a grant the console could not render. They are imported from @aura/shared
 * now, so the next object type is a one-line addition to the array below and
 * nothing else.
 */
export const PERMISSION_OBJECT_TYPES: PermissionObjectType[] = [
  "contact",
  "account",
  "deal",
  "task",
];
export const PERMISSION_ACTIONS: PermissionAction[] = ["view", "create", "edit", "delete", "export"];
