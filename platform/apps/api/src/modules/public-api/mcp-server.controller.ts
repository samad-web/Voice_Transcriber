import { Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { MCP_PROTOCOL_VERSION, hasScope, type ApiScope } from "@aura/shared";
import { ApiKeyGuard, RequireScope } from "../../common/api-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { CrmContextService } from "./crm-context.service";
import { CrmIngestService } from "./crm-ingest.service";

/**
 * Aura's CRM, exposed AS an MCP server.
 *
 * The existing `mcp/connections` surface is the opposite direction: it makes
 * Aura a CLIENT of somebody else's MCP server (Meta's, today). This is the
 * inbound half - a model-driven agent connects here and works the tenant's
 * pipeline.
 *
 * ── EVERY TOOL IS A THIN CALL INTO CrmIngestService ──────────────────────
 *
 * There is no SQL in this file. Each tool is the same service method its REST
 * twin calls, so "create a lead" cannot come to mean two different things
 * depending on which door it arrived through. That is the entire reason the
 * service exists.
 *
 * ── WHAT AN AGENT MAY DO, AND WHAT IT MAY NEVER DO ───────────────────────
 *
 * May: read leads, contacts, deals and the project catalogue; create a lead.
 *
 * May NOT, and there is no tool, no scope and no route for any of it:
 *   * SEND ANYTHING. No message, no email, no WhatsApp, no outreach
 *     enrolment. The standing rule is that nothing automated can send, and a
 *     model-driven agent is the most literal instance of "automated" this
 *     product will ever have. Enforced by absence, not by a runtime check
 *     somebody could relax later.
 *   * Read call recordings or transcripts. `ApiKeyGuard` writes a principal
 *     with both recording permissions false, and no scope for them exists.
 *   * Delete or merge anything.
 *   * Move a card between stages. Stage is the owner's - the same rule
 *     upsertLead and projectLeadToCrm already honour by omitting stage from
 *     their ON CONFLICT updates. An agent that could advance deals would be
 *     writing the tenant's forecast.
 *
 * ── TWO KEYS' WORTH OF PERMISSION ────────────────────────────────────────
 *
 * Reaching this endpoint at all needs the `mcp` scope; each tool then needs its
 * own data scope. So "this key may be driven by a model" is a separate,
 * separately-revocable decision from "this key may write leads" - an ordinary
 * backend integration key cannot be repointed at an agent.
 *
 * `tools/list` returns only the tools the presented key can actually call.
 * Advertising a tool the caller will be refused for teaches an agent to retry
 * something that can never succeed.
 */

const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

interface ToolDef {
  name: string;
  scope: ApiScope;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (
    svc: CrmIngestService,
    orgId: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "create_lead",
    scope: "leads:write",
    description:
      "Create a lead in the CRM, with its contact and deal. Converges on an existing lead when the phone number already exists rather than creating a duplicate. Returns the ids and whether it was newly created.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The person's name" },
        phone: { type: "string", description: "Phone number, any format" },
        email: { type: "string", description: "Email address" },
        notes: {
          type: "string",
          description:
            "What the enquiry is about. Also what the project detector reads, so mentioning the offering by name here labels the lead automatically.",
        },
        value: { type: "number", description: "Expected deal value" },
        projectKey: {
          type: "string",
          description:
            "Which project this is for, from list_projects. Overrides automatic detection and is recorded as human-set.",
        },
      },
      additionalProperties: false,
    },
    run: (svc, orgId, args) =>
      svc.createLead(orgId, {
        name: str(args.name),
        phone: str(args.phone),
        email: str(args.email),
        notes: str(args.notes),
        value: typeof args.value === "number" ? args.value : null,
        projectKey: str(args.projectKey),
      }),
  },
  {
    name: "list_leads",
    scope: "leads:read",
    description:
      "List leads, newest activity first. Optionally filter by stage or by project key.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max rows, 1-200 (default 50)" },
        stage: { type: "string" },
        projectKey: { type: "string" },
      },
      additionalProperties: false,
    },
    run: (svc, orgId, args) =>
      svc.listLeads(orgId, {
        limit: clampLimit(args.limit),
        stage: str(args.stage),
        projectKey: str(args.projectKey),
      }),
  },
  {
    name: "get_lead",
    scope: "leads:read",
    description: "Fetch one lead by id, including its project and current stage.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Lead uuid" } },
      required: ["id"],
      additionalProperties: false,
    },
    run: (svc, orgId, args) => {
      const id = z.string().uuid().safeParse(args.id);
      if (!id.success) throw new Error("id must be a uuid");
      return svc.getLead(orgId, id.data);
    },
  },
  {
    name: "list_contacts",
    scope: "contacts:read",
    description:
      "List contacts, newest activity first. `search` matches name or email. Phone numbers are never returned in full - only a prefix and last three digits.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        search: { type: "string" },
      },
      additionalProperties: false,
    },
    run: (svc, orgId, args) =>
      svc.listContacts(orgId, { limit: clampLimit(args.limit), search: str(args.search) }),
  },
  {
    name: "list_deals",
    scope: "deals:read",
    description: "List deals with their stage, value, contact and project.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" }, stage: { type: "string" } },
      additionalProperties: false,
    },
    run: (svc, orgId, args) =>
      svc.listDeals(orgId, { limit: clampLimit(args.limit), stage: str(args.stage) }),
  },
  {
    name: "list_projects",
    scope: "projects:read",
    description:
      "The tenant's project catalogue - what they sell. Call this before create_lead to pass an exact projectKey.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (svc, orgId) => svc.listProjects(orgId),
  },
];

