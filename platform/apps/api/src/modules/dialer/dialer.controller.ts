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
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  BuildDialQueueInput,
  CreateDialCampaignInput,
  DialSourceFilter,
  SkipDialQueueItemInput,
  UpdateDialCampaignInput,
  type DialCampaignLive,
  type DialCampaignStatus,
  type DialCampaignView,
  type DialPreviewCounts,
} from "@aura/shared/dist/dialer";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { countVerdicts, DialerService, type Queryable, type Verdict } from "./dialer.service";

/**
 * The dialer's console side (Build docs/39 §8, migration 0159).
 *
 * Nine routes, all tenant-scoped, all behind `AdminKeyGuard, TenantGuard,
 * CrmPermissionsGuard` in that order - the admin key first, because it is what
 * establishes a principal for an operator acting on a tenant's behalf and the
 * two guards after it both read one.
 *
 * ── WHO MAY DO WHAT, AND THE ONE CELL THAT IS WIDER THAN IT SHOULD BE ──────
 *
 * `dial_campaign:view` is seeded to every console role including `viewer`:
 * a campaign is a name, a source, an order and a set of counts, and nothing in
 * these three tables is a phone number. `dial_campaign:create` goes to the
 * three admin roles only - choosing whom the business rings commits a day of
 * the floor's time.
 *
 * `dial_campaign:edit` is the awkward one. §8 maps SIX routes onto it: PATCH,
 * build, activate, pause - and `POST /dialer/queue/:id/skip`, which is an
 * AGENT passing on the record in front of them. A telecaller who cannot skip
 * cannot work a queue, so 0159 seeds `edit` to `workspace_member` too, and the
 * cost is that the same cell lets them pause the campaign. That is a flaw in
 * §8's mapping rather than in the seed; the fix is a separate
 * `dial_campaign:dial` action, and it is written down in 0159's header so the
 * next person inherits the argument rather than the surprise.
 *
 * Scope is always `all` - `dial_campaign` is in `ALL_SCOPE_ONLY_OBJECTS`, so
 * no statement in this file emits an `owned` clause and none should be added.
 * "My own campaign" means nothing: a campaign is a whole-org decision about
 * whom the business rings.
 *
 * ── NO NUMBERS LEAVE THIS FILE ──────────────────────────────────────────────
 *
 * §11 is explicit about the preview - "Counts only; never numbers" - and this
 * controller honours it structurally rather than by care: it names neither the
 * vault table nor its number column anywhere, which is exactly what the
 * number-disclosure spec in `modules/suppression` greps the source tree for,
 * so this file is absent from both of that spec's pinned lists and gaining
 * either token here fails the build. The one route that may disclose one is the
 * handset's claim, in device-dialer.controller.ts, and it is listed there by
 * name with its justification.
 */

const CAMPAIGN_COLUMNS = `c.id, c.workspace_id, c.name, c.mode, c.advance_delay_sec,
       c.source_kind, c.source_ref, c.source_filter, c.priority,
       c.max_attempts, c.retry_after_hours, c.status, c.starts_at, c.ends_at,
       c.created_by, c.created_at, c.updated_at`;

/** The same columns without the `c.` alias, for a RETURNING clause. */
const CAMPAIGN_RETURNING = CAMPAIGN_COLUMNS.replace(/c\./g, "");

export const CAMPAIGN_LIST_SQL = `SELECT ${CAMPAIGN_COLUMNS},
            COALESCE(NULLIF(btrim(u.name), ''), u.email) AS created_by_name,
            (SELECT count(*)::int FROM dial_queue_items q
              WHERE q.campaign_id = c.id AND q.state IN ('queued', 'dialed', 'locked')) AS queued_count
       FROM dial_campaigns c
       LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.created_at DESC`;

export const CAMPAIGN_ONE_SQL = `SELECT ${CAMPAIGN_COLUMNS},
            COALESCE(NULLIF(btrim(u.name), ''), u.email) AS created_by_name,
            (SELECT count(*)::int FROM dial_queue_items q
              WHERE q.campaign_id = c.id AND q.state IN ('queued', 'dialed', 'locked')) AS queued_count
       FROM dial_campaigns c
       LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = $1`;

