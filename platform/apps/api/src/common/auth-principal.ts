import type { Request } from "express";

/** The authenticated actor behind a platform request (admin key OR session). */
export interface Principal {
  userId: string;
  orgId: string;
  role: "platform_admin" | "org_admin" | "workspace_admin" | "workspace_member" | "viewer";
  recordingsListen: boolean;
  recordingsExport: boolean;
  /** True when authenticated via the dev x-admin-key rather than a user session. */
  viaAdminKey: boolean;
}

export interface PrincipalRequest extends Request {
  principal?: Principal;
}

export const PERMISSIONS = ["recordings:listen", "recordings:export"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function principalHasPermission(principal: Principal, permission: Permission): boolean {
  if (principal.viaAdminKey || principal.role === "platform_admin") return true;
  if (permission === "recordings:listen") return principal.recordingsListen;
  if (permission === "recordings:export") return principal.recordingsExport;
  return false;
}
