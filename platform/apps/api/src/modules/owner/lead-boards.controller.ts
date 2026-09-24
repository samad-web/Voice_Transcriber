import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { leadBoardStages, listLeadBoards } from "@aura/db";
import {
  LeadBoardChannel,
  LeadBoardName,
  LeadStages,
  stageOnBoard,
  statusForStage,
  type LeadStages as LeadStageList,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";

/** `main` for the org's original board, else a lead_boards id. */
const BoardRef = z.union([z.string().uuid(), z.literal("main")]);
const boardIdOf = (ref: z.infer<typeof BoardRef>): string | null => (ref === "main" ? null : ref);

const CreateBoardBody = z.object({
  name: LeadBoardName,
  /** Omitted: a copy of the Main board's columns, which is what most new boards start as. */
  stages: LeadStages.optional(),
});

const UpdateBoardBody = z
  .object({ name: LeadBoardName.optional(), stages: LeadStages.optional() })
  .refine((b) => b.name !== undefined || b.stages !== undefined, "nothing to update");

const DeleteBoardQuery = z.object({ moveTo: BoardRef });

const RoutesBody = z.object({
  routes: z
    .array(
      z.object({
        channel: LeadBoardChannel,
        /** A messaging_channels id (WhatsApp) or lead_sources id (web form); null is the whole channel. */
        sourceId: z.string().uuid().nullable(),
        /** null is the Main board, stated explicitly - see 0136's routes header. */
        boardId: z.string().uuid().nullable(),
      }),
    )
    .max(500),
});

type Client = { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

/** Postgres unique_violation. */
const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "23505";

/**
 * Lead boards (migration 0136): more than one board, and which channel feeds
 * which.
 *
 * The Main board is the org's original one - `organizations.lead_stages`, and
 * the leads with `board_id IS NULL`. It can be renamed and reshaped here but
 * never deleted: every writer that has never heard of boards lands its leads
 * on it, so it is the one board that must always exist.
 *
 * ── PERMISSIONS ─────────────────────────────────────────────────────────────
 *
 * Reading boards is `lead:view` - anyone who sees the board sees its tabs.
 * Making, reshaping, routing and deleting them are `lead_board:create|edit|
 * delete`, cells on the Team & permissions grid that 0136 grants to the admin
 * roles only. Scope is always `all`: a board is not a record anybody owns.
 */
@Controller("lead-boards")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class LeadBoardsController {
  constructor(private readonly db: DbService) {}

  /**
   * Every board with its columns and how many leads sit in each - the stage
   * editor needs the counts to refuse removing a column that still holds
   * cards - plus what this person may do, so the console only offers what the
   * API will accept.
   */
  @Get()
  @RequireCrmPermission("lead", "view")
  async list(@Req() req: PrincipalRequest, @OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const boards = await listLeadBoards(client, orgId);
      const { rows: counts } = await client.query<{ board_id: string | null; stage: string; n: number }>(
        "SELECT board_id, stage, count(*)::int AS n FROM leads GROUP BY board_id, stage",
      );
      const can = await this.grantsFor(client, orgId, req.principal?.userId);

      return {
        boards: boards.map((b) => {
          const stageCounts: Record<string, number> = {};
          for (const c of counts) if (c.board_id === b.id) stageCounts[c.stage] = c.n;
          return {
            id: b.id,
            name: b.name,
            stages: b.stages,
            counts: stageCounts,
            leadCount: Object.values(stageCounts).reduce((sum, n) => sum + n, 0),
          };
        }),
        can,
      };
    });
  }

  @Post()
  @RequireCrmPermission("lead_board", "create")
  async create(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreateBoardBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name, stages } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const columns = stages ?? (await leadBoardStages(client, orgId, null))?.stages;
      if (!columns) throw new NotFoundException("organization not found");
      try {
        const {
          rows: [board],
        } = await client.query<{ id: string }>(
          `INSERT INTO lead_boards (org_id, name, stages, sort_order, created_by)
           VALUES ($1, $2, $3::jsonb,
                   (SELECT COALESCE(max(sort_order), 0) + 1 FROM lead_boards WHERE org_id = $1),
                   (SELECT u.id FROM users u WHERE u.id = $4::uuid))
           RETURNING id`,
          [orgId, name, JSON.stringify(columns), uuidOrNull(req.principal?.userId)],
        );
        await this.audit(client, orgId, req, "lead_board.create", board.id, { name });
        return { board: { id: board.id, name, stages: columns } };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictException(`there is already a board called "${name}"`);
        throw err;
      }
    });
  }

  /**
   * Rename a board and/or replace its columns.
   *
   * The same guarantees as the deal board's "Manage board": this never moves
   * a card. A column that still holds leads cannot be removed (409 naming how
   * many), existing columns keep their key, and a column's Won/Lost marker
   * cannot change - a lead's status is set when it moves INTO a column, so
   * re-marking one would leave the leads already in it counted wrongly.
   */
  @Patch(":ref")
  @RequireCrmPermission("lead_board", "edit")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("ref") refParam: string,
    @Body() body: unknown,
  ) {
    const ref = BoardRef.safeParse(refParam);
    if (!ref.success) throw new BadRequestException("expected a board id or \"main\"");
    const parsed = UpdateBoardBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name, stages } = parsed.data;
    const boardId = boardIdOf(ref.data);

    return this.db.withOrg(orgId, async (client) => {
      const current = await leadBoardStages(client, orgId, boardId);
      if (!current) throw new NotFoundException("no such lead board");

      if (stages) await this.assertStagesSafe(client, boardId, current.stages, stages);

      try {
        if (boardId === null) {
          await client.query(
            `UPDATE organizations
                SET main_lead_board_name = CASE WHEN $2::boolean THEN $3 ELSE main_lead_board_name END,
                    lead_stages = COALESCE($4::jsonb, lead_stages)
              WHERE id = $1`,
            [orgId, name !== undefined, name ?? null, stages ? JSON.stringify(stages) : null],
          );
        } else {
          await client.query(
            `UPDATE lead_boards
                SET name = COALESCE($2, name), stages = COALESCE($3::jsonb, stages), updated_at = now()
              WHERE id = $1`,
            [boardId, name ?? null, stages ? JSON.stringify(stages) : null],
          );
        }
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictException(`there is already a board called "${name}"`);
        throw err;
      }
      await this.audit(client, orgId, req, "lead_board.update", boardId, { name, stages });
      return { board: { id: boardId, name: name ?? current.name, stages: stages ?? current.stages } };
    });
  }

  /**
   * Delete a board, moving its leads to another one first - in one
   * transaction, so a lead is never left pointing at a board that is gone
   * (`leads.board_id` is ON DELETE RESTRICT for exactly this).
   *
   * Each lead keeps its column when the destination has the same key, else
   * enters at the destination's entry column; its status follows the column.
   * The moves go into the stage ledger as `reshape` - the system, not a
   * person, so 0093's trigger does not count them as anybody answering the
   * lead. Routes to the board go with it (ON DELETE CASCADE), and those
   * sources fall back to the Main board.
   */
  @Delete(":id")
  @RequireCrmPermission("lead_board", "delete")
  async remove(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id") idParam: string,
    @Query() query: unknown,
  ) {
    if (idParam === "main") throw new BadRequestException("the Main board cannot be deleted");
    const id = z.string().uuid().safeParse(idParam);
    if (!id.success) throw new BadRequestException("expected a board id");
    const parsed = DeleteBoardQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException("say which board its leads should move to (moveTo)");
    const targetId = boardIdOf(parsed.data.moveTo);
    if (targetId === id.data) throw new BadRequestException("move the leads to a different board");

    return this.db.withOrg(orgId, async (client) => {
      const board = await leadBoardStages(client, orgId, id.data);
      if (!board) throw new NotFoundException("no such lead board");
      const target = await leadBoardStages(client, orgId, targetId);
      if (!target) throw new BadRequestException("the board to move the leads to does not exist");

      const { rows: leads } = await client.query<{ id: string; stage: string; status: string }>(
        "SELECT id, stage, status FROM leads WHERE board_id = $1 FOR UPDATE",
        [id.data],
      );
      const moved = leads.map((l) => {
        const stage = stageOnBoard(target.stages, l.stage);
        return { ...l, toStage: stage, toStatus: statusForStage(target.stages, stage) };
      });

      if (moved.length > 0) {
        // One statement for the whole board, not one per lead: a round trip to
        // the database costs ~125ms from the app, and a board can hold
        // hundreds of cards.
        await client.query(
          `UPDATE leads l
              SET board_id = $1::uuid,
                  stage = v.stage,
                  status = v.status,
                  stage_changed_at = CASE WHEN l.stage <> v.stage THEN now() ELSE l.stage_changed_at END
             FROM unnest($2::uuid[], $3::text[], $4::text[]) AS v(id, stage, status)
            WHERE l.id = v.id`,
          [targetId, moved.map((m) => m.id), moved.map((m) => m.toStage), moved.map((m) => m.toStatus)],
        );
        const changed = moved.filter((m) => m.stage !== m.toStage || m.status !== m.toStatus);
        if (changed.length > 0) {
          await client.query(
            `INSERT INTO lead_stage_transitions
               (org_id, lead_id, from_stage, to_stage, from_status, to_status, changed_by, actor_label, source)
             SELECT $1, v.lead_id, v.from_stage, v.to_stage, v.from_status, v.to_status,
                    (SELECT u.id FROM users u WHERE u.id = $2::uuid), $3, 'reshape'
               FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[])
                    AS v(lead_id, from_stage, to_stage, from_status, to_status)`,
            [
              orgId,
              uuidOrNull(req.principal?.userId),
              `board "${board.name}" deleted`,
              changed.map((m) => m.id),
              changed.map((m) => m.stage),
              changed.map((m) => m.toStage),
              changed.map((m) => m.status),
              changed.map((m) => m.toStatus),
            ],
          );
        }
      }

      await client.query("DELETE FROM lead_boards WHERE id = $1", [id.data]);
      await this.audit(client, orgId, req, "lead_board.delete", id.data, {
        name: board.name,
        movedTo: targetId ?? "main",
        leadsMoved: moved.length,
      });
      return { deleted: id.data, movedTo: targetId, leadsMoved: moved.length };
    });
  }

  /**
   * "Where do new leads go?" - every routable source with the board it feeds.
   *
   * Personal WhatsApp numbers (0125) are listed by their owner's name and
   * never by number: the number is that person's own, and the routing screen
   * is not where a colleague should learn it.
   */
  @Get("routes")
  @RequireCrmPermission("lead_board", "edit")
  async routes(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const [{ rows: whatsapp }, { rows: forms }, { rows: routes }] = [
        await client.query<{ id: string; label: string; personal: boolean; active: boolean }>(
          `SELECT mc.id,
                  CASE WHEN mc.owner_user_id IS NOT NULL
                       THEN COALESCE(u.name, u.email, 'A team member') || '''s personal WhatsApp'
                       ELSE COALESCE(NULLIF(btrim(mc.display_name), ''), mc.inbound_address)
                  END AS label,
                  mc.owner_user_id IS NOT NULL AS personal,
                  mc.status = 'active' AS active
             FROM messaging_channels mc
             LEFT JOIN users u ON u.id = mc.owner_user_id
            WHERE mc.channel = 'whatsapp'
            ORDER BY personal, label`,
        ),
        await client.query<{ id: string; label: string; active: boolean }>(
          `SELECT id, name AS label, status = 'active' AS active
             FROM lead_sources WHERE kind = 'web_form'
            ORDER BY lower(name)`,
        ),
        await client.query<{ channel: string; source_id: string | null; board_id: string | null }>(
          "SELECT channel, source_id, board_id FROM lead_board_routes",
        ),
      ];
      return {
        sources: {
          whatsapp: whatsapp.map((w) => ({ id: w.id, label: w.label, active: w.active })),
          web_form: forms.map((f) => ({ id: f.id, label: f.label, active: f.active })),
        },
        routes: routes.map((r) => ({ channel: r.channel, sourceId: r.source_id, boardId: r.board_id })),
      };
    });
  }

  /**
   * Replace every route in one go - the routing table saves as a whole, so a
   * half-saved table can never leave one source pointing at two boards. A
   * source that should inherit its channel's route is simply not sent; a
   * `boardId: null` row says "the Main board" explicitly (see 0136).
   */
  @Put("routes")
  @RequireCrmPermission("lead_board", "edit")
  async saveRoutes(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = RoutesBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { routes } = parsed.data;
    for (const r of routes) {
      if (r.channel === "manual" && r.sourceId !== null) {
        throw new BadRequestException("\"Added manually\" has no sources to route separately");
      }
    }
    const seen = new Set<string>();
    for (const r of routes) {
      const key = `${r.channel}:${r.sourceId ?? "*"}`;
      if (seen.has(key)) throw new BadRequestException("each source can go to one board only");
      seen.add(key);
    }

    return this.db.withOrg(orgId, async (client) => {
      // Every board and source named must be this org's. RLS already hides
      // other tenants' rows, so a foreign id simply fails to match here - and
      // a foreign key alone would not catch it, because FK checks ignore RLS.
      const boardIds = [...new Set(routes.flatMap((r) => (r.boardId ? [r.boardId] : [])))];
      if (boardIds.length > 0) {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM lead_boards WHERE id = ANY($1::uuid[])",
          [boardIds],
        );
        if (rows.length !== boardIds.length) throw new BadRequestException("a route names a board that does not exist");
      }
      const whatsappIds = routes.filter((r) => r.channel === "whatsapp" && r.sourceId).map((r) => r.sourceId!);
      const formIds = routes.filter((r) => r.channel === "web_form" && r.sourceId).map((r) => r.sourceId!);
      const [{ rows: wa }, { rows: wf }] = [
        await client.query<{ id: string }>(
          "SELECT id FROM messaging_channels WHERE channel = 'whatsapp' AND id = ANY($1::uuid[])",
          [whatsappIds],
        ),
        await client.query<{ id: string }>(
          "SELECT id FROM lead_sources WHERE kind = 'web_form' AND id = ANY($1::uuid[])",
          [formIds],
        ),
      ];
      if (wa.length !== new Set(whatsappIds).size || wf.length !== new Set(formIds).size) {
        throw new BadRequestException("a route names a source that does not exist");
      }

      await client.query("DELETE FROM lead_board_routes WHERE org_id = $1", [orgId]);
      if (routes.length > 0) {
        await client.query(
          `INSERT INTO lead_board_routes (org_id, channel, source_id, board_id)
           SELECT $1, v.channel, v.source_id, v.board_id
             FROM unnest($2::text[], $3::uuid[], $4::uuid[]) AS v(channel, source_id, board_id)`,
          [orgId, routes.map((r) => r.channel), routes.map((r) => r.sourceId), routes.map((r) => r.boardId)],
        );
      }
      await this.audit(client, orgId, req, "lead_board.routes", null, { routes });
      return { saved: routes.length };
    });
  }

  /** Refuse a stage list that would strand leads or silently recount them. */
  private async assertStagesSafe(
    client: Client,
    boardId: string | null,
    before: LeadStageList,
    after: LeadStageList,
  ): Promise<void> {
    const keys = after.map((s) => s.key);
    if (new Set(keys).size !== keys.length) throw new BadRequestException("two columns share one key");

    for (const s of after) {
      const old = before.find((b) => b.key === s.key);
      if (old && (old.terminal ?? null) !== (s.terminal ?? null)) {
        throw new BadRequestException(`"${old.label}" cannot change whether it counts as won or lost`);
      }
    }

    const removed = before.filter((b) => !keys.includes(b.key));
    if (removed.length === 0) return;
    const { rows } = await client.query<{ stage: string; n: number }>(
      `SELECT stage, count(*)::int AS n FROM leads
        WHERE board_id IS NOT DISTINCT FROM $1::uuid AND stage = ANY($2::text[])
        GROUP BY stage`,
      [boardId, removed.map((r) => r.key)],
    );
    if (rows.length > 0) {
      const names = rows.map((r) => {
        const label = removed.find((s) => s.key === r.stage)?.label ?? r.stage;
        return `"${label}" (${r.n} lead${r.n === 1 ? "" : "s"})`;
      });
      throw new ConflictException(`move the leads out of ${names.join(", ")} before removing the column`);
    }
  }

  /**
   * What the calling person may do with boards, for the console to show only
   * the buttons that will work. Read the same way CrmPermissionsGuard reads a
   * grant - membership, role, grid, and the object's module switched on - so
   * the two cannot disagree.
   */
  private async grantsFor(client: Client, orgId: string, userId: string | undefined) {
    const none = { createLead: false, createBoard: false, editBoards: false, deleteBoards: false };
    const id = uuidOrNull(userId);
    if (!id) return none;
    const { rows } = await client.query<{ object_type: string; action: string }>(
      `SELECT DISTINCT rp.object_type, rp.action
         FROM memberships m
         JOIN organizations o ON o.id = m.org_id AND 'aura' = ANY(o.enabled_modules)
         JOIN roles r
           ON r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
         JOIN role_permissions rp ON rp.role_id = r.id
        WHERE m.user_id = $1 AND m.org_id = $2
          AND (rp.object_type = 'lead_board' OR (rp.object_type = 'lead' AND rp.action = 'create'))`,
      [id, orgId],
    );
    const has = (object: string, action: string) => rows.some((r) => r.object_type === object && r.action === action);
    return {
      createLead: has("lead", "create"),
      createBoard: has("lead_board", "create"),
      editBoards: has("lead_board", "edit"),
      deleteBoards: has("lead_board", "delete"),
    };
  }

  private async audit(
    client: Client,
    orgId: string,
    req: PrincipalRequest,
    action: string,
    targetId: string | null,
    meta: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, $6, $2, $3, 'lead_board', $4, $5::jsonb)`,
      [orgId, auditActor(req).id, action, targetId ?? "main", JSON.stringify(meta), auditActor(req).type],
    );
  }
}

function uuidOrNull(value: string | undefined | null): string | null {
  return value && z.string().uuid().safeParse(value).success ? value : null;
}
