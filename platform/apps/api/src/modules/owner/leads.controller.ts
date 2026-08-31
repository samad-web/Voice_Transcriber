import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { parseLeadStages, parsePipelineStages, statusForStage } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { recordStageTransition } from "../crm-objects/stage-history";

/**
 * "none" alongside a uuid, so "which leads has the detector NOT managed to
 * label?" is answerable. That list is the only way an owner finds out their
 * catalogue is missing an alias, so it has to be reachable from the UI rather
 * than being a question you can only ask in SQL.
 */
const ProjectFilter = z.union([z.string().uuid(), z.literal("none")]);

const ListQuery = z.object({
  stage: z.string().max(40).optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  telecallerId: z.string().uuid().optional(),
  projectId: ProjectFilter.optional(),
  /** Free text over the card heading, contact name and summary. */
  q: z.string().max(200).optional(),
  sort: z.enum(["activity", "created", "value", "title"]).default("activity"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const BoardQuery = z.object({
  /** Cards fetched per column. The count is always the true total. */
  perStage: z.coerce.number().int().min(1).max(200).default(50),
  /**
   * Narrow the whole board to one project. The per-column counts and subtotals
   * are computed after this filter, so a filtered board's numbers describe the
   * filtered board - a header total that silently ignored the active filter
   * would be read as the unfiltered one.
   */
  projectId: ProjectFilter.optional(),
});

const UpdateLeadBody = z.object({
  stage: z.string().max(40).optional(),
  title: z.string().min(1).max(200).optional(),
  contactName: z.string().max(200).nullable().optional(),
  nextAction: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  valueNum: z.number().nonnegative().nullable().optional(),
  telecallerDeviceId: z.string().uuid().nullable().optional(),
  /** null clears the label. Either way this becomes the owner's column. */
  projectId: z.string().uuid().nullable().optional(),
});

/** Columns every lead view returns - one shape for the board and the list. */
const LEAD_COLUMNS = `
  l.id, l.title, l.stage, l.status, l.score, l.value_num, l.summary, l.next_action,
  l.notes, l.facts, l.contact_name, l.contact_number_prefix, l.contact_number_last3,
  l.call_count, l.last_activity_at, l.stage_changed_at, l.created_at,
  l.telecaller_device_id, l.last_call_id,
  l.project_id, l.project_source,
  pr.key AS project_key, pr.name AS project_name, pr.color AS project_color,
  COALESCE(d.telecaller_name, d.label) AS telecaller`;

/**
 * The joins LEAD_COLUMNS depends on. Kept beside it rather than repeated at
 * each of the three call sites, because adding a column to the list above and
 * forgetting one of the joins below is a runtime error the typechecker cannot
 * see - generated SQL is invisible to it.
 */
const LEAD_JOINS = `
  LEFT JOIN devices d      ON d.id = l.telecaller_device_id
  LEFT JOIN crm_projects pr ON pr.id = l.project_id`;

/**
 * The lead pipeline (§4.2 owner console).
 *
 * Rows are written by the worker's lead projection; everything here is the
 * human side of it - reading the board, moving a card, taking a note. Stage
 * values are validated against the tenant's own organizations.lead_stages
 * rather than a CHECK constraint, so a customer can rename or add a column
 * without a migration and the API still rejects a stage that doesn't exist.
 */
@Controller("leads")
@UseGuards(AdminKeyGuard, TenantGuard)
export class LeadsController {
  constructor(private readonly db: DbService) {}

  /** The tenant's stage list - the board's columns, in order. */
  private async stagesFor(client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  }) {
    const {
      rows: [org],
    } = await client.query("SELECT lead_stages FROM organizations LIMIT 1");
    return parseLeadStages(org?.lead_stages);
  }

  /** List view: filtered, sorted, paginated. */
  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { stage, status, telecallerId, projectId, q, sort, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace("$?", `$${params.length}`));
      };

      if (stage) add("l.stage = $?", stage);
      if (status) add("l.status = $?", status);
      if (telecallerId) add("l.telecaller_device_id = $?", telecallerId);
      if (projectId === "none") where.push("l.project_id IS NULL");
      else if (projectId) add("l.project_id = $?", projectId);
      if (q) {
        // One param, three columns - pushed once so the placeholder numbering
        // stays in step with `params`.
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(
          `(l.title ILIKE ${p} OR l.contact_name ILIKE ${p} OR l.summary ILIKE ${p})`,
        );
      }

      const ORDER = {
        activity: "l.last_activity_at DESC",
        created: "l.created_at DESC",
        // NULLS LAST so unpriced leads sink instead of heading the list.
        value: "l.value_num DESC NULLS LAST",
        title: "l.title ASC",
      } as const;

      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${LEAD_COLUMNS}, count(*) OVER()::int AS total_count
           FROM leads l
           ${LEAD_JOINS}
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${ORDER[sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        leads: rows.map(({ total_count: _total, ...lead }) => lead),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
        stages: await this.stagesFor(client),
      };
    });
  }

  /** Board view: every column, with its true count and the top N cards. */
  @Get("board")
  async board(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = BoardQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const { perStage, projectId } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const stages = await this.stagesFor(client);

      const params: unknown[] = [perStage];
      let projectWhere = "";
      if (projectId === "none") {
        projectWhere = "WHERE l.project_id IS NULL";
      } else if (projectId) {
        params.push(projectId);
        projectWhere = `WHERE l.project_id = $${params.length}`;
      }

      // Rank inside each stage in one pass - a query per column would be N
      // round trips for a board that is read on every page load. The project
      // filter sits INSIDE the subquery so the window functions see only the
      // filtered rows and the column counts stay honest.
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT ${LEAD_COLUMNS},
                  row_number() OVER (PARTITION BY l.stage ORDER BY l.last_activity_at DESC) AS rn,
                  count(*)     OVER (PARTITION BY l.stage)::int AS stage_total,
                  COALESCE(sum(l.value_num) OVER (PARTITION BY l.stage), 0)::float AS stage_value
             FROM leads l
             ${LEAD_JOINS}
             ${projectWhere}
         ) ranked
          WHERE rn <= $1
          ORDER BY rn`,
        params,
      );

      const columns = stages.map((s) => {
        const cards = rows.filter((r) => r.stage === s.key);
        return {
          ...s,
          count: cards[0]?.stage_total ?? 0,
          value: cards[0]?.stage_value ?? 0,
          leads: cards.map(({ rn: _rn, stage_total: _t, stage_value: _v, ...lead }) => lead),
        };
      });

      // A lead sitting in a stage the tenant has since deleted would otherwise
      // vanish from the board entirely - surface it rather than lose it.
      const known = new Set(stages.map((s) => s.key));
      const orphans = rows.filter((r) => !known.has(String(r.stage)));

      return { columns, orphaned: orphans.length, stages };
    });
  }

  /** Detail: the lead plus every call from that contact. */
  @Get(":id")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) leadId: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [lead],
      } = await client.query(
        `SELECT ${LEAD_COLUMNS}, l.workspace_id, l.contact_number_hash, l.first_call_id,
                l.agent_id, l.agent_version
           FROM leads l
           ${LEAD_JOINS}
          WHERE l.id = $1`,
        [leadId],
      );
      if (!lead) throw new NotFoundException("lead not found");

      // Calls reached through the contact hash, so the history survives the
      // lead being re-derived - plus the originating call when there is no
      // number to match on.
      const { rows: calls } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
                COALESCE(d.telecaller_name, d.label) AS telecaller
           FROM calls c
           LEFT JOIN devices d ON d.id = c.device_id
          WHERE ($1::text IS NOT NULL AND c.remote_number_hash = $1)
             OR c.id = $2 OR c.id = $3
          ORDER BY c.started_at DESC
          LIMIT 50`,
        // No leadId param: an unused placeholder has no inferable type and
        // Postgres rejects the statement outright.
        [lead.contact_number_hash, lead.first_call_id, lead.last_call_id],
      );

      return { lead, calls, stages: await this.stagesFor(client) };
    });
  }

  /**
   * Move a card, or edit what the owner keeps on it.
   *
   * A stage move is the one field with a side effect: status is derived from
   * the stage's terminal marker so "won" stays true no matter what the column
   * is called, and stage_changed_at is stamped for time-in-stage reporting.
   */
  @Patch(":id")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) leadId: string,
    @Body() body: unknown,
  ) {
    const parsed = UpdateLeadBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");
    const actorId = req.principal?.userId ?? "unknown";

    return this.db.withOrg(orgId, async (client) => {
      const stages = await this.stagesFor(client);
      if (p.stage && !stages.some((s) => s.key === p.stage)) {
        throw new BadRequestException(
          `unknown stage "${p.stage}" - valid stages: ${stages.map((s) => s.key).join(", ")}`,
        );
      }
      const status = p.stage ? statusForStage(stages, p.stage) : null;

      const {
        rows: [lead],
      } = await client.query(
        `UPDATE leads SET
           stage       = COALESCE($2, stage),
           status      = COALESCE($3, status),
           -- Only restamp when the card actually changed column.
           stage_changed_at = CASE WHEN $2::text IS NOT NULL AND $2 <> stage
                                   THEN now() ELSE stage_changed_at END,
           title       = COALESCE($4, title),
           contact_name = CASE WHEN $5::boolean THEN $6 ELSE contact_name END,
           next_action = CASE WHEN $7::boolean THEN $8 ELSE next_action END,
           notes       = CASE WHEN $9::boolean THEN $10 ELSE notes END,
           value_num   = CASE WHEN $11::boolean THEN $12 ELSE value_num END,
           telecaller_device_id = CASE WHEN $13::boolean THEN $14 ELSE telecaller_device_id END,
           project_id  = CASE WHEN $15::boolean THEN $16::uuid ELSE project_id END,
           -- HUMAN-OWNS-IT: this endpoint is only ever a person, so setting
           -- the project here permanently takes the column off the detector.
           -- Clearing it to NULL counts too - "not any of these" is a
           -- judgement the next call must not silently overturn.
           project_source = CASE WHEN $15::boolean THEN 'human' ELSE project_source END,
           -- Working a lead IS activity: without this a card the owner is
           -- actively progressing would age out of the retention sweep.
           last_activity_at = now()
         WHERE id = $1
         RETURNING id, stage, status, title, value_num, next_action, notes, contact_name,
                   telecaller_device_id, project_id, project_source,
                   stage_changed_at, last_activity_at`,
        [
          leadId,
          p.stage ?? null,
          status,
          p.title ?? null,
          // A nullable field needs "was it sent?" separate from "is it null?" -
          // COALESCE alone cannot express clearing one.
          p.contactName !== undefined,
          p.contactName ?? null,
          p.nextAction !== undefined,
          p.nextAction ?? null,
          p.notes !== undefined,
          p.notes ?? null,
          p.valueNum !== undefined,
          p.valueNum ?? null,
          p.telecallerDeviceId !== undefined,
          p.telecallerDeviceId ?? null,
          p.projectId !== undefined,
          p.projectId ?? null,
        ],
      );
      if (!lead) throw new NotFoundException("lead not found");

      // Keep the dual-written deal in step, exactly as the stage move below
      // does - and under the same human-owns-it rule, so this write is the
      // one thing that CAN overwrite the detector's guess on the deal.
      if (p.projectId !== undefined) {
        await client.query(
          `UPDATE deals SET project_id = $2::uuid, project_source = 'human'
            WHERE source_lead_id = $1`,
          [leadId, p.projectId ?? null],
        );
      }

      // A6: the worker's dual-write (projectLeadToCrm) only sets a deal's
      // stage/status ONCE, on creation - a follow-up call must never move a
      // deal a human is already working. This IS that human moving it, so
      // propagating it onto the linked deal is this endpoint's job, not the
      // worker's. Own non-blocking try/catch inside - a bug here must never
      // break the lead PATCH itself.
      if (p.stage) await this.propagateStageToDeal(client, orgId, leadId, p.stage, actorUserId(req));

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, $3, 'lead', $4, $5::jsonb)`,
        [orgId, actorId, p.stage ? "lead.stage_change" : "lead.update", leadId, JSON.stringify(p)],
      );

      return { lead };
    });
  }

  /**
   * Carry a lead's stage move onto its dual-written deal (`deals.source_lead_id`),
   * including the stage-history ledger - the same write `deals.controller.ts`'s
   * own PATCH makes, so the two never disagree about what a transition row
   * means. The deal's OWN pipeline decides its status, not the lead's: the two
   * stage lists are independently configurable and only happen to start out
   * matching, so a key that doesn't exist on the deal's pipeline is a data-
   * quality signal for reconciliation, not something to guess about here.
   */
  private async propagateStageToDeal(
    client: {
      query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
    },
    orgId: string,
    leadId: string,
    newStage: string,
    actorId: string | null,
  ): Promise<void> {
    try {
      const {
        rows: [deal],
      } = await client.query<{ id: string; stage: string; status: string; pipeline_id: string }>(
        `SELECT id, stage, status, pipeline_id FROM deals WHERE source_lead_id = $1`,
        [leadId],
      );
      if (!deal) return; // no dual-written deal for this lead (yet, or ever)

      const {
        rows: [pipeline],
      } = await client.query<{ stages: unknown }>(`SELECT stages FROM deal_pipelines WHERE id = $1`, [
        deal.pipeline_id,
      ]);
      const stages = parsePipelineStages(pipeline?.stages);
      if (!stages.some((s) => s.key === newStage)) {
        console.error(
          `lead ${leadId}: cannot propagate stage "${newStage}" - not a stage on deal ${deal.id}'s pipeline`,
        );
        return;
      }
      const dealStatus = statusForStage(stages, newStage);

      await client.query(
        `UPDATE deals SET stage = $2, status = $3, stage_changed_at = now(), last_activity_at = now()
          WHERE id = $1`,
        [deal.id, newStage, dealStatus],
      );
      await recordStageTransition(client, orgId, {
        dealId: deal.id,
        fromStage: deal.stage,
        toStage: newStage,
        fromStatus: deal.status,
        toStatus: dealStatus,
        changedBy: actorId,
        source: "console",
      });
    } catch (err) {
      console.error(`lead ${leadId}: deal stage propagation error (non-blocking):`, err);
    }
  }
}

function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
