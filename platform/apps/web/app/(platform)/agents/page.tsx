import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope, workspacesFor } from "@/lib/tenant-scope";
import { AgentStudio, type AgentRow } from "./agent-studio";
import { AgentSandbox } from "./agent-sandbox";

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  const [data, workspaces] = await Promise.all([
    apiGetAs<{ agents: AgentRow[] }>("/v1/agents", orgId),
    workspacesFor(orgId),
  ]);

  return (
    <>
      <PageHeader title="AI Agent Studio" context={activeTenant?.name ?? "Workspace"} />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/agents" />

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : workspaces.length === 0 ? (
        <Card>
          <MonoLabel>No workspace</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            {activeTenant?.name ?? "This tenant"} has no workspace, so an agent has nowhere to
            live. Create one under Team first.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          <AgentStudio agents={data.agents} orgId={orgId} workspaces={workspaces} />
          <AgentSandbox agents={data.agents} orgId={orgId} />
        </div>
      )}
    </>
  );
}