/**
 * RESOURCES - context a USER attaches, rather than a tool a model calls.
 *
 * The distinction matters and is why these exist alongside the tools: a tool is
 * invoked by the model when it decides to, a resource is picked by the person
 * in their client and attached to the conversation. "Look at my board while we
 * talk" is a resource; "go and create this lead" is a tool.
 *
 * Every one is scope-gated exactly as a tool is, and `resources/list` returns
 * only what the presented key may actually read - the same reasoning as
 * `tools/list`: advertising something that will be refused teaches an agent to
 * retry what cannot work.
 */
interface ResourceDef {
  uri: string;
  name: string;
  scope: ApiScope;
  description: string;
  read: (ctx: CrmContextService, orgId: string, scopes: readonly string[]) => Promise<unknown>;
}

const RESOURCES: ResourceDef[] = [
  {
    uri: "aura://board",
    name: "Sales board",
    scope: "leads:read",
    description:
      "The default board: every column in order, with how many leads and how much open deal value sits in each.",
    read: async (ctx, orgId, scopes) => {
      const summary = await ctx.boardSummary(orgId);
      // A key with leads:read but not deals:read sees the shape of the board
      // and its lead counts, but not the money. Stripped here rather than in
      // SQL so the query stays one statement and the redaction is visible.
      if (hasScope(scopes, "deals:read")) return summary;
      return {
        ...summary,
        columns: summary.columns.map((c: Record<string, unknown>) => {
          const { deal_count, deal_value, ...rest } = c;
          void deal_count;
          void deal_value;
          return rest;
        }),
      };
    },
  },
  {
    uri: "aura://pipeline",
    name: "Open pipeline",
    scope: "deals:read",
    description:
      "Open deal count and value, broken down by stage and by project, plus won/lost totals.",
    read: (ctx, orgId) => ctx.pipelineSummary(orgId),
  },
  {
    uri: "aura://projects",
    name: "Project catalogue",
    scope: "projects:read",
    description: "Everything this tenant sells, with the aliases the call detector matches on.",
    read: (ctx, orgId) => ctx.listProjectsWithStats(orgId),
  },
];

interface TemplateDef {
  uriTemplate: string;
  name: string;
  scope: ApiScope;
  description: string;
  pattern: RegExp;
  read: (ctx: CrmContextService, orgId: string, arg: string) => Promise<unknown>;
}

const TEMPLATES: TemplateDef[] = [
  {
    uriTemplate: "aura://lead/{id}",
    name: "Lead",
    scope: "leads:read",
    description: "One lead, with every project it has been discussed for.",
    pattern: /^aura:\/\/lead\/([0-9a-fA-F-]{36})$/u,
    read: (ctx, orgId, id) => ctx.lead(orgId, id),
  },
  {
    uriTemplate: "aura://deal/{id}",
    name: "Deal",
    scope: "deals:read",
    description: "One deal, with its stage history.",
    pattern: /^aura:\/\/deal\/([0-9a-fA-F-]{36})$/u,
    read: (ctx, orgId, id) => ctx.deal(orgId, id),
  },
  {
    uriTemplate: "aura://contact/{id}",
    name: "Contact",
    scope: "contacts:read",
    description:
      "One contact, their deals, and their timeline as subject/snippet only - never message bodies or transcripts.",
    pattern: /^aura:\/\/contact\/([0-9a-fA-F-]{36})$/u,
    read: (ctx, orgId, id) => ctx.contact(orgId, id),
  },
  {
    uriTemplate: "aura://project/{key}",
    name: "Project",
    scope: "projects:read",
    description: "One project with its open/won deal counts and value.",
    pattern: /^aura:\/\/project\/([a-z0-9][a-z0-9_-]*)$/u,
    read: (ctx, orgId, key) => ctx.project(orgId, key),
  },
];

