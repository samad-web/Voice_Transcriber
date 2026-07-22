import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/server-api";
import { AgentStudio, type AgentRow } from "./agent-studio";
import { AgentSandbox } from "./agent-sandbox";

export default async function AgentsPage() {
  const data = await apiGet<{ agents: AgentRow[] }>("/v1/agents");

  return (
    <>
      <PageHeader title="AI Agent Studio" />
      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          <AgentStudio agents={data.agents} />
          <AgentSandbox agents={data.agents} />
        </div>
      )}
    </>
  );
}
