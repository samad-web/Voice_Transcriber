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
   * Owner-console persona (design doc §9) - independent of `role` above,
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
  /**
   * Row-level scope from the permission grid, written by `CrmPermissionsGuard`
   * and read via `@RecordScope()`. Only set on routes carrying
   * `@RequireCrmPermission`; see crm-scope.ts for why this is a request value
   * rather than something the guard could decide on its own.
   *
   * Typed loosely here to keep `common/` free of an import cycle between the
   * principal shape and the guard that fills it in.
   */
  crmScope?: { scope: "all" | "owned"; userId: string | null };
  /**
   * The external integration key behind this request, written by `ApiKeyGuard`
   * and absent on every other route.
   *
   * Separate from `principal` on purpose. A principal answers "who is acting";
   * an API key has no who - there is no person, no membership and no role to
   * resolve, which is exactly why its permissions come from `scopes` here
   * rather than from the CRM permission grid. Keeping it in its own field means
   * no existing guard or handler can mistake a headless credential for a user.
   */
  apiKey?: { id: string; orgId: string; scopes: string[] };
}

export const PERMISSIONS = ["recordings:listen", "recordings:export"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function principalHasPermission(principal: Principal, permission: Permission): boolean {
  if (principal.viaAdminKey || principal.role === "platform_admin") return true;
  if (permission === "recordings:listen") return principal.recordingsListen;
  if (permission === "recordings:export") return principal.recordingsExport;
  return false;
}