export const DIALER_AUDIT_SQL = `INSERT INTO audit_log
       (org_id, actor_type, actor_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, $4, 'dial_campaign', $5, $6::jsonb)`;

/**
 * The supervisor's live board, in ONE statement (§8: "Supervisor rollup. One
 * query.").
 *
 * It is one query for a reason beyond elegance: this panel is polled while a
 * floor is working, at Seoul latency, and six round trips per poll is what
 * turns a live board into a stale one. Everything hangs off two CTEs over the
 * campaign's own rows, so the planner reads `dial_queue_next` and
 * `dial_attempts_campaign` once each.
 *
 * ── THE MEDIAN, NOT THE MEAN ────────────────────────────────────────────────
 *
 * `percentile_cont(0.5)`, and 0144 settled why: one forty-minute call drags a
 * mean far enough to make a good agent look idle, and telling those two apart
 * is the entire purpose of a peer column. The per-agent handle time is still a
 * mean of that agent's own calls - that is their number, not a comparison -
 * but the line they are compared AGAINST is the median of the floor.
 */
export const CAMPAIGN_LIVE_SQL = `WITH items AS (
       SELECT q.id, q.assigned_user_id, q.state, q.position
         FROM dial_queue_items q WHERE q.campaign_id = $1
     ),
     att AS (
       SELECT a.id, a.queue_item_id, a.result, a.duration_sec, a.call_id,
              a.link_ambiguous_at, a.dialed_at
         FROM dial_attempts a WHERE a.campaign_id = $1
     ),
     by_state AS (
       SELECT i.state, count(*)::int AS n FROM items i GROUP BY i.state
     ),
     agents AS (
       SELECT i.assigned_user_id AS user_id,
              COALESCE(NULLIF(btrim(u.name), ''), u.email) AS name,
              min(i.position) FILTER (WHERE i.state IN ('queued', 'dialed')) AS position,
              count(DISTINCT a.id)::int AS attempts,
              count(DISTINCT a.id) FILTER (WHERE a.result = 'connected')::int AS connects,
              avg(a.duration_sec) FILTER (WHERE a.result = 'connected') AS avg_handle_sec,
              -- The agent's CURRENT state is the most active one they hold:
              -- a phone mid-call (locked) outranks a queue they have not
              -- reached yet. An arbitrary pick here would make the board
              -- flicker between two true answers.
              (array_agg(i.state ORDER BY CASE i.state
                 WHEN 'locked' THEN 0 WHEN 'dialed' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END))[1] AS state
         FROM items i
         LEFT JOIN users u ON u.id = i.assigned_user_id
         LEFT JOIN att a ON a.queue_item_id = i.id
        GROUP BY i.assigned_user_id, u.name, u.email
     ),
     rates AS (
       SELECT CASE WHEN attempts > 0 THEN connects::numeric / attempts END AS rate,
              avg_handle_sec
         FROM agents
     )
     SELECT c.status,
            (SELECT count(*)::int FROM items) AS total,
            COALESCE((SELECT jsonb_object_agg(state, n) FROM by_state), '{}'::jsonb) AS by_state,
            (SELECT count(*)::int FROM att) AS attempts,
            (SELECT count(*)::int FROM att WHERE result = 'connected') AS connects,
            (SELECT count(*)::int FROM att WHERE link_ambiguous_at IS NOT NULL) AS ambiguous_links,
            (SELECT count(*)::int FROM att
              WHERE call_id IS NULL AND link_ambiguous_at IS NULL
                AND dialed_at > now() - interval '24 hours') AS pending_links,
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY rate) FROM rates WHERE rate IS NOT NULL)
              AS median_connect_rate,
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY avg_handle_sec)
               FROM rates WHERE avg_handle_sec IS NOT NULL) AS median_handle_sec,
            COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.position NULLS LAST) FROM agents a), '[]'::jsonb)
              AS agents
       FROM dial_campaigns c
      WHERE c.id = $1`;

interface CampaignRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  name: string;
  mode: string;
  advance_delay_sec: number;
  source_kind: string;
  source_ref: string | null;
  source_filter: unknown;
  priority: string;
  max_attempts: number;
  retry_after_hours: number;
  status: string;
  starts_at: Date | null;
  ends_at: Date | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  queued_count: number | null;
}

