import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { DbClient } from "@aura/db";
import {
  analyzeTranscript,
  generateAgentDraft,
  draftReply,
  qualifyWhatsAppConversation,
  type AnalyzeResult,
} from "@aura/llm";
import {
  type AgentKind,
  type ExtractionField,
  isUnmatchableDisplayName,
  MAX_AGENTS_PER_KIND,
  parseReplyDrafterConfig,
  type ReplyDrafterConfig,
  parseLeadRules,
  qualifyLead,
  scoreBand,
  StoredExtractionSchema,
  type LeadQualification,
  type LeadRules,
} from "@aura/shared";
import { orgHasModule } from "../../common/org-modules";
import { isUniqueViolation } from "../../common/pg-errors";
import { DbService } from "../../db/db.service";
import { type AgentVersionRow, summarizeAgents } from "./agent-summaries";
import { StudioBudget } from "./studio-budget";

/**
 * Everything the two AI Agent Studios do to `agents`, in one place.
 *
 * ── WHY A SERVICE ───────────────────────────────────────────────────────────
 *
 * There are two studios and they must not disagree. The operator's
 * (`agents.controller.ts`, admin key, any tenant) predates this file; the
 * tenant's own (`owner-agents.controller.ts`, owner/manager, their org only)
 * arrived with migration 0121. Each has its own request shapes and its own
 * guards, but "what does switching an agent on do to the others" has exactly
 * one answer, and it lives here. Two copies of the activation SQL is how one
 * console would start leaving two extractors running.
 *
 * ── VERSIONS ARE IMMUTABLE ──────────────────────────────────────────────────
 *
 * Unchanged since 0001: an edit inserts version N+1. `calls`, `ai_outputs` and
 * `leads` all record the version that read a call, so rewriting a version in
 * place would silently re-describe why old calls became leads.
 */

/** A version as written - the database's names, not the studio form's. */
export interface AgentWrite {
  kind: AgentKind;
  name: string;
  purpose: string;
  systemPrompt: string;
  fields: ExtractionField[];
  leadRules: LeadRules | Record<string, never>;
  config: Record<string, unknown>;
  labels: string[];
}

export interface Actor {
  userId: string;
}

export interface ExtractorTestResult extends AnalyzeResult {
  /** What `qualifyLead` would decide for this call under the rules being tested. */
  lead: LeadQualification;
}

const VERSION_COLUMNS = `id, version, kind, name, purpose, workspace_id, system_prompt, field_schema,
  lead_rules, config, labels, is_active, archived_at, created_at`;

/**
 * Whether the org has a reply drafter switched on, on a client the caller
 * already holds. The inbox thread and the call drawer ask this inside the
 * transaction that loads them, rather than opening a second one - every round
 * trip is ~125ms against the production database.
 */
export async function replyDrafterActive(client: DbClient): Promise<boolean> {
  const { rowCount } = await client.query(
    "SELECT 1 FROM agents WHERE kind = 'reply_drafter' AND is_active AND archived_at IS NULL LIMIT 1",
  );
  return (rowCount ?? 0) > 0;
}

@Injectable()
export class AgentsService {
  private readonly budget = new StudioBudget();

  constructor(private readonly db: DbService) {}

  // ── reads ────────────────────────────────────────────────────────────────

