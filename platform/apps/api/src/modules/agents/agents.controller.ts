import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ExtractionSchema } from "@aura/shared";
import { analyzeTranscript } from "@aura/llm";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

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
const TestBody = z.object({ callId: z.string().uuid(), version: z.number().int().positive().optional() });

/**
 * Agents are versioned and immutable (design doc §4): creating is v1, editing
 * inserts a new version, activation flips is_active. Analyze resolves the
 * active agent per workspace. TODO: instance.default_agent_id routing.
 */
@Controller("agents")
@UseGuards(AdminKeyGuard)
export class AgentsController {
  constructor(private readonly db: DbService) {}

  @Post()
  async create(@Headers("x-org-id") orgHeader: string | undefined, @Body() body: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = AgentBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const a = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const ws = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [a.workspaceId]);
      if (ws.rowCount === 0) throw new NotFoundException("workspace not found in this org");

      if (a.activate) {
        await client.query(
          "UPDATE agents SET is_active = false WHERE workspace_id = $1",
          [a.workspaceId],
        );
      }
      const {
        rows: [agent],
      } = await client.query(
        `INSERT INTO agents (org_id, workspace_id, name, version, system_prompt, field_schema, labels, is_active)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7)
         RETURNING id, name, version, is_active, created_at`,
        [orgId, a.workspaceId, a.name, a.systemPrompt, JSON.stringify(a.fieldSchema), JSON.stringify(a.labels), a.activate],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'agent.create', 'agent', $2)`,
        [orgId, agent.id],
      );
      return agent;
    });
  }

  /** Editing = new immutable version. */
  @Post(":id/versions")
  async newVersion(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Body() body: unknown,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = NewVersionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const a = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [latest],
      } = await client.query(
        `SELECT workspace_id, name, max(version) AS version FROM agents
          WHERE id = $1 GROUP BY workspace_id, name`,
        [agentId],
      );
      if (!latest) throw new NotFoundException("agent not found");

      if (a.activate) {
        await client.query("UPDATE agents SET is_active = false WHERE workspace_id = $1", [
          latest.workspace_id,
        ]);
      }
      const {
        rows: [agent],
      } = await client.query(
        `INSERT INTO agents (id, org_id, workspace_id, name, version, system_prompt, field_schema, labels, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, version, is_active, created_at`,
        [
          agentId,
          orgId,
          latest.workspace_id,
          latest.name,
          Number(latest.version) + 1,
          a.systemPrompt,
          JSON.stringify(a.fieldSchema),
          JSON.stringify(a.labels),
          a.activate,
        ],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', 'dev-admin', 'agent.new_version', 'agent', $2, $3)`,
        [orgId, agentId, JSON.stringify({ version: agent.version })],
      );
      return agent;
    });
  }

  @Post(":id/activate")
  async activate(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Body() body: unknown,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = ActivateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [target],
      } = await client.query("SELECT workspace_id FROM agents WHERE id = $1 AND version = $2", [
        agentId,
        parsed.data.version,
      ]);
      if (!target) throw new NotFoundException("agent version not found");
      await client.query("UPDATE agents SET is_active = false WHERE workspace_id = $1", [
        target.workspace_id,
      ]);
      const {
        rows: [agent],
      } = await client.query(
        `UPDATE agents SET is_active = true WHERE id = $1 AND version = $2
         RETURNING id, name, version, is_active`,
        [agentId, parsed.data.version],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', 'dev-admin', 'agent.activate', 'agent', $2, $3)`,
        [orgId, agentId, JSON.stringify({ version: parsed.data.version })],
      );
      return agent;
    });
  }

  @Get()
  async list(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, workspace_id, name, version, field_schema, labels, is_active, created_at
           FROM agents ORDER BY name, version DESC`,
      );
      return { agents: rows };
    });
  }

  /**
   * §9: run an agent version against a stored call WITHOUT persisting — the
   * feature every tenant asks for in week two. Uses the same analyze core as
   * the pipeline, so what you test is what runs.
   */
  @Post(":id/test")
  async test(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) agentId: string,
    @Body() body: unknown,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = TestBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { callId, version } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [agent],
      } = await client.query(
        version
          ? "SELECT system_prompt, field_schema, version FROM agents WHERE id = $1 AND version = $2"
          : "SELECT system_prompt, field_schema, version FROM agents WHERE id = $1 ORDER BY version DESC LIMIT 1",
        version ? [agentId, version] : [agentId],
      );
      if (!agent) throw new NotFoundException("agent not found");

      const {
        rows: [transcript],
      } = await client.query("SELECT text FROM transcripts WHERE call_id = $1", [callId]);
      if (!transcript) throw new NotFoundException("no transcript for that call");

      const schema = ExtractionSchema.parse(agent.field_schema);
      const result = await analyzeTranscript(agent.system_prompt, schema, transcript.text);
      return { agentVersion: agent.version, ...result };
    });
  }
}