function campaignView(row: CampaignRow): DialCampaignView {
  const filter = DialSourceFilter.safeParse(row.source_filter);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    mode: row.mode as DialCampaignView["mode"],
    advanceDelaySec: Number(row.advance_delay_sec),
    sourceKind: row.source_kind as DialCampaignView["sourceKind"],
    sourceRef: row.source_ref,
    // A stored filter that no longer parses is shown as empty rather than
    // half-rendered: the console must not display a narrower selection than
    // the builder would actually use.
    sourceFilter: filter.success ? filter.data : {},
    priority: row.priority as DialCampaignView["priority"],
    maxAttempts: Number(row.max_attempts),
    retryAfterHours: Number(row.retry_after_hours),
    status: row.status as DialCampaignStatus,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    queuedCount: Number(row.queued_count ?? 0),
  };
}

@Controller("dialer")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class DialerController {
  constructor(
    private readonly db: DbService,
    private readonly dialer: DialerService,
  ) {}

  @Get("campaigns")
  @RequireCrmPermission("dial_campaign", "view")
  async list(@OrgId() orgId: string): Promise<{ campaigns: DialCampaignView[] }> {
    const rows = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<CampaignRow>(CAMPAIGN_LIST_SQL);
      return rows;
    });
    return { campaigns: rows.map(campaignView) };
  }

  /**
   * A new campaign, always as a DRAFT.
   *
   * `status` is deliberately not in `CreateDialCampaignInput`: a campaign that
   * could be created already active would start dialling before anybody had
   * looked at the preview, which is the one screen this whole feature is
   * built around. Activation is its own route and its own audit row.
   */
  @Post("campaigns")
  @RequireCrmPermission("dial_campaign", "create")
  async create(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Body() body: unknown,
  ): Promise<{ campaign: DialCampaignView }> {
    const parsed = CreateDialCampaignInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    assertSourceRef(input.sourceKind, input.sourceRef ?? null);
    assertWindow(input.startsAt ?? null, input.endsAt ?? null);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      // The workspace is checked rather than trusted. RLS keeps the insert
      // inside the org, but `workspaces` and `leads` are both org-scoped and a
      // campaign pointed at another workspace's id would build an empty queue
      // and look like a broken filter.
      const {
        rows: [ws],
      } = await client.query<{ id: string }>(`SELECT id FROM workspaces WHERE id = $1`, [
        input.workspaceId,
      ]);
      if (!ws) throw new NotFoundException({ code: "workspace_not_found", message: "Workspace not found." });

      const {
        rows: [row],
      } = await client.query<CampaignRow>(
        `INSERT INTO dial_campaigns
           (org_id, workspace_id, name, mode, advance_delay_sec, source_kind, source_ref,
            source_filter, priority, max_attempts, retry_after_hours, starts_at, ends_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)
         RETURNING ${CAMPAIGN_RETURNING}, NULL::text AS created_by_name, 0 AS queued_count`,
        [
          orgId,
          input.workspaceId,
          input.name,
          input.mode,
          input.advanceDelaySec,
          input.sourceKind,
          input.sourceRef ?? null,
          JSON.stringify(input.sourceFilter),
          input.priority,
          input.maxAttempts,
          input.retryAfterHours,
          input.startsAt ?? null,
          input.endsAt ?? null,
          // A real person or nobody: the bare admin key has no `users` row and
          // 0159's FK would refuse the literal "admin-key".
          actor.type === "user" ? actor.id : null,
        ],
      );

      await client.query(DIALER_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "dial_campaign.created",
        row.id,
        JSON.stringify({ name: input.name, sourceKind: input.sourceKind, mode: input.mode }),
      ]);

      return { campaign: campaignView(row) };
    });
  }

  /**
   * Change a campaign.
   *
   * `UpdateDialCampaignInput` is HAND-BUILT - see its own comment. A
   * `.partial()` of the create schema would keep `.default()`, so a PATCH that
   * only renamed the campaign would also rewrite `mode` to `preview` and put a
   * progressive floor back into manual dialling with nothing in the audit row
   * to say why. One live instance of that bug already exists in outreach
   * cadences and §8 flags it again for this exact route.
   *
   * Every column is COALESCEd against the stored row, which is the other half
   * of the same discipline: an omitted field has to be genuinely omitted all
   * the way down to the statement.
   */
  @Patch("campaigns/:id")
  @RequireCrmPermission("dial_campaign", "edit")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<{ campaign: DialCampaignView }> {
    const parsed = UpdateDialCampaignInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const before = await readCampaign(client, id);
      if (!before) throw new NotFoundException("campaign not found");

      const sourceKind = patch.sourceKind ?? (before.source_kind as "saved_view" | "board" | "filter");
      const sourceRef = patch.sourceRef === undefined ? before.source_ref : patch.sourceRef;
      assertSourceRef(sourceKind, sourceRef);
      assertWindow(
        patch.startsAt === undefined ? toIso(before.starts_at) : patch.startsAt,
        patch.endsAt === undefined ? toIso(before.ends_at) : patch.endsAt,
      );

      const {
        rows: [row],
      } = await client.query<CampaignRow>(
        `UPDATE dial_campaigns
            SET name              = COALESCE($2, name),
                mode              = COALESCE($3, mode),
                advance_delay_sec = COALESCE($4, advance_delay_sec),
                source_kind       = COALESCE($5, source_kind),
                -- sourceRef and the two instants are NULLABLE fields, so
                -- COALESCE cannot tell "clear it" from "leave it". The sentinel
                -- is a separate boolean per field, decided in TypeScript where
                -- undefined and null are still distinguishable.
                source_ref        = CASE WHEN $6 THEN $7::uuid ELSE source_ref END,
                source_filter     = COALESCE($8::jsonb, source_filter),
                priority          = COALESCE($9, priority),
                max_attempts      = COALESCE($10, max_attempts),
                retry_after_hours = COALESCE($11, retry_after_hours),
                starts_at         = CASE WHEN $12 THEN $13::timestamptz ELSE starts_at END,
                ends_at           = CASE WHEN $14 THEN $15::timestamptz ELSE ends_at END
          WHERE id = $1
          RETURNING ${CAMPAIGN_RETURNING},
                    NULL::text AS created_by_name, 0 AS queued_count`,
        [
          id,
          patch.name ?? null,
          patch.mode ?? null,
          patch.advanceDelaySec ?? null,
          patch.sourceKind ?? null,
          patch.sourceRef !== undefined,
          patch.sourceRef ?? null,
          patch.sourceFilter ? JSON.stringify(patch.sourceFilter) : null,
          patch.priority ?? null,
          patch.maxAttempts ?? null,
          patch.retryAfterHours ?? null,
          patch.startsAt !== undefined,
          patch.startsAt ?? null,
          patch.endsAt !== undefined,
          patch.endsAt ?? null,
        ],
      );
      if (!row) throw new NotFoundException("campaign not found");

      await client.query(DIALER_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "dial_campaign.updated",
        id,
        // The keys the caller actually sent, so an audit reader can tell a
        // rename from a mode change without diffing two snapshots.
        JSON.stringify({ changed: Object.keys(patch), previousMode: before.mode }),
      ]);

      const full = await readCampaign(client, id);
      return { campaign: campaignView(full ?? row) };
    });
  }

  /**
   * The preview panel (§11): "6,003 selected · 4,812 dialable · 902 no number".
   *
   * A POST although it writes nothing, because it is the campaign's source
   * being evaluated and a GET would have to carry a filter object in a query
   * string. No writes and NO NUMBERS - the response is counts, and the
   * candidate query reads the vault row's consent basis and nothing else.
   */
  @Post("campaigns/:id/preview")
  @RequireCrmPermission("dial_campaign", "view")
  async preview(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ preview: DialPreviewCounts }> {
    return this.db.withOrg(orgId, async (client) => {
      const campaign = await readCampaign(client, id);
      if (!campaign) throw new NotFoundException("campaign not found");
      const { verdicts, truncated } = await this.dialer.evaluate(
        client,
        orgId,
        toEvaluable(campaign),
        new Date(),
      );
      return { preview: countVerdicts(verdicts, truncated) };
    });
  }

  /**
   * Materialise the queue.
   *
   * ── IDEMPOTENT, AND WHAT THAT HAS TO MEAN ───────────────────────────────
   *
   * §8 says idempotent on `(campaign_id, lead_id)`, which 0159's partial
   * unique index enforces. Running build twice must not produce two items for
   * one lead, and - just as important - must not RESET the first run: an
   * `attempt_count` zeroed by a rebuild would hand the floor a queue it has
   * already worked. So the insert is `ON CONFLICT DO UPDATE` of `position`
   * alone, and only for items nobody has touched.
   *
   * ── ONLY DIALABLE RECORDS BECOME ITEMS ──────────────────────────────────
   *
   * §13's first acceptance test is that the built queue's size EQUALS the
   * preview's dialable count, exactly. That is why the blocked candidates are
   * counted and discarded here rather than inserted as `state = 'blocked'`:
   * `block_reason` exists for a record that becomes undialable AFTER it was
   * queued, which the claim discovers and writes.
   */
  @Post("campaigns/:id/build")
  @RequireCrmPermission("dial_campaign", "edit")
  async build(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<{ preview: DialPreviewCounts; inserted: number; queued: number }> {
    const parsed = BuildDialQueueInput.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const assignees = parsed.data.assignUserIds;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const campaign = await readCampaign(client, id);
      if (!campaign) throw new NotFoundException("campaign not found");
      if (campaign.status === "completed") {
        throw new ConflictException({
          code: "campaign_completed",
          message: "This campaign is finished. Make a new one rather than re-opening it.",
        });
      }

      if (assignees.length > 0) {
        // Everybody the queue is handed to has to be a live member of this
        // org, or the items are assigned to a user id no handset will ever
        // resolve to and the records silently strand.
        const { rows: members } = await client.query<{ user_id: string }>(
          `SELECT user_id FROM memberships
            WHERE org_id = $1 AND status = 'active' AND user_id = ANY($2::uuid[])`,
          [orgId, assignees],
        );
        const live = new Set(members.map((m) => m.user_id));
        const missing = assignees.filter((u) => !live.has(u));
        if (missing.length > 0) {
          throw new BadRequestException({
            code: "not_a_member",
            message: "Some of those people are not active members of this workspace.",
            missing,
          });
        }
      }

      const { verdicts, truncated } = await this.dialer.evaluate(
        client,
        orgId,
        toEvaluable(campaign),
        new Date(),
      );
      const dialable = verdicts.filter((v) => v.ok);
      const inserted = await insertQueueItems(client, orgId, id, dialable, assignees);

      const preview = countVerdicts(verdicts, truncated);

      await client.query(DIALER_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "dial_campaign.built",
        id,
        JSON.stringify({ selected: preview.selected, dialable: preview.dialable, inserted, truncated }),
      ]);

      return { preview, inserted, queued: dialable.length };
    });
  }

  /** Start dialling. Refuses a campaign with nothing in it. */
  @Post("campaigns/:id/activate")
  @RequireCrmPermission("dial_campaign", "edit")
  async activate(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ campaign: DialCampaignView }> {
    return this.setStatus(req, orgId, id, "active");
  }

  /**
   * Stop dialling.
   *
   * Leases are NOT cleared. A handset mid-call keeps its record until its 120
   * seconds run out, because yanking the row out from under an agent who is
   * talking to somebody would lose the attempt they are about to report. The
   * claim refuses a paused campaign, so no NEW record leaves the queue.
   */
  @Post("campaigns/:id/pause")
  @RequireCrmPermission("dial_campaign", "edit")
  async pause(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ campaign: DialCampaignView }> {
    return this.setStatus(req, orgId, id, "paused");
  }

  @Get("campaigns/:id/live")
  @RequireCrmPermission("dial_campaign", "view")
  async live(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ live: DialCampaignLive }> {
    const row = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<LiveRow>(CAMPAIGN_LIVE_SQL, [id]);
      return rows[0];
    });
    if (!row) throw new NotFoundException("campaign not found");
    return {
      live: {
        campaignId: id,
        status: row.status as DialCampaignStatus,
        total: Number(row.total ?? 0),
        byState: numeric(row.by_state) as DialCampaignLive["byState"],
        attempts: Number(row.attempts ?? 0),
        connects: Number(row.connects ?? 0),
        ambiguousLinks: Number(row.ambiguous_links ?? 0),
        pendingLinks: Number(row.pending_links ?? 0),
        medianConnectRate: row.median_connect_rate === null ? null : Number(row.median_connect_rate),
        medianHandleSec: row.median_handle_sec === null ? null : Number(row.median_handle_sec),
        agents: (row.agents ?? []).map((a) => ({
          userId: a.user_id,
          name: a.name,
          position: a.position === null ? null : Number(a.position),
          attempts: Number(a.attempts ?? 0),
          connects: Number(a.connects ?? 0),
          connectRate: a.attempts > 0 ? Number(a.connects) / Number(a.attempts) : null,
          avgHandleSec: a.avg_handle_sec === null ? null : Number(a.avg_handle_sec),
          state: a.state as DialCampaignLive["agents"][number]["state"],
        })),
      },
    };
  }

  /**
   * An agent passes on the record in front of them.
   *
   * The reason is required and stored in `block_reason`, which is the same
   * column `dialability()`'s verdict lands in - deliberately. A record is
   * greyed out on the agent screen with an explanation whether a machine or a
   * person decided it, and one column means the screen cannot forget to render
   * one of the two.
   *
   * A skip is terminal for this campaign. Re-queueing it would hand the record
   * straight back to the agent who just said no.
   */
  @Post("queue/:id/skip")
  @RequireCrmPermission("dial_campaign", "edit")
  async skip(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<{ skipped: true }> {
    const parsed = SkipDialQueueItemInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ campaign_id: string }>(
        `UPDATE dial_queue_items
            SET state = 'skipped',
                block_reason = $2,
                locked_until = NULL,
                locked_by_device_id = NULL
          WHERE id = $1
            AND state <> 'skipped'
          RETURNING campaign_id`,
        [id, parsed.data.reason],
      );
      if (rows.length === 0) {
        // Either it does not exist in this tenant or it is already skipped.
        // Indistinguishable on purpose: a second press of Skip is a lost
        // response, not an error worth showing an agent mid-shift.
        const { rows: exists } = await client.query<{ id: string }>(
          `SELECT id FROM dial_queue_items WHERE id = $1`,
          [id],
        );
        if (exists.length === 0) throw new NotFoundException("queue item not found");
        return;
      }
      await client.query(DIALER_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "dial_campaign.item_skipped",
        rows[0].campaign_id,
        JSON.stringify({ queueItemId: id, reason: parsed.data.reason }),
      ]);
    });
    return { skipped: true };
  }

  private async setStatus(
    req: PrincipalRequest,
    orgId: string,
    id: string,
    status: "active" | "paused",
  ): Promise<{ campaign: DialCampaignView }> {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const before = await readCampaign(client, id);
      if (!before) throw new NotFoundException("campaign not found");
      if (before.status === "completed") {
        throw new ConflictException({
          code: "campaign_completed",
          message: "This campaign is finished.",
        });
      }
      if (status === "active" && Number(before.queued_count ?? 0) === 0) {
        // An active campaign with an empty queue is a floor staring at "No
        // records" and a supervisor who thinks the dialer is broken. Building
        // is one press away and the message says so.
        throw new ConflictException({
          code: "queue_empty",
          message: "There is nothing in this queue yet. Build it first.",
        });
      }

      const {
        rows: [row],
      } = await client.query<CampaignRow>(
        `UPDATE dial_campaigns SET status = $2 WHERE id = $1
         RETURNING ${CAMPAIGN_RETURNING},
                   NULL::text AS created_by_name, 0 AS queued_count`,
        [id, status],
      );
      await client.query(DIALER_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        status === "active" ? "dial_campaign.activated" : "dial_campaign.paused",
        id,
        JSON.stringify({ previousStatus: before.status, queued: Number(before.queued_count ?? 0) }),
      ]);
      return { campaign: campaignView({ ...row, queued_count: before.queued_count }) };
    });
  }
}

