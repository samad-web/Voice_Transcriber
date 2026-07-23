import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { parseLeadStages, statusForStage } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  stage: z.string().max(40).optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  telecallerId: z.string().uuid().optional(),
  /** Free text over the card heading, contact name and summary. */
  q: z.string().max(200).optional(),
  sort: z.enum(["activity", "created", "value", "title"]).default("activity"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const BoardQuery = z.object({
  /** Cards fetched per column. The count is always the true total. */
  perStage: z.coerce.number().int().min(1).max(200).default(50),
});

const UpdateLeadBody = z.object({
  stage: z.string().max(40).optional(),
  title: z.string().min(1).max(200).optional(),
  contactName: z.string().max(200).nullable().optional(),
  nextAction: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  valueNum: z.number().nonnegative().nullable().optional(),
  telecallerDeviceId: z.string().uuid().nullable().optional(),
});

/** Columns every lead view returns — one shape for the board and the list. */
const LEAD_COLUMNS = `
  l.id, l.title, l.stage, l.status, l.score, l.value_num, l.summary, l.next_action,
  l.notes, l.facts, l.contact_name, l.contact_number_prefix, l.contact_number_last3,
  l.call_count, l.last_activity_at, l.stage_changed_at, l.created_at,
  l.telecaller_device_id, l.last_call_id,
  COALESCE(d.telecaller_name, d.label) AS telecaller`;

/**
 * The lead pipeline (§4.2 owner console).
 *
 * Rows are written by the worker's lead projection; everything here is the
 * human side of it — reading the board, moving a card, taking a note. Stage
 * values are validated against the tenant's own organizations.lead_stages
 * rather than a CHECK constraint, so a customer can rename or add a column
 * without a migration and the API still rejects a stage that doesn't exist.
 */
@Controller("leads")
@UseGuards(AdminKeyGuard)
export class LeadsController {
  constructor(private readonly db: DbService) {}

  /** The tenant's stage list — the board's columns, in order. */
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
  async list(@Headers("x-org-id") orgHeader: string | undefined, @Query() query: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { stage, status, telecallerId, q, sort, limit, offset } = parsed.data;

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
      if (q) {
        // One param, three columns — pushed once so the placeholder numbering
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
           LEFT JOIN devices d ON d.id = l.telecaller_device_id
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
  async board(@Headers("x-org-id") orgHeader: string | undefined, @Query() query: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = BoardQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const stages = await this.stagesFor(client);

      // Rank inside each stage in one pass — a query per column would be N
      // round trips for a board that is read on every page load.
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT ${LEAD_COLUMNS},
                  row_number() OVER (PARTITION BY l.stage ORDER BY l.last_activity_at DESC) AS rn,
                  count(*)     OVER (PARTITION BY l.stage)::int AS stage_total,
                  COALESCE(sum(l.value_num) OVER (PARTITION BY l.stage), 0)::float AS stage_value
             FROM leads l
             LEFT JOIN devices d ON d.id = l.telecaller_device_id
         ) ranked
          WHERE rn <= $1
          ORDER BY rn`,
        [parsed.data.perStage],
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
      // vanish from the board entirely — surface it rather than lose it.
      const known = new Set(stages.map((s) => s.key));
      const orphans = rows.filter((r) => !known.has(String(r.stage)));

      return { columns, orphaned: orphans.length, stages };
    });
  }

  /** Detail: the lead plus every call from that contact. */
  @Get(":id")
  async detail(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) leadId: string,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [lead],
      } = await client.query(
        `SELECT ${LEAD_COLUMNS}, l.workspace_id, l.contact_number_hash, l.first_call_id,
                l.agent_id, l.agent_version
           FROM leads l
           LEFT JOIN devices d ON d.id = l.telecaller_device_id
          WHERE l.id = $1`,
        [leadId],
      );
      if (!lead) throw new NotFoundException("lead not found");

      // Calls reached through the contact hash, so the history survives the
      // lead being re-derived — plus the originating call when there is no
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
    @Param("id", ParseUUIDPipe) leadId: string,
    @Body() body: unknown,
  ) {
    const orgId = orgIdFromHeader(req.headers["x-org-id"]);
    const parsed = UpdateLeadBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");
    const actorId = req.principal?.userId ?? "unknown";

    return this.db.withOrg(orgId, async (client) => {
      const stages = await this.stagesFor(client);
      if (p.stage && !stages.some((s) => s.key === p.stage)) {
        throw new BadRequestException(
          `unknown stage "${p.stage}" — valid stages: ${stages.map((s) => s.key).join(", ")}`,
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
           -- Working a lead IS activity: without this a card the owner is
           -- actively progressing would age out of the retention sweep.
           last_activity_at = now()
         WHERE id = $1
         RETURNING id, stage, status, title, value_num, next_action, notes, contact_name,
                   telecaller_device_id, stage_changed_at, last_activity_at`,
        [
          leadId,
          p.stage ?? null,
          status,
          p.title ?? null,
          // A nullable field needs "was it sent?" separate from "is it null?" —
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
        ],
      );
      if (!lead) throw new NotFoundException("lead not found");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, $3, 'lead', $4, $5::jsonb)`,
        [orgId, actorId, p.stage ? "lead.stage_change" : "lead.update", leadId, JSON.stringify(p)],
      );

      return { lead };
    });
  }
}
