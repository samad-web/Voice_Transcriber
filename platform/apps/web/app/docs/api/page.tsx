import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { publicApiOrigin } from "@/lib/public-origin";

export const metadata: Metadata = {
  title: "API docs - Aura",
  description: "Aura's tenant-facing integration API - REST and MCP.",
};

/**
 * The public developer reference for the tenant-facing integration API.
 *
 * ── WHY THIS PAGE HAS NO AUTH CHECK ────────────────────────────────────────
 *
 * Everything on it is a reference, not tenant data - the credential that
 * matters is the API key, never a session, and a page describing an endpoint
 * discloses nothing an operator handing out a key wouldn't say anyway. Gating
 * it behind sign-in would only stop the one audience it is for: a tenant's own
 * developer, who usually has no console login at all.
 *
 * ── WHY IT LIVES OUTSIDE BOTH `(owner)/` AND `(platform)/` ─────────────────
 *
 * Neither route group's layout applies here on purpose (no sidebar, no
 * session redirect) - this is a standalone reference, not a console screen.
 *
 * Every shape on this page is read off the real source rather than summarised
 * from memory: `PublicApiController` (REST), `McpServerController` (MCP), and
 * `API_SCOPES` (packages/shared/src/api-scopes.ts). Keep it that way when any
 * of those change - a docs page that drifts from the code is worse than none,
 * because it fails silently for whoever trusts it.
 */
