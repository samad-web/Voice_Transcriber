import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AgentDefinition, AgentKind } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { type AgentWrite, AgentsService } from "./agents.service";

/**
 * The TENANT's own AI Agent Studio (migration 0121) - `/owner/agents`.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────────
 *
 * Owner and manager, on every route, enforced here by `OwnerRoleGuard` reading
 * `memberships` - not by the console. An agent decides which calls become
 * leads and how the floor's conversations are judged; a telecaller editing the
 * thing that decides whether their calls count is the same shape of access the
 * SOP controller refuses, for the same reason.
 *
 * ── WHAT ────────────────────────────────────────────────────────────────────
 *
 * The same `AgentsService` the operator's studio uses, so activation means one
 * thing everywhere. What is different is the request shape: the owner submits
 * an `AgentDefinition` (packages/shared agent-kinds.ts), which validates lead
 * rules against the fields they name and refuses the combinations that would
 * silently produce no leads. The operator surface predates that and keeps its
 * looser body.
 *
 * `@RequireFeature("agent_studio")` makes "off" mean off for the studio itself.
 * It deliberately does NOT stop an agent that is already running - switching a
 * console page off must not silently stop a tenant's calls becoming leads.
 */

const Definition = z.unknown();

const CreateBody = z.object({
  definition: Definition,
  /** Required for a call extractor in an org with more than one workspace. */
  workspaceId: z.string().uuid().nullable().optional(),
  activate: z.boolean().default(false),
});

const VersionBody = z.object({
  definition: Definition,
  activate: z.boolean().default(false),
});

const ActivateBody = z.object({ version: z.number().int().positive() });

const GenerateBody = z.object({
  kind: AgentKind,
  description: z.string().trim().min(1).max(2000),
  baseAgentId: z.string().uuid().optional(),
  baseVersion: z.number().int().positive().optional(),
});

const TestBody = z.object({
  definition: Definition,
  callId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
});

const SampleQuery = z.object({ source: z.enum(["calls", "conversations"]).default("calls") });

const VersionQuery = z.object({ version: z.coerce.number().int().positive().optional() });

