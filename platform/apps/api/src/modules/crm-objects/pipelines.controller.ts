import {
  BadRequestException,
  Body,
  ConflictException,
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
import {
  DEFAULT_PIPELINE_STAGES,
  PipelineStages,
  STAGE_PACKS,
  entryStage,
  packById,
  statusForStage,
  suggestPack,
  validatePack,
} from "@aura/shared";
import { recordStageTransition } from "./stage-history";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OperatorMayCall, OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";

const CreatePipelineBody = z.object({
  name: z.string().min(1).max(120),
  stages: PipelineStages.optional(),
  isDefault: z.boolean().default(false),
});

const UpdatePipelineBody = z.object({
  name: z.string().min(1).max(120).optional(),
  stages: PipelineStages.optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(["active", "archived"]).optional(),
  /** Days idle before an open deal is flagged stale on the board (0106). Display only. */
  staleAfterDays: z.number().int().min(1).max(365).optional(),
});

const ApplyPackBody = z.object({ packId: z.string().min(1).max(60) });

const PIPELINE_COLUMNS = `id, name, object_type, stages, is_default, status, stale_after_days,
  created_at, updated_at`;

/**
 * Deal pipelines (CRM Phase 1, E0.1) - multiple stage lists per org, the
 * multi-pipeline generalisation of organizations.lead_stages (0010). `stages`
 * is validated against PipelineStages (packages/shared), never a DB CHECK,
 * for the same reason lead_stages isn't one: renaming a board column must
 * not be a migration.
 *
 * Strangler-fig (see the Phase 1 plan): organizations.lead_stages and
 * owner/leads.controller.ts are untouched by this module.
 */
@Controller("pipelines")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@OperatorMayCall()
export class PipelinesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${PIPELINE_COLUMNS} FROM deal_pipelines ORDER BY is_default DESC, created_at ASC`,
      );
      return { pipelines: rows };
    });
  }

  @Get(":id")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [pipeline],
      } = await client.query(`SELECT ${PIPELINE_COLUMNS} FROM deal_pipelines WHERE id = $1`, [id]);
      if (!pipeline) throw new NotFoundException("pipeline not found");
      return { pipeline };
    });
  }

  @Post()
  // doc 31 §2 X8: reshaping a board changes it for everybody - the Manage board control is already owner/manager only.
  @RequireOwnerRole("owner", "manager")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreatePipelineBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // An org with no active default takes this one as its default whatever
      // the body said - the alternative is an org whose leads project nowhere
      // (doc 23, B1).
      const {
        rows: [current],
      } = await client.query<{ id: string }>(
        `SELECT id FROM deal_pipelines WHERE is_default AND status = 'active' LIMIT 1`,
      );
      const isDefault = p.isDefault || !current;

      // Exactly one default per org - migration 0104's unique index now backs
      // this - so clear the existing default before this one claims it.
      if (isDefault) {
        await client.query(`UPDATE deal_pipelines SET is_default = false WHERE is_default = true`);
      }
      try {
        const {
          rows: [pipeline],
        } = await client.query(
          `INSERT INTO deal_pipelines (org_id, name, stages, is_default)
           VALUES ($1, $2, $3::jsonb, $4)
           RETURNING ${PIPELINE_COLUMNS}`,
          [orgId, p.name, JSON.stringify(p.stages ?? DEFAULT_PIPELINE_STAGES), isDefault],
        );
        await this.audit(client, orgId, "pipeline.create", pipeline.id, req);
        return { pipeline };
      } catch (err) {
        throw defaultRace(err);
      }
    });
  }

  @Patch(":id")
  // doc 31 §2 X8: was gated only in the web action (deals/stale-actions.ts); now the API says so too.
  @RequireOwnerRole("owner", "manager")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdatePipelineBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query<{ is_default: boolean; status: string }>(
        `SELECT is_default, status FROM deal_pipelines WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!existing) throw new NotFoundException("pipeline not found");

      // The default can be REPLACED (make another one default) but never simply
      // removed. Un-defaulting or archiving the only default used to leave the
      // org with none, and every lead after that projected nowhere - silently
      // (doc 23, B1).
      if (existing.is_default && p.isDefault === false) {
        throw new ConflictException(
          "This is the default pipeline. Make another pipeline the default first.",
        );
      }
      if (existing.is_default && p.status === "archived") {
        throw new ConflictException(
          "The default pipeline cannot be archived. Make another pipeline the default first.",
        );
      }
      const willBeArchived = (p.status ?? existing.status) === "archived";
      if (p.isDefault && willBeArchived) {
        throw new ConflictException("An archived pipeline cannot be the default.");
      }

      if (p.isDefault) {
        await client.query(
          `UPDATE deal_pipelines SET is_default = false WHERE is_default = true AND id <> $1`,
          [id],
        );
      }
      try {
        const {
          rows: [pipeline],
        } = await client.query(
          `UPDATE deal_pipelines SET
             name       = COALESCE($2, name),
             stages     = COALESCE($3::jsonb, stages),
             is_default = COALESCE($4, is_default),
             status     = COALESCE($5, status),
             stale_after_days = COALESCE($6::int, stale_after_days)
           WHERE id = $1
           RETURNING ${PIPELINE_COLUMNS}`,
          [
            id,
            p.name ?? null,
            p.stages ? JSON.stringify(p.stages) : null,
            p.isDefault ?? null,
            p.status ?? null,
            p.staleAfterDays ?? null,
          ],
        );
        await this.audit(client, orgId, "pipeline.update", id, req);
        return { pipeline };
      } catch (err) {
        throw defaultRace(err);
      }
    });
  }

  /**
   * The ready-made boards, and which one suits this business.
   *
   * A GET so it costs nothing and commits to nothing - the console shows the
   * suggestion highlighted and the client picks, rather than the product
   * reshaping their board because they typed a word.
   *
   * `describe` is the free-text line the owner writes about their business.
   * Omitted, the general pack comes back highlighted, which is the board they
   * already have.
   */
  @Get("stage-packs/catalogue")
  async stagePacks(@Query("describe") describe?: string) {
    return {
      packs: STAGE_PACKS,
      suggestedId: suggestPack(describe ?? "").id,
    };
  }

  /**
   * Replace a pipeline's columns with a ready-made board.
   *
   * ── WHY THIS IS ITS OWN ROUTE AND NOT JUST PATCH WITH stages ────────────
   *
   * PATCH already accepts `stages`, so this could have been console-side: look
   * the pack up, send its stages. Two things make that wrong.
   *
   * The first is that applying a pack MOVES CARDS. Aura's stage keys are not
   * all shared between packs - a deal sitting on `qualifying` in the clinic
   * board has no such column in the general one - so replacing the stage list
   * without touching the deals silently strands every card on a column that no
   * longer exists. They vanish from the board while still counting in every
   * report. That reconciliation has to happen in the same transaction as the
   * stage change, and a console that sends two requests cannot promise it.
   *
   * The second is that a pack is a NAMED choice. `pipeline.stages_replaced`
   * with a pack id in the audit log answers "why did our board change on the
   * 14th" - a bare stage array does not.
   *
   * ── WHAT HAPPENS TO A CARD WHOSE COLUMN DISAPPEARS ──────────────────────
   *
   * It moves to the new board's ENTRY column, and the move is recorded in
   * `deal_stage_transitions` like any other. Not to won, not to lost, and not
   * deleted: the entry column is the only choice that cannot invent an outcome
   * the business did not have. It is also the visible one - a card that
   * reappears at the start of the board gets noticed and re-sorted, which is
   * the correct amount of work for a decision somebody made deliberately.
   */
  @Post(":id/apply-stage-pack")
  // doc 31 §2 X8: the personas the Deals page shows the ready-made boards to.
  // Deliberately wider than Manage board (owner/manager) - web deals/page.tsx
  // records that choice ("the ready-made boards keep the reach they had").
  @RequireOwnerRole("owner", "manager", "sales")
  async applyStagePack(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = ApplyPackBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const pack = packById(parsed.data.packId);
    if (!pack) throw new BadRequestException("no such stage pack");

    // Checked even though these are our own constants. The cost of a bad board
    // reaching a live pipeline is silent (a 0% close rate everywhere), and the
    // check is the same one a hand-edited board would face.
    const valid = validatePack(pack.stages);
    if (!valid.ok) throw new BadRequestException(valid.errors.join("; "));

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query<{ id: string }>(`SELECT id FROM deal_pipelines WHERE id = $1`, [id]);
      if (!existing) throw new NotFoundException("pipeline not found");

      const keys = valid.stages.map((s) => s.key);
      const entry = entryStage(valid.stages);

      // Cards first, so no moment exists where the stages are new and a deal
      // still points at a column that is gone. All of it is in the one withOrg
      // transaction.
      //
      // Read BEFORE the update: an `UPDATE ... RETURNING stage` hands back the
      // NEW stage, which is how this used to record every move as entry->entry.
      const { rows: stranded } = await client.query<{ id: string; stage: string; status: string }>(
        `SELECT id, stage, status FROM deals
          WHERE pipeline_id = $1 AND NOT (stage = ANY($2::text[]))
          FOR UPDATE`,
        [id, keys],
      );

      for (const deal of stranded) {
        // A closed deal keeps its outcome when the new board has a column for
        // it - moving a won deal to the entry column would reopen a sale that
        // happened. Everything else goes to the entry column, as before.
        const outcomeColumn =
          deal.status === "won" || deal.status === "lost"
            ? valid.stages.find((s) => s.terminal === deal.status)?.key
            : undefined;
        const toStage = outcomeColumn ?? entry;
        const toStatus = statusForStage(valid.stages, toStage);

        await client.query(
          `UPDATE deals SET stage = $2, status = $3, stage_changed_at = now() WHERE id = $1`,
          [deal.id, toStage, toStatus],
        );
        // Through the shared ledger writer. The hand-written INSERT this
        // replaces named two columns the table does not have (actor_type,
        // actor_id) and omitted the NOT NULL to_status, so applying a pack to
        // any pipeline with a stranded card failed and rolled back.
        await recordStageTransition(client, orgId, {
          dealId: deal.id,
          fromStage: deal.stage,
          toStage,
          fromStatus: deal.status,
          toStatus,
          changedBy: actorUuid(req),
          actorLabel: `stage pack: ${pack.id}`,
          source: "console",
        });
      }
      const moved = stranded;

      const {
        rows: [pipeline],
      } = await client.query(
        `UPDATE deal_pipelines SET name = $2, stages = $3::jsonb
          WHERE id = $1
        RETURNING ${PIPELINE_COLUMNS}`,
        [id, pack.pipelineName, JSON.stringify(valid.stages)],
      );

      await this.audit(client, orgId, `pipeline.stages_replaced:${pack.id}`, id, req);
      return { pipeline, movedDeals: moved.length };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    req: PrincipalRequest,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'deal_pipeline', $4)`,
      [orgId, auditActor(req).id, action, targetId, auditActor(req).type],
    );
  }
}

/**
 * A unique violation on `deal_pipelines_one_default` (migration 0104) means a
 * concurrent request made another pipeline the default first. That is a
 * conflict the caller can retry, not a server error.
 */
function defaultRace(err: unknown): unknown {
  if ((err as { code?: string; constraint?: string })?.code === "23505") {
    return new ConflictException("Another pipeline was made the default at the same time. Reload and try again.");
  }
  return err;
}

/** `changed_by` is a uuid FK; the admin-key path's principal id is not always one. */
function actorUuid(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
