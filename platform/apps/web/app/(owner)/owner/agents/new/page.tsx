import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AGENT_KIND_SPECS,
  AGENT_TEMPLATES,
  AgentKind,
  type AgentDefinitionInput,
  templatesFor,
} from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet, requireFeature } from "@/lib/owner-context";
import { AgentEditor } from "../agent-editor";

export const metadata: Metadata = { title: "New agent" };

interface StudioResponse {
  workspaces: Array<{ id: string; name: string }>;
}

/**
 * Start a new agent: pick a template (or a blank page), then edit.
 *
 * Two steps rather than a template dropdown inside the editor, because the
 * choice is made once and first - and a dropdown that silently replaces
 * everything typed below it is a trap the editor would then need a
 * confirmation to defend against.
 */
export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; template?: string; blank?: string }>;
}) {
  await requireFeature("/owner/agents");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");
  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const params = await searchParams;
  const kind = AgentKind.safeParse(params.kind).success
    ? (params.kind as AgentKind)
    : "call_extractor";
  const spec = AGENT_KIND_SPECS[kind];
  const template = AGENT_TEMPLATES.find(
    (t) => t.id === params.template && t.definition.kind === kind,
  );

  if (!template && params.blank !== "1") {
    return (
      <>
        <BreadcrumbLeaf label={`New ${spec.label.toLowerCase()}`} />
        <PageHeader title={`New ${spec.label.toLowerCase()}`} context="AI assistants" />
        <Card className="space-y-2">
          <p className="max-w-prose text-sm text-text-muted">{spec.blurb}</p>
          <p className="max-w-prose text-xs text-text-subtle">{spec.runs}</p>
        </Card>
        <section className="space-y-3" aria-labelledby="start-from">
          <h2 id="start-from" className="text-base font-semibold text-text">
            Start from
          </h2>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {templatesFor(kind).map((t) => (
              <li key={t.id}>
                <Link
                  href={`/owner/agents/new?kind=${kind}&template=${t.id}`}
                  className="block h-full space-y-1 rounded-md border border-border bg-surface p-4 hover:bg-surface-hover"
                >
                  <span className="font-medium text-text">{t.label}</span>
                  <p className="text-sm text-text-muted">{t.blurb}</p>
                </Link>
              </li>
            ))}
            <li>
              <Link
                href={`/owner/agents/new?kind=${kind}&blank=1`}
                className="block h-full space-y-1 rounded-md border border-dashed border-border-strong p-4 hover:bg-surface-hover"
              >
                <span className="font-medium text-text">A blank page</span>
                <p className="text-sm text-text-muted">
                  Write it yourself, or describe it and let AI draft it on the next screen.
                </p>
              </Link>
            </li>
          </ul>
        </section>
      </>
    );
  }

  const data =
    kind === "call_extractor" ? await ownerGet<StudioResponse>("/v1/owner/agents") : null;
  const initial: AgentDefinitionInput = template
    ? template.definition
    : ({ kind, name: "", instructions: "", fields: [] } as AgentDefinitionInput);

  return (
    <>
      <BreadcrumbLeaf label={`New ${spec.label.toLowerCase()}`} />
      <PageHeader
        title={
          template
            ? `New ${spec.label.toLowerCase()}: ${template.label}`
            : `New ${spec.label.toLowerCase()}`
        }
        context="AI assistants"
      />
      {template ? (
        <Card>
          <MonoLabel>From a template</MonoLabel>
          <p className="mt-1 max-w-prose text-sm text-text-muted">
            Everything below is a starting point. Replace anything in square brackets, remove
            details you don&apos;t need, and test it on a real{" "}
            {kind === "chat_qualifier" ? "conversation" : "call"} before switching it on.
          </p>
        </Card>
      ) : null}
      <AgentEditor
        mode="create"
        initial={initial}
        savedKeys={false}
        workspaces={data?.workspaces ?? []}
      />
    </>
  );
}