interface LiveAgentRow {
  user_id: string | null;
  name: string | null;
  position: number | null;
  attempts: number;
  connects: number;
  avg_handle_sec: string | number | null;
  state: string | null;
}

interface LiveRow extends Record<string, unknown> {
  status: string;
  total: number;
  by_state: Record<string, number> | null;
  attempts: number;
  connects: number;
  ambiguous_links: number;
  pending_links: number;
  median_connect_rate: string | number | null;
  median_handle_sec: string | number | null;
  agents: LiveAgentRow[] | null;
}

function numeric(obj: Record<string, number> | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = Number(v);
  return out;
}

async function readCampaign(client: Queryable, id: string): Promise<CampaignRow | null> {
  const { rows } = await client.query<CampaignRow>(CAMPAIGN_ONE_SQL, [id]);
  return rows[0] ?? null;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toEvaluable(row: CampaignRow) {
  const filter = DialSourceFilter.safeParse(row.source_filter);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceKind: row.source_kind as "saved_view" | "board" | "filter",
    sourceRef: row.source_ref,
    sourceFilter: filter.success ? filter.data : {},
    priority: row.priority as "temperature" | "oldest" | "newest" | "value",
    maxAttempts: Number(row.max_attempts),
    retryAfterHours: Number(row.retry_after_hours),
  };
}

