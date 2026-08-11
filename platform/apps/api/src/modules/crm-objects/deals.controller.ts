import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { entryStage, parsePipelineStages, statusForStage } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

type DbClient = { query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> };

const ListQuery = z.object({
  pipelineId: z.string().uuid().optional(),
  stage: z.string().max(40).optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  contactId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["activity", "created", "amount", "name"]).default("activity"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const BoardQuery = z.object({
  pipelineId: z.string().uuid().optional(),
  perStage: z.coerce.number().int().min(1).max(200).default(50),
});

const CreateDealBody = z.object({
  pipelineId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  stage: z.string().max(40).optional(),
  amount: z.number().nonnegative().optional(),
  expectedCloseDate: z.string().date().optional(),
});

const UpdateDealBody = z.object({
  stage: z.string().max(40).optional(),
  name: z.string().min(1).max(200).optional(),
  amount: z.number().nonnegative().nullable().optional(),
  expectedCloseDate: z.string().date().nullable().optional(),
  summary: z.string().max(5000).nullable().optional(),
  nextAction: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
});

/** Every deal view returns the same shape — one definition for list/board/detail. */
const DEAL_COLUMNS = `d.id, d.pipeline_id, d.workspace_id, d.account_id, d.contact_id, d.name, d.stage,
  d.status, d.amount, d.expected_close_date, d.summary, d.next_action, d.notes, d.owner_user_id,
  d.telecaller_id, d.source_lead_id, d.facts, d.call_count, d.last_activity_at, d.stage_changed_at,
  d.created_at, d.updated_at, c.display_name AS contact_name, a.name AS account_name`;

const DEAL_JOINS = `FROM deals d
  LEFT JOIN contacts c ON c.id = d.contact_id
  LEFT JOIN accounts a ON a.id = d.account_id`;

/**
 * Deals — CRM Phase 1, E0.1. The pipeline object that inherits `leads`'
 * board/stage role; `stage` is validated against the owning pipeline's
 * `stages`, exactly like owner/leads.controller.ts validates against
 * organizations.lead_stages. Strangler-fig: not linked into web nav yet.
 */
@Controller("deals")
@UseGuards(AdminKeyGuard, TenantGuard)
export class DealsController {
  constructor(private readonly db: DbService) {}

  /** Resolve a pipeline (explicit id, or the org's default) and parse its stages. */
  private async resolvePipeline(client: DbClient, pipelineId?: string) {
    const {
      rows: [pipeline],
    } = await client.query<{ id: string; stages: unknown }>(
      pipelineId
        ? `SELECT id, stages FROM deal_pipelines WHERE id = $1`
        : `SELECT id, stages FROM deal_pipelines WHERE is_default = true LIMIT 1`,
      pipelineId ? [pipelineId] : [],
    );
    if (!pipeline) {
      throw new NotFoundException(pipelineId ? "pipeline not found" : "org has no default pipeline");
    }
    return { id: pipeline.id, stages: parsePipelineStages(pipeline.stages) };
  }

  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { pipelineId, stage, status, contactId, accountId, q, sort, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace("$?", `$${params.length}`));
      };

      if (pipelineId) add("d.pipeline_id = $?", pipelineId);
      if (stage) add("d.stage = $?", stage);
      if (status) add("d.status = $?", status);
      if (contactId) add("d.contact_id = $?", contactId);
      if (accountId) add("d.account_id = $?", accountId);
      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(d.name ILIKE ${p} OR d.summary ILIKE ${p})`);
      }

      const ORDER = {
        activity: "d.last_activity_at DESC",
        created: "d.created_at DESC",
        amount: "d.amount DESC NULLS LAST",
        name: "d.name ASC",
      } as const;

      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${DEAL_COLUMNS}, count(*) OVER()::int AS total_count
           ${DEAL_JOINS}
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${ORDER[sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        deals: rows.map(({ total_count: _t, ...d }) => d),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
      };
    });
  }

  /** Board view: every column, with its true count/value and the top N cards. */
  @Get("board")
  async board(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = BoardQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { pipelineId, perStage } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const pipeline = await this.resolvePipeline(client, pipelineId);

      // Rank inside each stage in one pass — a query per column would be N
      // round trips for a board that is read on every page load (same
      // reasoning as owner/leads.controller.ts's board endpoint).
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT ${DEAL_COLUMNS},
                  row_number() OVER (PARTITION BY d.stage ORDER BY d.last_activity_at DESC) AS rn,
                  count(*)     OVER (PARTITION BY d.stage)::int AS stage_total,
                  COALESCE(sum(d.amount) OVER (PARTITION BY d.stage), 0)::float AS stage_value
             ${DEAL_JOINS}
            WHERE d.pipeline_id = $1
         ) ranked
          WHERE rn <= $2
          ORDER BY rn`,
        [pipeline.id, perStage],
      );

      const columns = pipeline.stages.map((s) => {
        const cards = rows.filter((r) => r.stage === s.key);
        return {
          ...s,
          count: cards[0]?.stage_total ?? 0,
          value: cards[0]?.stage_value ?? 0,
          deals: cards.map(({ rn: _rn, stage_total: _t, stage_value: _v, ...d }) => d),
        };
      });

      // A deal sitting in a stage the tenant has since deleted would
      // otherwise vanish from the board entirely — surface it rather than
      // lose it (same reasoning as the lead board's `orphaned` count).
      const known = new Set(pipeline.stages.map((s) => s.key));
      const orphans = rows.filter((r) => !known.has(String(r.stage)));

      return { pipelineId: pipeline.id, columns, orphaned: orphans.length, stages: pipeline.stages };
    });
  }

  @Get(":id")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [deal],
      } = await client.query(`SELECT ${DEAL_COLUMNS} ${DEAL_JOINS} WHERE d.id = $1`, [id]);
      if (!deal) throw new NotFoundException("deal not found");
      return { deal };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreateDealBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const pipeline = await this.resolvePipeline(client, p.pipelineId);

      const stage = p.stage ?? entryStage(pipeline.stages);
      if (!pipeline.stages.some((s) => s.key === stage)) {
        throw new BadRequestException(
          `unknown stage "${stage}" — valid stages: ${pipeline.stages.map((s) => s.key).join(", ")}`,
        );
      }
      const status = statusForStage(pipeline.stages, stage);

      const {
        rows: [inserted],
      } = await client.query<{ id: string }>(
        `INSERT INTO deals
           (org_id, workspace_id, pipeline_id, account_id, contact_id, name, stage, status,
            amount, expected_close_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          orgId,
          p.workspaceId ?? null,
          pipeline.id,
          p.accountId ?? null,
          p.contactId ?? null,
          p.name,
          stage,
          status,
          p.amount ?? null,
          p.expectedCloseDate ?? null,
        ],
      );

      const {
        rows: [deal],
      } = await client.query(`SELECT ${DEAL_COLUMNS} ${DEAL_JOINS} WHERE d.id = $1`, [inserted.id]);
      await this.audit(client, orgId, "deal.create", inserted.id);
      return { deal };
    });
  }

  /**
   * Move a card, or edit what's on it. A stage move is the one field with a
   * side effect: status is derived from the stage's terminal marker so "won"
   * stays true no matter what the column is called, and stage_changed_at is
   * stamped for time-in-stage reporting — same contract as
   * owner/leads.controller.ts's update handler.
   */
  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = UpdateDealBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      let status: string | null = null;
      if (p.stage) {
        const {
          rows: [existing],
        } = await client.query<{ pipeline_id: string }>(`SELECT pipeline_id FROM deals WHERE id = $1`, [id]);
        if (!existing) throw new NotFoundException("deal not found");
        const pipeline = await this.resolvePipeline(client, existing.pipeline_id);
        if (!pipeline.stages.some((s) => s.key === p.stage)) {
          throw new BadRequestException(
            `unknown stage "${p.stage}" — valid stages: ${pipeline.stages.map((s) => s.key).join(", ")}`,
          );
        }
        status = statusForStage(pipeline.stages, p.stage);
      }

      const {
        rows: [updated],
      } = await client.query<{ id: string }>(
        `UPDATE deals SET
           stage       = COALESCE($2, stage),
           status      = COALESCE($3, status),
           stage_changed_at = CASE WHEN $2::text IS NOT NULL AND $2 <> stage
                                   THEN now() ELSE stage_changed_at END,
           name        = COALESCE($4, name),
           amount      = CASE WHEN $5::boolean THEN $6 ELSE amount END,
           expected_close_date = CASE WHEN $7::boolean THEN $8::date ELSE expected_close_date END,
           summary     = CASE WHEN $9::boolean THEN $10 ELSE summary END,
           next_action = CASE WHEN $11::boolean THEN $12 ELSE next_action END,
           notes       = CASE WHEN $13::boolean THEN $14 ELSE notes END,
           contact_id  = CASE WHEN $15::boolean THEN $16 ELSE contact_id END,
           account_id  = CASE WHEN $17::boolean THEN $18 ELSE account_id END,
           owner_user_id = CASE WHEN $19::boolean THEN $20 ELSE owner_user_id END,
           last_activity_at = now()
         WHERE id = $1
         RETURNING id`,
        [
          id,
          p.stage ?? null,
          status,
          p.name ?? null,
          p.amount !== undefined,
          p.amount ?? null,
          p.expectedCloseDate !== undefined,
          p.expectedCloseDate ?? null,
          p.summary !== undefined,
          p.summary ?? null,
          p.nextAction !== undefined,
          p.nextAction ?? null,
          p.notes !== undefined,
          p.notes ?? null,
          p.contactId !== undefined,
          p.contactId ?? null,
          p.accountId !== undefined,
          p.accountId ?? null,
          p.ownerUserId !== undefined,
          p.ownerUserId ?? null,
        ],
      );
      if (!updated) throw new NotFoundException("deal not found");

      const {
        rows: [deal],
      } = await client.query(`SELECT ${DEAL_COLUMNS} ${DEAL_JOINS} WHERE d.id = $1`, [id]);
      await this.audit(client, orgId, p.stage ? "deal.stage_change" : "deal.update", id);
      return { deal };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'user', 'dev-admin', $2, 'deal', $3)`,
      [orgId, action, targetId],
    );
  }
}
