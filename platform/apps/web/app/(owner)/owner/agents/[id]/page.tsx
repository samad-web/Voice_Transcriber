import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  AGENT_KIND_SPECS,
  type AgentDefinitionInput,
  type AgentKind,
  parseLeadRules,
  StoredExtractionSchema,
} from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet, requireFeature } from "@/lib/owner-context";
import { AgentEditor } from "../agent-editor";
import { AgentVersions, type VersionHeader } from "../agent-versions";

export const metadata: Metadata = { title: "AI agent" };

interface AgentDetail {
  agent: {
    id: string;
    version: number;
    kind: AgentKind;
    name: string;
    purpose: string;
    workspace_id: string | null;
    system_prompt: string;
    field_schema: unknown;
    lead_rules: unknown;
    config: Record<string, unknown> | null;
  };
  versions: VersionHeader[];
  activeVersion: number | null;
  archived: boolean;
}

const RUNS_NOUN: Record<AgentKind, string> = {
  call_extractor: "reading new calls",
  chat_qualifier: "judging new WhatsApp enquiries",
  reply_drafter: "drafting replies",
};

/** A stored version, into the shape the editor edits. Tolerant: an old row never crashes the page. */
function definitionOf(agent: AgentDetail["agent"]): AgentDefinitionInput {
  const schema = StoredExtractionSchema.safeParse(agent.field_schema ?? { fields: [] });
  return {
    kind: agent.kind,
    name: agent.name,
    purpose: agent.purpose ?? "",
    instructions: agent.system_prompt ?? "",
    fields: schema.success ? schema.data.fields : [],
    leadRules: parseLeadRules(agent.lead_rules),
    config: agent.config ?? {},
  } as AgentDefinitionInput;
}

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  await requireFeature("/owner/agents");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");
  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const { id } = await params;
  const { version } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const versionQuery = version && /^\d+$/.test(version) ? `?version=${version}` : "";

  const data = await ownerGet<AgentDetail>(`/v1/owner/agents/${id}${versionQuery}`);
  if (!data) notFound();

  const { agent, versions, activeVersion, archived } = data;
  const spec = AGENT_KIND_SPECS[agent.kind];
  const latestVersion = versions[0]?.version ?? agent.version;

  return (
    <>
      <BreadcrumbLeaf label={agent.name} />
      <PageHeader title={agent.name} context={spec.label} />

      {archived ? (
        <Card>
          <MonoLabel>Archived</MonoLabel>
          <p className="mt-1 max-w-prose text-sm text-text-muted">
            This agent is archived. It no longer runs and cannot be edited; the calls and leads it
            produced keep their record of it.
          </p>
        </Card>
      ) : (
        <>
          <AgentVersions
            agentId={id}
            versions={versions}
            activeVersion={activeVersion}
            viewing={agent.version}
            noun={RUNS_NOUN[agent.kind]}
          />

          {agent.version !== latestVersion ? (
            <p
              role="status"
              className="rounded-md border border-warning-text/30 bg-warning-subtle px-4 py-3 text-sm text-warning-text"
            >
              You are looking at version {agent.version}. Saving will create version{" "}
              {latestVersion + 1} from what is shown here.
            </p>
          ) : null}

          {/* Keyed on the version shown, so saving (which lands on a new
              version) or opening another one remounts the form with that
              version's contents instead of keeping the previous edit state. */}
          <AgentEditor
            key={`${id}-${agent.version}-${latestVersion}`}
            mode="edit"
            agentId={id}
            initial={definitionOf(agent)}
            savedKeys
            latestVersion={latestVersion}
            activeVersion={activeVersion}
            workspaces={[]}
          />
        </>
      )}
    </>
  );
}
