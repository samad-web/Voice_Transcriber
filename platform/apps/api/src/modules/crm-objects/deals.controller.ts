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
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { entryStage, parsePipelineStages, statusForStage } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { enqueueAutomationEventSafely } from "../automation/enqueue";
import { recordStageTransition } from "./stage-history";

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

/**
 * Every deal view returns the same shape — one definition for list/board/detail.
 *
 * `expected_close_date` goes through to_char for the reason spelled out in
 * tasks.controller.ts: node-postgres turns a `date` into a local-midnight JS
 * Date, which JSON then emits as UTC, so on this platform's +05:30 host every
 * date shipped a day early. Same defect, found while building Track A3.
 */
const DEAL_COLUMNS = `d.id, d.pipeline_id, d.workspace_id, d.account_id, d.contact_id, d.name, d.stage,
  d.status, d.amount, to_char(d.expected_close_date, 'YYYY-MM-DD') AS expected_close_date,
  d.summary, d.next_action, d.notes, d.owner_user_id,
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
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
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
  @RequireCrmPermission("deal", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
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

      // The `owned` half of the permission grid. A role granted deal:view with
      // scope 'owned' sees only its own pipeline — applied here because it is a
      // predicate on rows, which no guard can express.
      const owned = scopeFilter("deal", recordScope, "d");
      if (owned) add(owned.sql, owned.value);
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
  @RequireCrmPermission("deal", "view")
  async board(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = BoardQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { pipelineId, perStage } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const pipeline = await this.resolvePipeline(client, pipelineId);

      // Rank inside each stage in one pass — a query per column would be N
      // round trips for a board that is read on every page load (same
      // reasoning as owner/leads.controller.ts's board endpoint).
      // The scoped predicate goes INSIDE the window functions, not outside:
      // stage_total and stage_value are computed by those windows, so
      // filtering after the fact would show a scoped user their own cards
      // under somebody else's column totals.
      const scoped = scopeClause("deal", recordScope, 3, "d");
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT ${DEAL_COLUMNS},
                  row_number() OVER (PARTITION BY d.stage ORDER BY d.last_activity_at DESC) AS rn,
                  count(*)     OVER (PARTITION BY d.stage)::int AS stage_total,
                  COALESCE(sum(d.amount) OVER (PARTITION BY d.stage), 0)::float AS stage_value
             ${DEAL_JOINS}
            WHERE d.pipeline_id = $1 ${scoped ? `AND ${scoped}` : ""}
         ) ranked
          WHERE rn <= $2
          ORDER BY rn`,
        scoped ? [pipeline.id, perStage, recordScope.userId] : [pipeline.id, perStage],
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
  @RequireCrmPermission("deal", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // 404, not 403, when a scoped user asks for somebody else's deal. A 403
      // would confirm the record exists, which is exactly the fact the scope
      // is meant to withhold.
      const scoped = scopeClause("deal", recordScope, 2, "d");
      const {
        rows: [deal],
      } = await client.query(
        `SELECT ${DEAL_COLUMNS} ${DEAL_JOINS} WHERE d.id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!deal) throw new NotFoundException("deal not found");
      return { deal };
    });
  }

  /**
   * How this deal got where it is (migration 0046).
   *
   * `daysInStage` is computed here rather than stored: it is the gap to the
   * NEXT transition, which is not knowable when a row is written. The final
   * row measures to now, because the deal is still sitting there.
   */
  @Get(":id/stage-history")
  @RequireCrmPermission("deal", "view")
  async stageHistory(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("deal", recordScope, 2);
      const {
        rows: [deal],
      } = await client.query<{ id: string }>(
        `SELECT id FROM deals WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!deal) throw new NotFoundException("deal not found");

      const { rows } = await client.query(
        `SELECT t.id, t.from_stage, t.to_stage, t.from_status, t.to_status, t.source,
                t.occurred_at, COALESCE(u.name, t.actor_label) AS actor,
                EXTRACT(EPOCH FROM (
                  COALESCE(lead(t.occurred_at) OVER (ORDER BY t.occurred_at), now())
                  - t.occurred_at
                )) / 86400 AS days_in_stage
           FROM deal_stage_transitions t
           LEFT JOIN users u ON u.id = t.changed_by
          WHERE t.deal_id = $1
          ORDER BY t.occurred_at`,
        [id],
      );

      return {
        transitions: rows.map((row) => ({
          ...row,
          days_in_stage:
            row.days_in_stage === null ? null : Number(Number(row.days_in_stage).toFixed(2)),
        })),
      };
    });
  }

  @Post()
  @RequireCrmPermission("deal", "create")
  async create(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
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
            amount, expected_close_date, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          // A scoped user's new deal is stamped as theirs. Without this they
          // would create a record and immediately lose sight of it, which
          // reads as "the save didn't work".
          recordScope.scope === "owned" ? recordScope.userId : null,
        ],
      );

      // The deal entering the pipeline is the first row of its history —
      // from_stage NULL. Without it a deal created directly in the console
      // would have a ledger that starts mid-story.
      await recordStageTransition(client, orgId, {
        dealId: inserted.id,
        fromStage: null,
        toStage: stage,
        fromStatus: null,
        toStatus: status,
        changedBy: actorUserId(req),
      });

      const {
        rows: [deal],
      } = await client.query(`SELECT ${DEAL_COLUMNS} ${DEAL_JOINS} WHERE d.id = $1`, [inserted.id]);

      await enqueueAutomationEventSafely(client, orgId, "deal.created", "deal", inserted.id, {
        dealId: inserted.id,
        contactId: p.contactId ?? null,
        accountId: p.accountId ?? null,
        stage,
        status,
        amount: p.amount ?? null,
        dealOwnerUserId: (deal as { owner_user_id?: string | null })?.owner_user_id ?? null,
      });

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
  @RequireCrmPermission("deal", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = UpdateDealBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      let status: string | null = null;
      let previous: { stage: string; status: string } | null = null;
      if (p.stage) {
        const {
          rows: [existing],
        } = await client.query<{ pipeline_id: string; stage: string; status: string }>(
          `SELECT pipeline_id, stage, status FROM deals WHERE id = $1${
            scopeClause("deal", recordScope, 2) ? ` AND ${scopeClause("deal", recordScope, 2)}` : ""
          }`,
          scopeClause("deal", recordScope, 2) ? [id, recordScope.userId] : [id],
        );
        if (!existing) throw new NotFoundException("deal not found");
        const pipeline = await this.resolvePipeline(client, existing.pipeline_id);
        if (!pipeline.stages.some((s) => s.key === p.stage)) {
          throw new BadRequestException(
            `unknown stage "${p.stage}" — valid stages: ${pipeline.stages.map((s) => s.key).join(", ")}`,
          );
        }
        status = statusForStage(pipeline.stages, p.stage);
        // Captured BEFORE the UPDATE — afterwards the old stage is gone, which
        // is precisely the erasure migration 0046 exists to stop.
        previous = { stage: existing.stage, status: existing.status };
      }

      // A scoped user editing somebody else's deal finds nothing to update and
      // gets the same 404 the detail route gives — no write, no disclosure.
      const scopedUpdate = scopeClause("deal", recordScope, 21);
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
         WHERE id = $1 ${scopedUpdate ? `AND ${scopedUpdate}` : ""}
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
          ...(scopedUpdate ? [recordScope.userId] : []),
        ],
      );
      if (!updated) throw new NotFoundException("deal not found");

      if (p.stage && previous) {
        // recordStageTransition drops a no-op move itself, so a drag that
        // lands a card back in its own column writes nothing.
        await recordStageTransition(client, orgId, {
          dealId: id,
          fromStage: previous.stage,
          toStage: p.stage,
          fromStatus: previous.status,
          toStatus: status ?? previous.status,
          changedBy: actorUserId(req),
        });
      }

      const {
        rows: [deal],
      } = await client.query(`SELECT ${DEAL_COLUMNS} ${DEAL_JOINS} WHERE d.id = $1`, [id]);

      // Only a stage MOVE is an event. Editing the amount or the notes is not
      // something a rule should be able to react to yet — and adding a
      // deal.updated trigger later is easy, where un-firing rules that have
      // already run on every keystroke is not.
      if (p.stage && previous && previous.stage !== p.stage) {
        const row = deal as {
          contact_id?: string | null;
          account_id?: string | null;
          amount?: string | number | null;
          owner_user_id?: string | null;
        };
        await enqueueAutomationEventSafely(client, orgId, "deal.stage_changed", "deal", id, {
          dealId: id,
          contactId: row?.contact_id ?? null,
          accountId: row?.account_id ?? null,
          stage: p.stage,
          fromStage: previous.stage,
          toStage: p.stage,
          status: status ?? previous.status,
          amount: row?.amount === null || row?.amount === undefined ? null : Number(row.amount),
          dealOwnerUserId: row?.owner_user_id ?? null,
        });
      }

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

/** Same validate-or-null the other CRM controllers need — see interactions.controller.ts. */
function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