export default function ApiDocsPage() {
  const base = `${publicApiOrigin()}/v1`;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
      <header className="space-y-2">
        <p className="text-xs font-medium text-accent-text">Aura</p>
        <h1 className="text-2xl font-semibold text-text">Developer docs</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
          The API an external system uses to push and pull a tenant&rsquo;s own CRM data - the
          same records that feed the console&rsquo;s pipeline, boards and reports. It is a small,
          deliberately closed surface: a handful of REST routes plus an MCP server for AI agents,
          both authenticated by one kind of credential.
        </p>
      </header>

      <Card>
        <MonoLabel>Base URL</MonoLabel>
        <CodeBlock className="mt-2">{base}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-text-muted">
          Every REST route below is relative to this. The MCP server answers at{" "}
          <InlineCode>{`${base}/mcp`}</InlineCode>.
        </p>
      </Card>

      <Card>
        <MonoLabel>Authentication</MonoLabel>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          Send the key as a bearer token or as <InlineCode>x-api-key</InlineCode> - either header
          works on every route:
        </p>
        <CodeBlock className="mt-2">{`Authorization: Bearer <your key>\n# or\nx-api-key: <your key>`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-text-muted">
          Keys are per-tenant and are minted by your Aura account manager (there is no self-serve
          key creation in the console yet). Ask for a key with only the scopes your integration
          actually needs - see below. A key can be revoked or given an expiry at any time; a
          revoked or expired key fails every route with <InlineCode>401</InlineCode>.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-text-muted">
          The credential is not a person. It carries no membership and no CRM role - what it may
          do is entirely decided by the scopes it was granted, checked on every request.
        </p>
      </Card>

      <Card>
        <MonoLabel>Scopes</MonoLabel>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          A <InlineCode>:write</InlineCode> scope always implies its <InlineCode>:read</InlineCode>{" "}
          counterpart - a key that can create leads can also list and fetch them, so it is never
          worth requesting both.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left text-sm">
            <thead>
              <tr>
                <Th>Scope</Th>
                <Th>Grants</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <ScopeRow scope="leads:read" grants="List and fetch leads." />
              <ScopeRow scope="leads:write" grants="Create (or converge onto) a lead. Implies leads:read." />
              <ScopeRow scope="contacts:read" grants="List contacts. Phone numbers come back part-masked, never in full." />
              <ScopeRow
                scope="contacts:write"
                grants="Reserved - no route or MCP tool currently requires it."
                reserved
              />
              <ScopeRow scope="deals:read" grants="List deals with stage, value and contact." />
              <ScopeRow
                scope="deals:write"
                grants="Reserved - no route or MCP tool currently requires it."
                reserved
              />
              <ScopeRow scope="projects:read" grants="The tenant's project catalogue." />
              <ScopeRow
                scope="mcp"
                grants={
                  <>
                    Permission to speak MCP at all. Required <em>in addition to</em> a data scope
                    for each tool a key will call - an ordinary integration key cannot be pointed
                    at an AI agent by accident.
                  </>
                }
              />
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <MonoLabel>Rate limits &amp; errors</MonoLabel>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          120 requests/minute per key, on both the REST routes and the MCP endpoint. A key over
          the limit gets <InlineCode>429</InlineCode>.
        </p>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-text-muted">
          <li>
            <StatusChip tone="muted" className="mr-2">401</StatusChip>
            missing, invalid, revoked or expired key, or the tenant&rsquo;s account is suspended.
            One message for all four on purpose - it does not tell a caller which of those is
            true.
          </li>
          <li>
            <StatusChip tone="muted" className="mr-2">403</StatusChip>
            the key is valid but lacks the scope the route requires.
          </li>
          <li>
            <StatusChip tone="muted" className="mr-2">400</StatusChip>
            the request body or query failed validation - the response body is the list of
            issues.
          </li>
        </ul>
      </Card>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text">REST endpoints</h2>

        <Endpoint method="POST" path="/public/leads" scope="leads:write">
          <p>
            Create (or converge onto) a lead, with its contact and deal. Not idempotent by a
            caller-supplied key - convergent by identity instead: two pushes of the same phone
            number update one lead rather than making two. <InlineCode>created</InlineCode> in the
            response says which happened.
          </p>
          <p className="mt-2">
            At least one of <InlineCode>phone</InlineCode>, <InlineCode>email</InlineCode> or{" "}
            <InlineCode>name</InlineCode> is required.
          </p>
          <CodeBlock className="mt-3">{`curl -X POST ${base}/public/leads \\
  -H "Authorization: Bearer $AURA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Priya Shah",
    "phone": "+91 98765 43210",
    "notes": "Asked about the 3BHK launch",
    "value": 8500000,
    "projectKey": "riverside-towers"
  }'`}</CodeBlock>
          <CodeBlock className="mt-2">{`{
  "leadId": "…", "contactId": "…", "dealId": "…",
  "created": true,
  "title": "Priya Shah", "stage": "new", "status": "open",
  "projectKey": "riverside-towers", "projectDetectedFrom": "explicit"
}`}</CodeBlock>
        </Endpoint>

        <Endpoint method="GET" path="/public/leads" scope="leads:read">
          <p>
            List leads, newest activity first. Query params:{" "}
            <InlineCode>limit</InlineCode> (1-200, default 50),{" "}
            <InlineCode>stage</InlineCode>, <InlineCode>projectKey</InlineCode>,{" "}
            <InlineCode>search</InlineCode>.
          </p>
          <CodeBlock className="mt-3">{`curl "${base}/public/leads?limit=20&stage=new" \\
  -H "x-api-key: $AURA_API_KEY"`}</CodeBlock>
        </Endpoint>

        <Endpoint method="GET" path="/public/leads/:id" scope="leads:read">
          <p>One lead by id, including its project and current stage.</p>
        </Endpoint>

        <Endpoint method="GET" path="/public/contacts" scope="contacts:read">
          <p>
            List contacts, newest activity first. <InlineCode>search</InlineCode> matches name or
            email. Same <InlineCode>limit</InlineCode> param as leads.
          </p>
        </Endpoint>

        <Endpoint method="GET" path="/public/deals" scope="deals:read">
          <p>
            List deals with stage, status, amount and contact. Query params:{" "}
            <InlineCode>limit</InlineCode>, <InlineCode>stage</InlineCode>.
          </p>
        </Endpoint>

        <Endpoint method="GET" path="/public/projects" scope="projects:read">
          <p>
            The tenant&rsquo;s project catalogue - call this before{" "}
            <InlineCode>POST /public/leads</InlineCode> to pass an exact{" "}
            <InlineCode>projectKey</InlineCode> instead of relying on automatic detection.
          </p>
        </Endpoint>
      </section>

      <Card>
        <MonoLabel>MCP server</MonoLabel>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          Aura exposed AS an MCP server, for a model-driven agent to work a tenant&rsquo;s
          pipeline directly. Streamable HTTP, JSON-RPC 2.0, one endpoint:
        </p>
        <CodeBlock className="mt-2">{`POST ${base}/mcp`}</CodeBlock>
        <p className="mt-3 text-sm leading-relaxed text-text-muted">
          Point any MCP client at that URL with the same <InlineCode>Authorization: Bearer</InlineCode>{" "}
          header. There is no SSE stream (this server is stateless) - a{" "}
          <InlineCode>GET</InlineCode> answers <InlineCode>405</InlineCode> by spec rather than
          404, so a client looking for one gets a clear answer instead of a wrong-URL guess.
          Reaching it at all needs the <InlineCode>mcp</InlineCode> scope, and each tool below
          additionally needs its own data scope.
        </p>

        <div className="mt-4 space-y-3 text-sm">
          <McpGroup
            title="Tools"
            items={[
              ["create_lead", "leads:write"],
              ["list_leads", "leads:read"],
              ["get_lead", "leads:read"],
              ["list_contacts", "contacts:read"],
              ["list_deals", "deals:read"],
              ["list_projects", "projects:read"],
            ]}
          />
          <McpGroup
            title="Resources"
            items={[
              ["aura://board", "leads:read"],
              ["aura://pipeline", "deals:read"],
              ["aura://projects", "projects:read"],
              ["aura://lead|deal|contact|project/{id}", "matching :read"],
            ]}
          />
          <McpGroup
            title="Prompts"
            items={[
              ["pipeline_review", "deals:read"],
              ["stalled_deals", "deals:read"],
              ["daily_call_list", "leads:read"],
            ]}
          />
        </div>
      </Card>

      <Card>
        <MonoLabel>What this API will never do</MonoLabel>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          Stated plainly, because it shapes what to expect rather than something to work around:
        </p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-text-muted">
          <li>
            <strong className="text-text">No call recordings or transcripts.</strong> There is no
            scope for them - a headless credential cannot reach the most sensitive data in the
            product, structurally, not by a check that could be relaxed.
          </li>
          <li>
            <strong className="text-text">Nothing sends a message.</strong> No email, no
            WhatsApp, no outreach enrolment - on any route, on any tool. An integration may create
            a lead and read a pipeline; it may not put a message in front of a human being.
          </li>
          <li>
            <strong className="text-text">No delete.</strong> An integration that creates data is
            useful; one that can destroy it is a liability with no matching upside.
          </li>
          <li>
            <strong className="text-text">No stage moves.</strong> A deal&rsquo;s stage is the
            owner&rsquo;s call, in the console, by a person.
          </li>
        </ul>
      </Card>

      <Card>
        <MonoLabel>Reports &amp; dashboards</MonoLabel>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          Report Builder output is <strong className="text-text">not</strong> on this API-key
          surface - there is no <InlineCode>/public/reports</InlineCode> route. A report&rsquo;s
          numbers are reached only through a signed-in console session, or through the
          report&rsquo;s own read-only share link (Report Builder → a report → Share → enable
          link), which still requires a session in the owning org rather than a key. If you need a
          report&rsquo;s numbers in an external tool, that link - not this API - is the way in.
        </p>
      </Card>
    </div>
  );
}