/**
 * PROMPTS - the tenant's own operating procedure, encoded once.
 *
 * These surface in a client as user-invoked commands (a slash-command, in most
 * of them). Each one fetches its data server-side and returns it inside the
 * message, so the agent starts with the numbers rather than making six tool
 * calls to assemble them - and so the prompt works for a key that holds only
 * the scopes that prompt needs.
 */
interface PromptDef {
  name: string;
  title: string;
  scope: ApiScope;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  build: (
    ctx: CrmContextService,
    orgId: string,
    args: Record<string, string>,
  ) => Promise<{ description: string; text: string }>;
}

const PROMPTS: PromptDef[] = [
  {
    name: "pipeline_review",
    title: "Pipeline review",
    scope: "deals:read",
    description:
      "A walk through the open pipeline by stage and project, with the board's current shape.",
    arguments: [
      { name: "projectKey", description: "Limit the review to one project", required: false },
    ],
    build: async (ctx, orgId, args) => {
      const pipeline = await ctx.pipelineSummary(orgId);
      const focus = args.projectKey
        ? `\n\nFocus only on the project '${args.projectKey}'.`
        : "";
      return {
        description: "Review the open pipeline",
        text:
          "Here is the current state of my sales pipeline.\n\n" +
          `${JSON.stringify(pipeline, null, 2)}\n\n` +
          "Walk me through it: where is the value concentrated, which stage is " +
          "clogged, and what looks wrong. Be specific and do not pad the answer." +
          focus,
      };
    },
  },
  {
    name: "stalled_deals",
    title: "Stalled deals",
    scope: "deals:read",
    description:
      "Open deals that have not changed stage in a while, oldest first - the ones quietly dying.",
    arguments: [
      { name: "days", description: "How long without a stage change counts as stalled (default 21)", required: false },
    ],
    build: async (ctx, orgId, args) => {
      const days = clampDays(args.days);
      const rows = await ctx.stalledDeals(orgId, days);
      return {
        description: `Deals with no stage change in ${days} days`,
        text:
          `These open deals have not moved stage in ${days}+ days, oldest first.\n\n` +
          `${JSON.stringify(rows, null, 2)}\n\n` +
          "For each one, say what you would do next and why. Group them if that " +
          "makes the answer shorter. Do not draft or send any message - just tell " +
          "me the call I should make.",
      };
    },
  },
  {
    name: "daily_call_list",
    title: "Who to call today",
    scope: "leads:read",
    description: "A prioritised call list built from the board and what has gone quiet.",
    arguments: [],
    build: async (ctx, orgId) => {
      const [board, stalled] = await Promise.all([
        ctx.boardSummary(orgId),
        ctx.stalledDeals(orgId, 14, 15).catch(() => []),
      ]);
      return {
        description: "Build today's call list",
        text:
          "Here is my board and the deals that have gone quiet.\n\n" +
          `BOARD:\n${JSON.stringify(board, null, 2)}\n\n` +
          `QUIET DEALS:\n${JSON.stringify(stalled, null, 2)}\n\n` +
          "Give me a prioritised list of who to call today and the one thing to " +
          "say to each. Keep it to ten or fewer.",
      };
    },
  },
];

