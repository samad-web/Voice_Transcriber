import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { workspacesFor } from "@/lib/tenant-scope";
import { loadOrg } from "../instance-data";
import { AgentStudio, type AgentRow } from "./agent-studio";
import { AgentSandbox } from "./agent-sandbox";

export default async function AgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const org = await loadOrg(orgId);

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
      <PageHeader title="AI Agent Studio" context={org.name} />


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
            {org.name} has no workspace, so an agent has nowhere to
            live. Create one under Team first.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* `key={orgId}` forces a full remount when the tenant changes, rather
              than just a prop update - without it, `workspaceId`/`agentId`/the
              builder's draft state stay seeded from whichever tenant was active
              on first mount. Submitting Create Agent then sends the PREVIOUS
              tenant's workspaceId alongside the NEW orgId, which the API
              correctly 404s as "workspace not found in this org" - the workspace
              is real, just not visible under the new tenant's RLS scope.

              The in-page switcher that used to make this reachable without a
              route change is gone (doc 34 Part B: the tenant is a path segment
              now), so React would remount anyway. Kept deliberately - it costs
              nothing, and it states the invariant this component depends on
              rather than a fact about how the page happens to be navigated. */}
          <AgentStudio key={orgId} agents={data.agents} orgId={orgId} workspaces={workspaces} />
          <AgentSandbox key={orgId} agents={data.agents} orgId={orgId} />
        </div>
      )}
    </>
  );
}