// ── small building blocks ───────────────────────────────────────────────────

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[0.85em] text-text">
      {children}
    </code>
  );
}

function CodeBlock({ children, className = "" }: { children: string; className?: string }) {
  return (
    <pre
      className={`overflow-x-auto rounded-lg bg-[#0d1117] p-4 font-mono text-xs leading-relaxed text-[#e6edf3] ${className}`}
    >
      <code>{children}</code>
    </pre>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="border-b border-border px-3 py-2 text-xs font-medium text-text-muted">
      {children}
    </th>
  );
}

function ScopeRow({
  scope,
  grants,
  reserved,
}: {
  scope: string;
  grants: ReactNode;
  reserved?: boolean;
}) {
  return (
    <tr>
      <td className="px-3 py-2 align-top">
        <InlineCode>{scope}</InlineCode>
      </td>
      <td className={`px-3 py-2 align-top ${reserved ? "text-text-subtle italic" : "text-text-muted"}`}>
        {grants}
      </td>
    </tr>
  );
}

const METHOD_TONE: Record<string, string> = {
  GET: "bg-bg-subtle text-text-muted",
  POST: "bg-accent-subtle text-accent-text",
};

function Endpoint({
  method,
  path,
  scope,
  children,
}: {
  method: "GET" | "POST";
  path: string;
  scope: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 font-mono text-xs font-semibold ${METHOD_TONE[method]}`}
        >
          {method}
        </span>
        <span className="font-mono text-sm text-text">{path}</span>
        <StatusChip tone="outline" className="ml-auto">
          {scope}
        </StatusChip>
      </div>
      <div className="mt-3 text-sm leading-relaxed text-text-muted">{children}</div>
    </Card>
  );
}

function McpGroup({ title, items }: { title: string; items: Array<[string, string]> }) {
  return (
    <div>
      <p className="text-xs font-medium text-text-muted">{title}</p>
      <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border">
        {items.map(([name, scope]) => (
          <li key={name} className="flex items-center justify-between gap-3 px-3 py-2">
            <InlineCode>{name}</InlineCode>
            <span className="text-xs text-text-subtle">{scope}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
