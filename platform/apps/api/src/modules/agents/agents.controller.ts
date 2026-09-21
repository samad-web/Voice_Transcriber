import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ExtractionSchema, StoredExtractionSchema } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CallAccessGuard, CallContent } from "../../common/call-access.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { AgentsService } from "./agents.service";

const AgentBody = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  systemPrompt: z.string().max(20000),
  fieldSchema: ExtractionSchema,
  labels: z.array(z.string().max(60)).max(32).default([]),
  activate: z.boolean().default(false),
});

const NewVersionBody = AgentBody.omit({ workspaceId: true, name: true });
const ActivateBody = z.object({ version: z.number().int().positive() });
const TestBody = z.object({
  callId: z.string().uuid(),
  version: z.number().int().positive().optional(),
});
const GenerateBody = z.object({
  description: z.string().min(1).max(2000),
  /** Draft a MODIFICATION of this agent per `description`, instead of a
   *  fresh one - the Studio's "start from an existing agent" + "describe
   *  with AI" paths composed. Defaults to the latest version. */
  baseAgentId: z.string().uuid().optional(),
  baseVersion: z.number().int().positive().optional(),
});

const actorOf = (req: PrincipalRequest) => ({ userId: req.principal?.userId ?? "dev-admin" });

/**
 * The OPERATOR's Agent Studio - any tenant, on the admin key.
 *
 * Agents are versioned and immutable (design doc §4): creating is v1, editing
 * inserts a new version, activation flips is_active. Every write goes through
 * `AgentsService`, which the tenant's own studio (owner-agents.controller.ts)
 * shares, so the two consoles cannot disagree about what switching an agent on
 * does. This surface only ever writes call extractors - the kinds 0121 added
 * are authored by the tenant, and their request shapes live on that controller.
 * TODO: instance.default_agent_id routing.
 */
@Controller("agents")
@UseGuards(AdminKeyGuard, TenantGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = AgentBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const a = parsed.data;
    return this.agents.create(
      orgId,
      actorOf(req),
      {
        kind: "call_extractor",
        name: a.name,
        purpose: "",
        systemPrompt: a.systemPrompt,
        fields: a.fieldSchema.fields,
        leadRules: {},
        config: {},
        labels: a.labels,
      },
      { workspaceId: a.workspaceId, activate: a.activate },
    );
  }

  /** Editing = new immutable version. Lead rules, purpose and config carry forward. */
  @Post(":id/versions")
  async newVersion(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = NewVersionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const a = parsed.data;
    return this.agents.newVersion(
      orgId,
      actorOf(req),
      agentId,
      { systemPrompt: a.systemPrompt, fields: a.fieldSchema.fields, labels: a.labels },
      { activate: a.activate },
    );
  }

  @Post(":id/activate")
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

  @Get()
  async list(@OrgId() orgId: string) {
    // system_prompt is included so the web Studio's "Start from" picker
    // can clone an existing agent's prompt client-side, from this one
    // list call, without a per-agent round trip. Every kind is returned, with
    // `kind` on each row; archived agents are not.
    return { agents: await this.agents.listVersions(orgId) };
  }

  /**
   * Draft a new agent definition from a free-text description, WITHOUT
   * persisting it - same non-persisting-preview contract as `:id/test` below.
   * When `baseAgentId` is given, drafts a MODIFICATION of that agent. Its
   * current definition is read through `withOrg`, so a caller can never read
   * another tenant's agent by id.
   */
  @Post("generate")
  async generate(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = GenerateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.agents.draft(orgId, { kind: "call_extractor", ...parsed.data });
  }

  /**
   * §9: run an agent version against a stored call WITHOUT persisting - the
   * feature every tenant asks for in week two. Uses the same analyze core as
   * the pipeline, so what you test is what runs.
   */
  @Post(":id/test")
  // Reads a stored call's transcript and hands it to an LLM, returning what it
  // extracted. That is call content arriving by a slightly longer route, so it
  // carries the same gate the transcript itself does (0122).
  @UseGuards(AdminKeyGuard, TenantGuard, CallAccessGuard)
  @CallContent()
  async test(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Body() body: unknown,
  ) {
    const parsed = TestBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { callId, version } = parsed.data;

    const agent = await this.agents.storedVersion(orgId, agentId, version);
    const result = await this.agents.testExtractor(orgId, {
      systemPrompt: agent.system_prompt,
      fields: StoredExtractionSchema.parse(agent.field_schema ?? { fields: [] }).fields,
      leadRules: agent.lead_rules ?? {},
      callId,
    });
    return { agentVersion: agent.version, ...result };
  }
}