/**
 * `source_ref` is required for two of the three kinds and meaningless for the
 * third. The column is nullable because `filter` has nothing to point at, so
 * nothing in the schema catches a board campaign with no board - it would just
 * select every lead in the workspace, which is the most expensive possible way
 * to be wrong.
 */
function assertSourceRef(kind: string, ref: string | null): void {
  if ((kind === "saved_view" || kind === "board") && !ref) {
    throw new BadRequestException({
      code: "source_ref_required",
      message: `A ${kind === "board" ? "board" : "saved view"} campaign needs one chosen.`,
    });
  }
}

function assertWindow(startsAt: string | null, endsAt: string | null): void {
  if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new BadRequestException({
      code: "bad_window",
      message: "The campaign cannot end before it starts.",
    });
  }
}

/**
 * Write the dialable candidates as queue items.
 *
 * ── WHY `ON CONFLICT DO UPDATE` AND NOT `DO NOTHING` ───────────────────────
 *
 * A rebuild has to be able to re-ORDER an existing queue - a supervisor who
 * switches the priority from `oldest` to `temperature` and presses Build again
 * expects the floor to work hot leads first. `DO NOTHING` would leave every
 * existing item at its original position and the setting would appear to do
 * nothing.
 *
 * What it must not touch is anything the floor has earned: `attempt_count`,
 * `last_attempt_at` and a state other than `queued`. An item being worked
 * right now (`locked`) keeps its lease; one already dialled keeps its tally.
 *
 * ── ASSIGNMENT IS ROUND-ROBIN, IN THE ORDER GIVEN ──────────────────────────
 *
 * Deliberately not "by current load". A queue is built once and worked over a
 * shift, so a load-balanced split computed at build time is out of date by the
 * second record - and an agent whose list reshuffles when a colleague works
 * faster cannot plan their own hour. Even slices, decided once.
 */