function parseDefinition(raw: unknown, opts: { forTest?: boolean } = {}) {
  // A test run does not need a name - the owner is still deciding what the
  // agent does, let alone what to call it. Saving does.
  const candidate =
    opts.forTest && raw && typeof raw === "object"
      ? {
          ...(raw as Record<string, unknown>),
          name: String((raw as { name?: unknown }).name ?? "").trim() || "Untitled",
        }
      : raw;
  const parsed = AgentDefinition.safeParse(candidate);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

function toWrite(def: AgentDefinition): Omit<AgentWrite, "labels"> {
  return {
    kind: def.kind,
    name: def.name,
    purpose: def.purpose,
    systemPrompt: def.instructions,
    fields: def.fields,
    leadRules: def.kind === "call_extractor" ? def.leadRules : {},
    config: def.config,
  };
}

const actorOf = (req: PrincipalRequest) => ({ userId: req.principal?.userId ?? "unknown" });

@Controller("owner/agents")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
@RequireFeature("agent_studio")
export class OwnerAgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly db: DbService,
  ) {}

  /** The studio's overview: one summary per agent, plus what the editor needs to offer. */
  @Get()
  @RequireOwnerRole("owner", "manager")
  async list(@OrgId() orgId: string) {
    const [agents, workspaces, org] = await Promise.all([
      this.agents.summaries(orgId),
      this.agents.workspaces(orgId),
      this.db.withOrg(orgId, async (client) => {
        const {
          rows: [row],
        } = await client.query<{ whatsapp_qualification_enabled: boolean }>(
          "SELECT whatsapp_qualification_enabled FROM organizations WHERE id = $1",
          [orgId],
        );
        return row;
      }),
    ]);
    return {
      agents,
      workspaces,
      // A chat qualifier shapes qualification; it does not switch it on. That
      // switch sends customer conversations to an AI provider and stays with
      // the operator (0082), so the studio has to be able to say it is off.
      qualificationEnabled: org?.whatsapp_qualification_enabled ?? false,
    };
  }

  /**
   * Recent calls or conversations to test an agent against.
   *
   * Declared BEFORE `:id` on purpose: Nest matches routes in declaration order
   * and `:id` carries a ParseUUIDPipe, so declared after it `samples` would be
   * swallowed as a malformed id and answered with a 400.
   */
  @Get("samples")
  @RequireOwnerRole("owner", "manager")
  async samples(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = SampleQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (parsed.data.source === "conversations") {
      return { conversations: await this.agents.conversationSamples(orgId) };
    }
    return { calls: await this.agents.callSamples(orgId) };
  }

  @Get(":id")
  @RequireOwnerRole("owner", "manager")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Query() query: unknown,
  ) {
    const parsed = VersionQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.agents.detail(orgId, agentId, parsed.data.version);
  }

  @Post()
  @RequireOwnerRole("owner", "manager")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const definition = parseDefinition(parsed.data.definition);
    return this.agents.create(
      orgId,
      actorOf(req),
      { ...toWrite(definition), labels: [] },
      { workspaceId: parsed.data.workspaceId ?? null, activate: parsed.data.activate },
    );
  }

  /** Draft a definition from a description. Persists nothing. */
  @Post("generate")
  @RequireOwnerRole("owner", "manager")
  async generate(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = GenerateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const draft = await this.agents.draft(orgId, parsed.data);
    return { name: draft.name, instructions: draft.systemPrompt, fields: draft.fields };
  }

  /**
   * Run the definition on the screen - saved or not - against a real call.
   * Persists nothing except the usage it spent.
   */
  @Post("test")
  @RequireOwnerRole("owner", "manager")
  async test(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = TestBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const definition = parseDefinition(parsed.data.definition, { forTest: true });

    if (definition.kind === "call_extractor") {
      if (!parsed.data.callId) throw new BadRequestException("Choose a call to test against.");
      return this.agents.testExtractor(orgId, {
        systemPrompt: definition.instructions,
        fields: definition.fields,
        leadRules: definition.leadRules,
        callId: parsed.data.callId,
      });
    }
    if (definition.kind === "chat_qualifier") {
      if (!parsed.data.conversationId) {
        throw new BadRequestException("Choose a WhatsApp conversation to test against.");
      }
      return this.agents.testQualifier(orgId, {
        instructions: definition.instructions,
        fields: definition.fields,
        conversationId: parsed.data.conversationId,
      });
    }
    // reply_drafter: from a call or a conversation, whichever the owner picked.
    const { callId, conversationId } = parsed.data;
    if (!callId && !conversationId) {
      throw new BadRequestException("Choose a call or a conversation to draft a reply for.");
    }
    return this.agents.draftReply(orgId, {
      source: callId ? { callId } : { conversationId: conversationId! },
      definition: { instructions: definition.instructions, config: definition.config },
      // The studio has not checked transcript access; the service does, for a call.
      transcriptReaderUserId: req.principal?.userId ?? "",
    });
  }

  /** Save an edit as the next version. */
  @Post(":id/versions")
  @RequireOwnerRole("owner", "manager")
  async newVersion(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = VersionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const definition = parseDefinition(parsed.data.definition);
    return this.agents.newVersion(orgId, actorOf(req), agentId, toWrite(definition), {
      activate: parsed.data.activate,
    });
  }

  /** Switch a version on - including an older one, which is how a change is rolled back. */
  @Post(":id/activate")
  @RequireOwnerRole("owner", "manager")
  async activate(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = ActivateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.agents.activate(orgId, actorOf(req), agentId, parsed.data.version);
  }

  @Post(":id/deactivate")
  @RequireOwnerRole("owner", "manager")
  async deactivate(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.agents.deactivate(orgId, actorOf(req), agentId);
  }

  @Post(":id/archive")
  @RequireOwnerRole("owner", "manager")
  async archive(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.agents.archive(orgId, actorOf(req), agentId);
  }
}
