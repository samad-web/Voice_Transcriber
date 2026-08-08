import type { Request } from "express";
import type { OwnerRole } from "@aura/shared";

/** The authenticated actor behind a platform request (admin key OR session). */
export interface Principal {
  userId: string;
  orgId: string;
  role: "platform_admin" | "org_admin" | "workspace_admin" | "workspace_member" | "viewer";
  recordingsListen: boolean;
  recordingsExport: boolean;
  /** True when authenticated via the dev x-admin-key rather than a user session. */
  viaAdminKey: boolean;
  /**
   * Owner-console persona (design doc §9) — independent of `role` above,
   * which is the operator-side tenant role. Null when the caller never
   * asserted one: a bare admin-key script/test, or a session whose
   * membership predates personas.
   */
  ownerRole: OwnerRole | null;
}

export interface PrincipalRequest extends Request {
  principal?: Principal;
  /**
   * The tenant this request is scoped to, pinned by `TenantGuard` and read via
   * `@OrgId()`. Unset on `@CrossTenant()` routes, which have no single org.
   */
  tenantOrgId?: string;
}

export const PERMISSIONS = ["recordings:listen", "recordings:export"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function principalHasPermission(principal: Principal, permission: Permission): boolean {
  if (principal.viaAdminKey || principal.role === "platform_admin") return true;
  if (permission === "recordings:listen") return principal.recordingsListen;
  if (permission === "recordings:export") return principal.recordingsExport;
  return false;
}
