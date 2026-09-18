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

  const [response, workspaces] = await Promise.all([
    apiGetAs<{ agents: AgentRow[] }>("/v1/agents", orgId),
    workspacesFor(orgId),
  ]);
  // Call extractors only. Chat qualifiers and reply drafters (0121) are built by
  // the tenant in their own studio, have no fields for this page's builder or
  // sandbox to show, and "Set as Active" here would be a second, less careful
  // way to switch one on.
  const data = response
    ? { agents: response.agents.filter((a) => (a.kind ?? "call_extractor") === "call_extractor") }
    : null;

  return (
    <>
      <PageHeader title="AI Agent Studio" context={activeTenant?.name ?? "Workspace"} />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/agents" />

      {data === null ? (
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
            {activeTenant?.name ?? "This tenant"} has no workspace, so an agent has nowhere to
            live. Create one under Team first.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* `key={orgId}` forces a full remount on tenant switch (TenantSwitcher
              navigates client-side within this same route via `?org=`), rather
              than just a prop update - without it, `workspaceId`/`agentId`/the
              builder's draft state stay seeded from whichever tenant was active
              on first mount. Submitting Create Agent then sends the PREVIOUS
              tenant's workspaceId alongside the NEW orgId, which the API
              correctly 404s as "workspace not found in this org" - the
              workspace is real, just not visible under the new tenant's RLS
              scope. */}
          <AgentStudio key={orgId} agents={data.agents} orgId={orgId} workspaces={workspaces} />
          <AgentSandbox key={orgId} agents={data.agents} orgId={orgId} />
        </div>
      )}
    </>
  );
}