  /** Every version of every agent, newest version of each first. */
  async listVersions(
    orgId: string,
    opts: { kinds?: AgentKind[]; includeArchived?: boolean } = {},
  ): Promise<AgentVersionRow[]> {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<AgentVersionRow>(
        `SELECT ${VERSION_COLUMNS}
           FROM agents
          WHERE ($1::text[] IS NULL OR kind = ANY($1::text[]))
            AND ($2::boolean OR archived_at IS NULL)
          ORDER BY name, version DESC`,
        [opts.kinds ?? null, opts.includeArchived ?? false],
      );
      return rows;
    });
  }

  async summaries(orgId: string) {
    return summarizeAgents(await this.listVersions(orgId));
  }

  /** One agent: the requested version in full (latest by default) and every version's header. */
  async detail(orgId: string, agentId: string, version?: number) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<AgentVersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM agents WHERE id = $1 ORDER BY version DESC`,
        [agentId],
      );
      if (rows.length === 0) throw new NotFoundException("agent not found");
      const selected = version === undefined ? rows[0]! : rows.find((r) => r.version === version);
      if (!selected) throw new NotFoundException("that version of the agent does not exist");
      return {
        agent: selected,
        versions: rows.map((r) => ({
          version: r.version,
          name: r.name,
          isActive: r.is_active,
          createdAt: r.created_at,
          fieldCount: Array.isArray(r.field_schema?.fields) ? r.field_schema.fields.length : 0,
        })),
        activeVersion: rows.find((r) => r.is_active)?.version ?? null,
        archived: rows[0]!.archived_at !== null,
      };
    });
  }

  async workspaces(orgId: string): Promise<Array<{ id: string; name: string }>> {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM workspaces ORDER BY created_at",
      );
      return rows;
    });
  }

  /**
   * Recent calls an extractor can be tested against.
   *
   * Metadata only - never the transcript text. The studio is owner/manager,
   * who may hold the call log, but a tenant without the `call_intel` module
   * has not bought the right to read transcripts, and a test run returns only
   * what the extraction produced: the same facts the lead board already shows.
   */
  async callSamples(orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.started_at, c.duration_s, c.direction, c.workspace_id,
                c.remote_name, c.remote_number_prefix, c.remote_number_last3,
                COALESCE(d.telecaller_name, d.label) AS telecaller,
                char_length(t.text) AS transcript_chars
           FROM calls c
           JOIN transcripts t ON t.call_id = c.id
           LEFT JOIN devices d ON d.id = c.device_id
          WHERE t.text IS NOT NULL AND char_length(btrim(t.text)) > 40
          ORDER BY c.started_at DESC
          LIMIT 25`,
      );
      return rows;
    });
  }

  /**
   * Recent WhatsApp threads a chat qualifier can be tested against.
   *
   * The number is reduced to its last three digits and no message text is
   * returned: the picker only has to let an owner recognise a thread, and a
   * business number that doubles as somebody's own phone carries private
   * conversations the studio has no reason to list in full.
   */
  async conversationSamples(orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.peer_label, right(c.peer_address, 3) AS peer_last3, c.last_inbound_at,
                c.contact_id IS NOT NULL AS matched,
                (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count
           FROM conversations c
          WHERE c.channel = 'whatsapp' AND c.last_inbound_at IS NOT NULL
          ORDER BY c.last_inbound_at DESC
          LIMIT 25`,
      );
      return rows;
    });
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** Version 1 of a new agent. */
  async create(
    orgId: string,
    actor: Actor,
    write: AgentWrite,
    opts: { workspaceId: string | null; activate: boolean },
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const workspaceId = await this.resolveWorkspace(client, write.kind, opts.workspaceId);

      const {
        rows: [{ count }],
      } = await client.query<{ count: number }>(
        `SELECT count(DISTINCT id)::int AS count FROM agents WHERE kind = $1 AND archived_at IS NULL`,
        [write.kind],
      );
      if (count >= MAX_AGENTS_PER_KIND) {
        throw new ConflictException(
          `You already have ${MAX_AGENTS_PER_KIND} agents of this kind. Archive one you no longer use first.`,
        );
      }

      return this.guardUnique(async () => {
        if (opts.activate) await this.deactivateSiblings(client, write.kind, workspaceId);
        const {
          rows: [agent],
        } = await client.query(
          `INSERT INTO agents (org_id, workspace_id, kind, name, purpose, version, system_prompt,
                               field_schema, lead_rules, config, labels, is_active)
           VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11)
           RETURNING id, name, kind, version, is_active, created_at`,
          [
            orgId,
            workspaceId,
            write.kind,
            write.name,
            write.purpose,
            write.systemPrompt,
            JSON.stringify({ fields: write.fields }),
            JSON.stringify(write.leadRules),
            JSON.stringify(write.config),
            JSON.stringify(write.labels),
            opts.activate,
          ],
        );
        await this.audit(client, orgId, actor, "agent.create", agent.id, {
          kind: write.kind,
          activated: opts.activate,
        });
        return agent;
      });
    });
  }

  /**
   * Version N+1 of an existing agent.
   *
   * Anything the caller leaves out is carried forward from the latest version
   * - which fixes a real loss: the operator's `POST /agents/:id/versions`
   * never sent `lead_rules`, so every edit there silently reset an agent's lead
   * rules to the default.
   */
  async newVersion(
    orgId: string,
    actor: Actor,
    agentId: string,
    write: Partial<AgentWrite>,
    opts: { activate: boolean },
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [latest],
      } = await client.query<AgentVersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM agents WHERE id = $1 ORDER BY version DESC LIMIT 1`,
        [agentId],
      );
      if (!latest) throw new NotFoundException("agent not found");
      if (latest.archived_at)
        throw new ConflictException("This agent is archived and cannot be edited.");
      if (write.kind && write.kind !== latest.kind) {
        throw new BadRequestException("An agent cannot change kind. Create a new agent instead.");
      }

      return this.guardUnique(async () => {
        if (opts.activate) await this.deactivateSiblings(client, latest.kind, latest.workspace_id);
        const {
          rows: [agent],
        } = await client.query(
          `INSERT INTO agents (id, org_id, workspace_id, kind, name, purpose, version, system_prompt,
                               field_schema, lead_rules, config, labels, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING id, name, kind, version, is_active, created_at`,
          [
            agentId,
            orgId,
            latest.workspace_id,
            latest.kind,
            write.name ?? latest.name,
            write.purpose ?? latest.purpose,
            latest.version + 1,
            write.systemPrompt ?? latest.system_prompt,
            JSON.stringify(
              write.fields ? { fields: write.fields } : (latest.field_schema ?? { fields: [] }),
            ),
            JSON.stringify(write.leadRules ?? latest.lead_rules ?? {}),
            JSON.stringify(write.config ?? latest.config ?? {}),
            JSON.stringify(write.labels ?? latest.labels ?? []),
            opts.activate,
          ],
        );
        await this.audit(client, orgId, actor, "agent.new_version", agentId, {
          version: agent.version,
          activated: opts.activate,
        });
        return agent;
      });
    });
  }

  /** Switch one version on, and whatever else of its kind was running off. */
  async activate(orgId: string, actor: Actor, agentId: string, version: number) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [target],
      } = await client.query<Pick<AgentVersionRow, "kind" | "workspace_id" | "archived_at">>(
        "SELECT kind, workspace_id, archived_at FROM agents WHERE id = $1 AND version = $2",
        [agentId, version],
      );
      if (!target) throw new NotFoundException("agent version not found");
      if (target.archived_at)
        throw new ConflictException("This agent is archived. Restore it before switching it on.");

      return this.guardUnique(async () => {
        await this.deactivateSiblings(client, target.kind, target.workspace_id);
        const {
          rows: [agent],
        } = await client.query(
          `UPDATE agents SET is_active = true WHERE id = $1 AND version = $2
           RETURNING id, name, kind, version, is_active`,
          [agentId, version],
        );
        await this.audit(client, orgId, actor, "agent.activate", agentId, { version });
        return agent;
      });
    });
  }

  /** Switch every version of one agent off. The rows stay. */
  async deactivate(orgId: string, actor: Actor, agentId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query("SELECT 1 FROM agents WHERE id = $1", [agentId]);
      if (!rowCount) throw new NotFoundException("agent not found");
      await client.query("UPDATE agents SET is_active = false WHERE id = $1 AND is_active", [
        agentId,
      ]);
      await this.audit(client, orgId, actor, "agent.deactivate", agentId, {});
      return { id: agentId, isActive: false };
    });
  }

  /**
   * Hide an agent from the studio and switch it off - never delete it.
   * Migration 0121 explains why: calls and leads name the version that read
   * them, with no foreign key to notice a deletion.
   */
  async archive(orgId: string, actor: Actor, agentId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        "UPDATE agents SET is_active = false, archived_at = COALESCE(archived_at, now()) WHERE id = $1",
        [agentId],
      );
      if (!rowCount) throw new NotFoundException("agent not found");
      await this.audit(client, orgId, actor, "agent.archive", agentId, {});
      return { id: agentId, archived: true };
    });
  }

  // ── AI runs ──────────────────────────────────────────────────────────────

  /**
   * Draft a definition from a description. Never persists - the author reviews
   * the draft in the editor and saves it through `create`/`newVersion`.
   */
  async draft(
    orgId: string,
    input: { kind: AgentKind; description: string; baseAgentId?: string; baseVersion?: number },
  ) {
    const base = input.baseAgentId
      ? await this.db.withOrg(orgId, async (client) => {
          const {
            rows: [agent],
          } = await client.query<AgentVersionRow>(
            input.baseVersion
              ? `SELECT ${VERSION_COLUMNS} FROM agents WHERE id = $1 AND version = $2`
              : `SELECT ${VERSION_COLUMNS} FROM agents WHERE id = $1 ORDER BY version DESC LIMIT 1`,
            input.baseVersion ? [input.baseAgentId, input.baseVersion] : [input.baseAgentId],
          );
          if (!agent) throw new NotFoundException("base agent not found");
          return {
            name: agent.name,
            systemPrompt: agent.system_prompt,
            fields: StoredExtractionSchema.parse(agent.field_schema ?? { fields: [] }).fields,
          };
        })
      : undefined;

    this.spend(orgId);
    return this.callProvider(() =>
      generateAgentDraft({ description: input.description, base, kind: input.kind }),
    );
  }

  /**
   * Run an extractor definition over a stored call without saving anything,
   * and say whether the call would have become a lead.
   *
   * The definition is passed in whole rather than by id, so the studio can
   * test what is on the screen BEFORE it is saved - the question an owner
   * actually has is "if I save this, what happens", not "what did v3 do".
   * The organisation's vocabulary is included, exactly as the pipeline
   * includes it; the operator's old test route left it out, so a test could
   * disagree with production on every brand name.
   */
  async testExtractor(
    orgId: string,
    input: {
      systemPrompt: string;
      fields: ExtractionField[];
      leadRules: LeadRules | Record<string, unknown>;
      callId: string;
    },
  ): Promise<ExtractorTestResult> {
    const { text, vocabulary } = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [transcript],
      } = await client.query<{ text: string | null }>(
        "SELECT text FROM transcripts WHERE call_id = $1",
        [input.callId],
      );
      if (!transcript?.text)
        throw new NotFoundException("That call has no transcript to test against.");
      const {
        rows: [org],
      } = await client.query<{ vocabulary: string[] | null }>(
        "SELECT vocabulary FROM organizations WHERE id = $1",
        [orgId],
      );
      return { text: transcript.text, vocabulary: org?.vocabulary ?? null };
    });

    this.spend(orgId);
    const result = await this.callProvider(() =>
      analyzeTranscript(input.systemPrompt, { fields: input.fields }, text, vocabulary),
    );
    await this.meter(orgId, input.callId, result.tokensIn, result.tokensOut);

    return {
      ...result,
      lead: qualifyLead(result.output, result.validationStatus, parseLeadRules(input.leadRules)),
    };
  }

  /**
   * Run a chat qualifier definition over one real WhatsApp thread, saving
   * nothing - the same qualifier function the sweep calls, so a test answers
   * exactly what the queue would have shown.
   *
   * ── REFUSED WHILE QUALIFICATION IS OFF ──────────────────────────────────────
   *
   * `whatsapp_qualification_enabled` (0080/0082) is the operator's switch for
   * sending a tenant's customer conversations to an AI provider at all. A test
   * run sends one, so it is subject to the same switch: an owner cannot route
   * around a "no" by pressing Test.
   */
  async testQualifier(
    orgId: string,
    input: { instructions: string; fields: ExtractionField[]; conversationId: string },
  ) {
    const { orgName, messages } = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query<{ name: string | null; whatsapp_qualification_enabled: boolean }>(
        "SELECT name, whatsapp_qualification_enabled FROM organizations WHERE id = $1",
        [orgId],
      );
      if (!org?.whatsapp_qualification_enabled) {
        throw new ConflictException(
          "WhatsApp qualification is switched off for your workspace, so conversations cannot be sent to the AI - not even for a test. Your platform provider can switch it on.",
        );
      }
      const { rowCount } = await client.query(
        "SELECT 1 FROM conversations WHERE id = $1 AND channel = 'whatsapp'",
        [input.conversationId],
      );
      if (!rowCount) throw new NotFoundException("That WhatsApp conversation was not found.");
      const { rows } = await client.query<{
        direction: "incoming" | "outgoing";
        body: string | null;
        occurred_at: Date | null;
      }>(
        `SELECT direction, body, occurred_at FROM conversation_messages
          WHERE conversation_id = $1 ORDER BY occurred_at ASC, id ASC`,
        [input.conversationId],
      );
      return {
        orgName: org.name,
        messages: rows.map((r) => ({
          direction: r.direction,
          body: r.body,
          occurredAt: r.occurred_at,
        })),
      };
    });

    this.spend(orgId);
    const result = await this.callProvider(() =>
      qualifyWhatsAppConversation(messages, orgName, {
        instructions: input.instructions,
        fields: input.fields,
      }),
    );
    await this.meter(orgId, input.conversationId, result.tokensIn, result.tokensOut);
    return { ...result, band: scoreBand(result.verdict.score, result.verdict.disposition) };
  }

  /**
   * Is a reply drafter switched on? Read by the inbox thread and the call
   * drawer to decide whether to offer "Draft reply" at all - a button that
   * only ever answers "no drafter" is worse than no button.
   */
  async replyDrafterActive(orgId: string): Promise<boolean> {
    return this.db.withOrg(orgId, (client) => replyDrafterActive(client));
  }

  /**
   * Draft a reply for a person to edit and send. Stores nothing, sends nothing.
   *
   * `definition` is the studio's unsaved agent under test; without it the
   * org's switched-on drafter is used, which is what the inbox and call drawer
   * do. The CALLER has already decided the person may see the source - the
   * conversation route applies record scope, the call route owner/manager and
   * `call_intel` - so this method only resolves what it is told to.
   */
  async draftReply(
    orgId: string,
    input: {
      source: { callId: string } | { conversationId: string };
      definition?: { instructions: string; config: ReplyDrafterConfig };
      /**
       * Set by a caller that has NOT already checked transcript access - the
       * studio's test run. A draft from a call recaps the transcript, so the
       * reader needs the `call_intel` module and their own `recordings_listen`,
       * exactly as the call drawer's route requires before calling this.
       */
      transcriptReaderUserId?: string;
    },
  ) {
    const loaded = await this.db.withOrg(orgId, async (client) => {
      if ("callId" in input.source && input.transcriptReaderUserId !== undefined) {
        if (!(await orgHasModule(client, "call_intel"))) {
          throw new ForbiddenException(
            "Drafting from a call needs call intelligence, which is not enabled for this instance.",
          );
        }
        const {
          rows: [membership],
        } = await client.query<{ recordings_listen: boolean }>(
          "SELECT recordings_listen FROM memberships WHERE user_id = $1 AND org_id = $2 LIMIT 1",
          [input.transcriptReaderUserId, orgId],
        );
        if (membership?.recordings_listen !== true) {
          throw new ForbiddenException(
            "Drafting from a call needs permission to read call transcripts. Test with a WhatsApp conversation instead, or ask the owner for that permission.",
          );
        }
      }
      let agent = input.definition;
      if (!agent) {
        const {
          rows: [row],
        } = await client.query<{ system_prompt: string; config: unknown }>(
          `SELECT system_prompt, config FROM agents
            WHERE kind = 'reply_drafter' AND is_active AND archived_at IS NULL LIMIT 1`,
        );
        if (!row) {
          throw new NotFoundException(
            "No reply drafter is switched on. An owner or manager can set one up in the AI Agent Studio.",
          );
        }
        agent = { instructions: row.system_prompt, config: parseReplyDrafterConfig(row.config) };
      }

      const {
        rows: [org],
      } = await client.query<{ name: string | null; vocabulary: string[] | null }>(
        "SELECT name, vocabulary FROM organizations WHERE id = $1",
        [orgId],
      );

      if ("callId" in input.source) {
        const {
          rows: [call],
        } = await client.query<{ text: string | null; customer: string | null }>(
          `SELECT t.text, COALESCE(l.contact_name, c.remote_name) AS customer
             FROM calls c
             JOIN transcripts t ON t.call_id = c.id
             LEFT JOIN leads l ON l.id = c.lead_id
            WHERE c.id = $1`,
          [input.source.callId],
        );
        if (!call?.text?.trim())
          throw new NotFoundException("That call has no transcript to draft a reply from.");
        return {
          agent,
          org,
          customer: call.customer,
          source: { kind: "call" as const, transcript: call.text },
          refId: input.source.callId,
        };
      }

      const {
        rows: [conversation],
      } = await client.query<{ channel: string; customer: string | null }>(
        `SELECT c.channel, COALESCE(k.display_name, c.peer_label) AS customer
           FROM conversations c
           LEFT JOIN contacts k ON k.id = c.contact_id
          WHERE c.id = $1`,
        [input.source.conversationId],
      );
      if (!conversation) throw new NotFoundException("That conversation was not found.");
      const { rows } = await client.query<{
        direction: "incoming" | "outgoing";
        body: string | null;
        occurred_at: Date | null;
      }>(
        `SELECT direction, body, occurred_at FROM conversation_messages
          WHERE conversation_id = $1 ORDER BY occurred_at ASC, id ASC`,
        [input.source.conversationId],
      );
      if (!rows.some((m) => m.direction === "incoming" && m.body?.trim())) {
        throw new BadRequestException(
          "The customer has not written anything in this conversation yet.",
        );
      }
      return {
        agent,
        org,
        customer: conversation.customer,
        source: {
          kind: "conversation" as const,
          channel: conversation.channel,
          messages: rows.map((r) => ({
            direction: r.direction,
            body: r.body,
            occurredAt: r.occurred_at,
          })),
        },
        refId: input.source.conversationId,
      };
    });

    this.spend(orgId);
    const result = await this.callProvider(() =>
      draftReply({
        instructions: loaded.agent.instructions,
        config: loaded.agent.config,
        source: loaded.source,
        businessName: loaded.org?.name ?? null,
        // A placeholder name is not a name - "Unknown caller" in a greeting is
        // worse than no name at all.
        customerName: isUnmatchableDisplayName(loaded.customer) ? null : loaded.customer,
        vocabulary: loaded.org?.vocabulary ?? null,
      }),
    );
    await this.meter(orgId, loaded.refId, result.tokensIn, result.tokensOut);
    return result;
  }

  /** Load a stored version for the operator's by-id test route. */
  async storedVersion(orgId: string, agentId: string, version?: number) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [agent],
      } = await client.query<AgentVersionRow>(
        version
          ? `SELECT ${VERSION_COLUMNS} FROM agents WHERE id = $1 AND version = $2`
          : `SELECT ${VERSION_COLUMNS} FROM agents WHERE id = $1 ORDER BY version DESC LIMIT 1`,
        version ? [agentId, version] : [agentId],
      );
      if (!agent) throw new NotFoundException("agent not found");
      return agent;
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The one rule for "which agents does switching this on switch off".
   *
   * An extractor competes only with extractors in ITS workspace - the worker
   * resolves them through `calls.workspace_id`. The other kinds are org-wide
   * (0121). Scoped by kind in both cases: before 0121 this was `WHERE
   * workspace_id = $1`, which would now switch a workspace's extractor off
   * because somebody activated a reply drafter.
   */
  private async deactivateSiblings(client: DbClient, kind: AgentKind, workspaceId: string | null) {
    if (kind === "call_extractor") {
      await client.query(
        "UPDATE agents SET is_active = false WHERE workspace_id = $1 AND kind = 'call_extractor' AND is_active",
        [workspaceId],
      );
    } else {
      await client.query("UPDATE agents SET is_active = false WHERE kind = $1 AND is_active", [
        kind,
      ]);
    }
  }

  /** An extractor needs a workspace of this org; every other kind must have none. */
  private async resolveWorkspace(
    client: DbClient,
    kind: AgentKind,
    requested: string | null,
  ): Promise<string | null> {
    if (kind !== "call_extractor") return null;
    if (requested) {
      const ws = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [requested]);
      if (ws.rowCount === 0) throw new NotFoundException("workspace not found in this org");
      return requested;
    }
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM workspaces ORDER BY created_at LIMIT 2",
    );
    if (rows.length === 1) return rows[0]!.id;
    throw new BadRequestException(
      rows.length === 0
        ? "This organisation has no workspace for a call extractor to belong to."
        : "Choose which workspace's calls this extractor should read.",
    );
  }

  /**
   * The partial unique indexes (0121) are the last word on "one running agent
   * per kind". Two people switching agents on in the same instant is the only
   * way to reach them, and a sentence beats a 500.
   */
  private async guardUnique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          "Another change to these agents was saved at the same moment. Reload the page and try again.",
        );
      }
      throw err;
    }
  }

  private spend(orgId: string) {
    const waitMinutes = this.budget.take(orgId);
    if (waitMinutes !== null) {
      throw new HttpException(
        `The AI studio has reached its hourly limit for this workspace. Try again in about ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Provider failures become a sentence the console can show, not a 500. */
  private async callProvider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no analyze provider configured/i.test(message)) {
        throw new ServiceUnavailableException(
          "No AI provider is configured for this platform yet.",
        );
      }
      console.error("agent studio: provider call failed:", message);
      throw new BadGatewayException(
        "The AI provider did not return a usable answer. Try again in a moment.",
      );
    }
  }

  /**
   * Studio runs are real spend, so they are metered like the pipeline's.
   * `ref_id` is the call, which is what the pipeline uses too - a usage report
   * can tell test runs from production only by `kind`, and it does not need to.
   */
  private async meter(orgId: string, refId: string | null, tokensIn: number, tokensOut: number) {
    if (!tokensIn && !tokensOut) return;
    await this.db.withOrg(orgId, (client) =>
      client.query(
        `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
         VALUES ($1, 'llm_tokens_in', $2, 'tokens', $3), ($1, 'llm_tokens_out', $4, 'tokens', $3)`,
        [orgId, tokensIn, refId, tokensOut],
      ),
    );
  }

  private async audit(
    client: DbClient,
    orgId: string,
    actor: Actor,
    action: string,
    agentId: string,
    meta: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, 'user', $2, $3, 'agent', $4, $5)`,
      [orgId, actor.userId, action, agentId, JSON.stringify(meta)],
    );
  }
}