@Controller("mcp")
@UseGuards(ApiKeyGuard, TenantGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class McpServerController {
  constructor(
    private readonly ingest: CrmIngestService,
    private readonly context: CrmContextService,
  ) {}

  /**
   * Streamable HTTP's optional server→client SSE stream.
   *
   * We do not offer one: this server is stateless, holds no session, and has
   * nothing to push. The spec says a server that does not support the stream
   * MUST return 405 - so it is answered explicitly rather than left unmounted,
   * where Nest's 404 would read to a client as "wrong URL" and send it looking
   * for an endpoint that does not exist.
   */
  @Get()
  @HttpCode(405)
  @RequireScope("mcp")
  stream(@Res() res: Response) {
    res.setHeader("Allow", "POST");
    res.status(405).json(
      rpcError(null, -32000, "this server does not offer the SSE stream; POST JSON-RPC instead"),
    );
  }

  @Post()
  @HttpCode(200)
  @RequireScope("mcp")
  async rpc(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Res() res: Response) {
    const body = req.body as unknown;

    // MCP removed JSON-RPC batching in 2025-06-18. Refusing an array explicitly
    // beats half-implementing it and silently answering only the first call.
    if (Array.isArray(body)) {
      res.status(400).json(rpcError(null, -32600, "batch requests are not supported"));
      return;
    }

    const parsed = JsonRpcRequest.safeParse(body);
    if (!parsed.success) {
      res.status(400).json(rpcError(null, -32600, "invalid JSON-RPC 2.0 request"));
      return;
    }
    const { id, method, params } = parsed.data;

    // A request without `id` is a NOTIFICATION: no response body, ever.
    // `notifications/initialized` is the one every client sends after the
    // handshake, and answering it with a result is a protocol violation.
    if (id === undefined) {
      res.status(202).send();
      return;
    }

    const scopes = req.apiKey?.scopes ?? [];

    try {
      switch (method) {
        case "initialize":
          res.json(
            rpcResult(id, {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {
                tools: { listChanged: false },
                // `subscribe: false` is honest rather than modest: subscriptions
                // would need the SSE stream this server answers 405 for.
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
                completions: {},
              },
              serverInfo: { name: "aura-crm", version: "1.1.0" },
              instructions:
                "Aura CRM. Tools create and read leads, contacts, deals and projects. " +
                "Resources (aura://board, aura://pipeline, aura://projects, and " +
                "aura://lead|deal|contact|project/{id}) are read-only context. Prompts " +
                "package common reviews. " +
                "This server cannot send messages, move deals between stages, delete or " +
                "merge records, or read call recordings or transcripts - no such tool exists.",
            }),
          );
          return;

        case "ping":
          res.json(rpcResult(id, {}));
          return;

        case "tools/list":
          res.json(
            rpcResult(id, {
              tools: TOOLS.filter((t) => hasScope(scopes, t.scope)).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            }),
          );
          return;

        case "resources/list":
          res.json(
            rpcResult(id, {
              resources: RESOURCES.filter((r) => hasScope(scopes, r.scope)).map((r) => ({
                uri: r.uri,
                name: r.name,
                description: r.description,
                mimeType: "application/json",
              })),
            }),
          );
          return;

        case "resources/templates/list":
          res.json(
            rpcResult(id, {
              resourceTemplates: TEMPLATES.filter((t) => hasScope(scopes, t.scope)).map((t) => ({
                uriTemplate: t.uriTemplate,
                name: t.name,
                description: t.description,
                mimeType: "application/json",
              })),
            }),
          );
          return;

        case "resources/read": {
          const uri = typeof params?.uri === "string" ? params.uri : "";

          const fixed = RESOURCES.find((r) => r.uri === uri);
          if (fixed) {
            if (!hasScope(scopes, fixed.scope)) {
              await this.event(req, orgId, uri, "forbidden_scope", { required: fixed.scope });
              res.json(rpcError(id, -32002, `this API key lacks the '${fixed.scope}' scope`));
              return;
            }
            const body = await fixed.read(this.context, orgId, scopes);
            await this.event(req, orgId, uri, "ok", {});
            res.json(rpcResult(id, { contents: [jsonContent(uri, body)] }));
            return;
          }

          const template = TEMPLATES.find((t) => t.pattern.test(uri));
          if (!template) {
            // -32002 is MCP's "resource not found", distinct from a bad param.
            res.json(rpcError(id, -32002, `no such resource: ${uri}`));
            return;
          }
          if (!hasScope(scopes, template.scope)) {
            await this.event(req, orgId, uri, "forbidden_scope", { required: template.scope });
            res.json(rpcError(id, -32002, `this API key lacks the '${template.scope}' scope`));
            return;
          }
          const arg = template.pattern.exec(uri)![1];
          const body = await template.read(this.context, orgId, arg);
          await this.event(req, orgId, uri, "ok", {});
          res.json(rpcResult(id, { contents: [jsonContent(uri, body)] }));
          return;
        }

        case "prompts/list":
          res.json(
            rpcResult(id, {
              prompts: PROMPTS.filter((p) => hasScope(scopes, p.scope)).map((p) => ({
                name: p.name,
                title: p.title,
                description: p.description,
                arguments: p.arguments,
              })),
            }),
          );
          return;

        case "prompts/get": {
          const name = typeof params?.name === "string" ? params.name : "";
          const prompt = PROMPTS.find((p) => p.name === name);
          if (!prompt) {
            res.json(rpcError(id, -32602, `no such prompt: ${name}`));
            return;
          }
          if (!hasScope(scopes, prompt.scope)) {
            await this.event(req, orgId, name, "forbidden_scope", { required: prompt.scope });
            res.json(rpcError(id, -32602, `this API key lacks the '${prompt.scope}' scope`));
            return;
          }
          const args = (params?.arguments ?? {}) as Record<string, string>;
          const built = await prompt.build(this.context, orgId, args);
          await this.event(req, orgId, name, "ok", {});
          res.json(
            rpcResult(id, {
              description: built.description,
              messages: [{ role: "user", content: { type: "text", text: built.text } }],
            }),
          );
          return;
        }

        /**
         * Argument autocomplete. Both of the things worth completing here -
         * project keys and board column keys - are closed sets the tenant
         * already owns, which is exactly when completion earns its keep: it
         * stops an agent guessing "3d website" when the key is "3d-website".
         */
        case "completion/complete": {
          const ref = (params?.ref ?? {}) as { type?: string; name?: string; uri?: string };
          const argument = (params?.argument ?? {}) as { name?: string; value?: string };
          const typed = (argument.value ?? "").toLowerCase();

          let values: string[] = [];
          const wantsProject =
            argument.name === "projectKey" ||
            (argument.name === "key" && ref.uri === "aura://project/{key}");
          const wantsColumn = argument.name === "stage" || argument.name === "columnKey";

          if (wantsProject && hasScope(scopes, "projects:read")) {
            values = await this.context.projectKeys(orgId);
          } else if (wantsColumn && hasScope(scopes, "leads:read")) {
            values = await this.context.columnKeys(orgId);
          }

          const matched = values.filter((v) => v.toLowerCase().startsWith(typed));
          res.json(
            rpcResult(id, {
              // The spec caps a completion response at 100 values and asks for
              // `hasMore` when truncated.
              completion: {
                values: matched.slice(0, 100),
                total: matched.length,
                hasMore: matched.length > 100,
              },
            }),
          );
          return;
        }

        case "tools/call": {
          const name = typeof params?.name === "string" ? params.name : "";
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          const tool = TOOLS.find((t) => t.name === name);

          if (!tool) {
            res.json(rpcError(id, -32602, `no such tool: ${name}`));
            return;
          }
          if (!hasScope(scopes, tool.scope)) {
            await this.event(req, orgId, name, "forbidden_scope", { required: tool.scope });
            // A scope refusal is a TOOL error, not a transport error: the agent
            // should see it as a failed call it may not retry, not as a broken
            // connection it should reconnect over.
            res.json(
              rpcResult(id, {
                content: [
                  {
                    type: "text",
                    text: `This API key lacks the '${tool.scope}' scope, so ${name} is not available.`,
                  },
                ],
                isError: true,
              }),
            );
            return;
          }

          const out = await tool.run(this.ingest, orgId, args);
          await this.event(req, orgId, name, "ok", {});
          res.json(
            rpcResult(id, {
              content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
              // structuredContent so a client that understands it does not have
              // to re-parse the text block.
              structuredContent: out as Record<string, unknown>,
            }),
          );
          return;
        }

        default:
          res.json(rpcError(id, -32601, `method not found: ${method}`));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "tool failed";
      await this.event(req, orgId, method, "error", { message });
      // Surfaced as a tool error with `isError`, so the agent can read what
      // went wrong and correct its arguments rather than seeing a bare 500.
      res.json(
        rpcResult(id, { content: [{ type: "text", text: message }], isError: true }),
      );
    }
  }

  private async event(
    req: PrincipalRequest,
    orgId: string,
    operation: string,
    status: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!req.apiKey) return;
    await this.ingest.recordEvent(orgId, req.apiKey.id, "mcp", operation, status, detail);
  }
}

function rpcResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** One resource body. JSON in a text block - the shape every MCP client reads. */
function jsonContent(uri: string, body: unknown) {
  return { uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) };
}

function clampDays(v: string | undefined): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return 21;
  return Math.min(365, Math.max(1, n));
}

function clampLimit(v: unknown): number {
  const n = typeof v === "number" ? Math.floor(v) : 50;
  return Math.min(200, Math.max(1, Number.isFinite(n) ? n : 50));
}