async function insertQueueItems(
  client: Queryable,
  orgId: string,
  campaignId: string,
  dialable: Verdict[],
  assignees: string[],
): Promise<number> {
  if (dialable.length === 0) return 0;

  const CHUNK = 1000;
  let inserted = 0;
  for (let offset = 0; offset < dialable.length; offset += CHUNK) {
    const slice = dialable.slice(offset, offset + CHUNK);
    const values: unknown[] = [orgId, campaignId];
    const tuples = slice.map((v, i) => {
      const position = offset + i;
      const assignee = assignees.length > 0 ? assignees[position % assignees.length] : null;
      values.push(v.row.lead_id, v.row.number_key, position, assignee);
      const b = values.length;
      return `($1, $2, $${b - 3}::uuid, $${b - 2}::text, $${b - 1}::int, $${b}::uuid)`;
    });

    const { rowCount } = await client.query(
      `INSERT INTO dial_queue_items
         (org_id, campaign_id, lead_id, number_key, position, assigned_user_id)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (campaign_id, lead_id) WHERE lead_id IS NOT NULL
       DO UPDATE SET position         = EXCLUDED.position,
                     assigned_user_id = EXCLUDED.assigned_user_id
             WHERE dial_queue_items.state = 'queued'`,
      values,
    );
    inserted += rowCount ?? 0;
  }
  return inserted;
}
