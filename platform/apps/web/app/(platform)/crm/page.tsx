import type { CrmProviderSpec } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope, workspacesFor } from "@/lib/tenant-scope";
import { CrmManager } from "./crm-manager";
import type { Integration } from "./integration-card";

/**
 * Connectors for ONE customer. This page used to write every connector into
 * the environment's dev org and workspace, so configuring "a customer's CRM"
 * from here silently wired up a different customer's lead delivery.
 */
export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  // The catalogue comes from the API rather than being imported directly, so
  // the console can only offer providers the running API will actually accept.
  const [data, catalogue, workspaces] = await Promise.all([
    apiGetAs<{ integrations: Integration[] }>("/v1/crm/integrations", orgId),
    apiGetAs<{ providers: CrmProviderSpec[]; sourcePaths: Array<{ path: string; label: string }> }>(
      "/v1/crm/providers",
      orgId,
    ),
    workspacesFor(orgId),
  ]);

  return (
    <>
      <PageHeader title="CRM Integrations" context={activeTenant?.name ?? "Workspace"} />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/crm" />

      {data === null || catalogue === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API - start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : workspaces.length === 0 ? (
        <Card>
          <MonoLabel>No workspace</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            {activeTenant?.name ?? "This tenant"} has no workspace to deliver leads into.
          </p>
        </Card>
      ) : (
        <CrmManager
          integrations={data.integrations}
          providers={catalogue.providers}
          sourcePaths={catalogue.sourcePaths}
          workspaces={workspaces}
          orgId={orgId}
        />
      )}
    </>
  );
}
