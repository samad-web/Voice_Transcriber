import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { RolesManager } from "./roles-manager";
import type { Role } from "./types";

export const metadata: Metadata = { title: "Roles — Aura" };

/**
 * Roles & permissions admin — CRM Phase 1, E0.4. Same tenant-scoping shape
 * as (platform)/crm and (platform)/custom-fields. Schema-only phase: this
 * page lets an operator define custom roles and edit any role's permission
 * grid, but nothing here is enforced yet and no role can be assigned to a
 * real membership — see roles.controller.ts's header.
 */
export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  const data = await apiGetAs<{ roles: Role[] }>("/v1/roles", orgId);

  return (
    <>
      <PageHeader title="Roles" context={activeTenant?.name ?? "Workspace"} />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/roles" />

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <RolesManager roles={data.roles} orgId={orgId} />
      )}
    </>
  );
}
