import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AGENT_KIND_ORDER, AGENT_KIND_SPECS, type AgentKind } from "@aura/shared";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry, requireFeature } from "@/lib/owner-context";

export const metadata: Metadata = { title: "AI Agent Studio" };

export interface AgentSummary {
  id: string;
  kind: AgentKind;
  name: string;
  purpose: string;
  workspaceId: string | null;
  latestVersion: number;
  activeVersion: number | null;
  versionCount: number;
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
}

interface StudioResponse {
  agents: AgentSummary[];
  workspaces: Array<{ id: string; name: string }>;
  qualificationEnabled: boolean;
}

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * The tenant's AI Agent Studio - every agent they have, grouped by what it does.
 *
 * ── THE REDIRECT IS NOT THE SECURITY BOUNDARY ───────────────────────────────
 *
 * Every route behind this page is `@RequireOwnerRole("owner", "manager")`.
 * The redirect spares a telecaller on a stale link a page of errors.
 */
export default async function AgentStudioPage() {
  await requireFeature("/owner/agents");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");
  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const result = await ownerTry<StudioResponse>("/v1/owner/agents");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="AI Agent Studio" context="Conversations" />
        <LoadFailure what="saved agents" failure={result} />
      </>
    );
  }
  const data = result.data;

  const byKind = (kind: AgentKind) => data.agents.filter((a) => a.kind === kind);
  const workspaceName = new Map(data.workspaces.map((w) => [w.id, w.name]));
  // A workspace with no running extractor turns no calls into leads, silently.
  // That is the single most expensive thing this page can surface.
  const uncovered = data.workspaces.filter(
    (w) =>
      !data.agents.some(
        (a) => a.kind === "call_extractor" && a.workspaceId === w.id && a.activeVersion !== null,
      ),
  );

  return (
    <>
      <PageHeader title="AI Agent Studio" context="Conversations" />

      <Card className="space-y-2">
        <MonoLabel>What agents do</MonoLabel>
        <p className="max-w-prose text-sm leading-relaxed text-text-muted">
          An agent is a set of instructions the AI follows for your business. Build one for each job
          below, test it on your own recent calls before you switch it on, and change it whenever
          your business changes. Every edit is kept as a version, so you can switch back.
        </p>
        <p className="max-w-prose text-sm leading-relaxed text-text-muted">
          No agent ever sends a message. They read, sort and suggest; your team decides and sends.
        </p>
      </Card>

      {uncovered.length > 0 ? (
        <div
          role="status"
          className="space-y-1 rounded-md border border-warning-text/30 bg-warning-subtle px-4 py-3 text-sm text-warning-text"
        >
          <p className="font-medium">No call extractor is running</p>
          <p className="max-w-prose leading-relaxed">
            {uncovered.length === data.workspaces.length
              ? "Recorded calls are being transcribed, but none of them can become leads until a call extractor is switched on."
              : `Calls in ${uncovered.map((w) => w.name).join(", ")} cannot become leads until a call extractor is switched on there.`}
          </p>
        </div>
      ) : null}

      {AGENT_KIND_ORDER.map((kind) => {
        const spec = AGENT_KIND_SPECS[kind];
        const agents = byKind(kind);
        return (
          <section key={kind} className="space-y-3" aria-labelledby={`kind-${kind}`}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <h2 id={`kind-${kind}`} className="text-base font-semibold text-text">
                  {spec.plural}
                </h2>
                <p className="max-w-prose text-sm text-text-muted">{spec.blurb}</p>
                <p className="max-w-prose text-xs text-text-subtle">{spec.runs}</p>
              </div>
              <Link
                href={`/owner/agents/new?kind=${kind}`}
                className="inline-flex min-h-10 items-center rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-text hover:bg-surface-hover sm:min-h-8"
              >
                New {spec.label.toLowerCase()}
              </Link>
            </div>

            {kind === "chat_qualifier" && !data.qualificationEnabled ? (
              <p className="max-w-prose rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs leading-relaxed text-text-muted">
                WhatsApp lead qualification is switched off for your workspace, so a chat qualifier
                will not run yet. Qualification sends customer conversations to an AI provider,
                which is why your platform provider switches it on - ask them when you are ready.
              </p>
            ) : null}

            {agents.length === 0 ? (
              <EmptyState
                title={`No ${spec.plural.toLowerCase()} yet`}
                description="Start from a template or describe what you need, then test it before switching it on."
              />
            ) : (
              <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {agents.map((agent) => (
                  <li key={agent.id}>
                    <Link
                      href={`/owner/agents/${agent.id}`}
                      className="block h-full space-y-2 rounded-md border border-border bg-surface p-4 hover:bg-surface-hover"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 font-medium text-text">{agent.name}</span>
                        {agent.activeVersion !== null ? (
                          <StatusChip tone="solid">Running · v{agent.activeVersion}</StatusChip>
                        ) : (
                          <StatusChip tone="outline">Off</StatusChip>
                        )}
                      </div>
                      {agent.purpose ? (
                        <p className="text-sm text-text-muted">{agent.purpose}</p>
                      ) : null}
                      <p className="text-xs text-text-subtle">
                        {spec.hasFields
                          ? `${agent.fieldCount} detail${agent.fieldCount === 1 ? "" : "s"} · `
                          : ""}
                        {agent.versionCount} version{agent.versionCount === 1 ? "" : "s"} · edited{" "}
                        {dateFormat.format(new Date(agent.updatedAt))}
                        {kind === "call_extractor" &&
                        data.workspaces.length > 1 &&
                        agent.workspaceId
                          ? ` · ${workspaceName.get(agent.workspaceId) ?? "workspace"}`
                          : ""}
                      </p>
                      {agent.activeVersion !== null &&
                      agent.activeVersion !== agent.latestVersion ? (
                        <p className="text-xs text-text-muted">
                          Version {agent.latestVersion} is saved but not switched on.
                        </p>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
