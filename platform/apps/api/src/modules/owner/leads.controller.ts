import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { leadBoardStages, listLeadBoards, recordLeadStageTransition } from "@aura/db";
import {
  BulkAssignLeadsInput,
  LeadSourceChannel,
  LeadTemperature,
  parseLeadStages,
  parsePipelineStages,
  stageOnBoard,
  statusForStage,
  type BulkResult,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { assignInBulk } from "../../common/bulk-assign";
import { consolePhone, orgPhoneCountry } from "../../common/console-phone";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { orgHasModule } from "../../common/org-modules";
import { assertInOrg } from "../../common/org-references";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OwnerScope, type OwnerRecordScope, ownerScopeFilter } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { recordStageTransition } from "../crm-objects/stage-history";
import { CrmIngestService } from "../public-api/crm-ingest.service";
import { dealStageChangedSubject, enqueueAutomationEventSafely } from "../automation/enqueue";

/**
 * "none" alongside a uuid, so "which leads has the detector NOT managed to
 * label?" is answerable. That list is the only way an owner finds out their
 * catalogue is missing an alias, so it has to be reachable from the UI rather
 * than being a question you can only ask in SQL.
 */
const ProjectFilter = z.union([z.string().uuid(), z.literal("none")]);

/** A lead board (0136): a lead_boards id, or `main` for the org's original board. */
const BoardRef = z.union([z.string().uuid(), z.literal("main")]);
const boardIdOf = (ref: z.infer<typeof BoardRef>): string | null => (ref === "main" ? null : ref);

const ListQuery = z.object({
  boardId: BoardRef.optional(),
  stage: z.string().max(40).optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  telecallerId: z.string().uuid().optional(),
  /**
   * Who the lead is ASSIGNED to (`assigned_telecaller_id`, a telecaller
   * identity) - not `telecallerId` above, which is the handset that took the
   * call. `none` is the unrouted backlog.
   */
  assignedTo: z.union([z.string().uuid(), z.literal("none")]).optional(),
  projectId: ProjectFilter.optional(),
  /**
   * "none" alongside a channel for the same reason ProjectFilter has it: the
   * leads with no recorded channel are the ones that predate migration 0078,
   * and an owner reconciling their numbers needs to be able to see them.
   */
  sourceChannel: z.union([LeadSourceChannel, z.literal("none")]).optional(),
  /**
   * Age filters, in whole days since the lead arrived - the click-through the
   * dashboard's aging tiles need (gap G3).
   *
   * Inclusive at both ends, matching the bucket definitions in
   * reports/sla.ts: "4-7 days" means minAgeDays=4&maxAgeDays=7 and no lead
   * falls between two tiles. Whole days and not hours, because that is what
   * the tile says and a filter that disagreed with the number it was reached
   * from would be worse than no filter.
   */
  minAgeDays: z.coerce.number().int().min(0).max(3650).optional(),
  maxAgeDays: z.coerce.number().int().min(0).max(3650).optional(),
  /**
   * Open, and sitting in the SAME STAGE for at least this many days.
   *
   * ── WHY THIS IS NOT minAgeDays ──────────────────────────────────────────
   *
   * The two look interchangeable and measure opposite things. `minAgeDays` is
   * on `created_at`: how long ago the lead ARRIVED. This is on
   * `stage_changed_at`: how long since it last MOVED. A lead that arrived in
   * January and has been advancing steadily every week is old and perfectly
   * healthy; one that arrived on Monday and has not moved since is new and
   * stuck. Only the second is worth somebody's morning.
   *
   * Added for the time-in-stage warning on a rep's own scorecard, which
   * reports a count of these and has to be able to open exactly them - a
   * warning with nowhere to go is a number people learn to scroll past.
   * Implies `status = 'open'`: a closed lead is not stalled, it is finished.
   */
  stalledDays: z.coerce.number().int().min(1).max(3650).optional(),
  /** Nobody has touched it yet (0093's first_responded_at). */
  unresponded: z.coerce.boolean().optional(),
  /**
   * The leads somebody has PUT AWAY (migration 0154) - and only those.
   *
   * Absent, which is every existing caller, means the live pipeline:
   * `archived_at IS NULL` joins the predicate whether or not this is sent.
   * There is deliberately no "both" value. A mixed list is the state archiving
   * exists to prevent, and a count that silently included rows the reader had
   * hidden is the bug, not a feature - the one place the two meet is the
   * single-record read, which stays reachable so a shared deep link does not
   * 404 the day somebody archives the lead.
   */
  archived: z.coerce.boolean().optional(),
  /** Free text over the card heading, contact name and summary. */
  q: z.string().max(200).optional(),
  /**
   * Arrived within these dates, inclusive, in the org's reporting timezone -
   * the SAME predicate the response-time report windows on
   * (reports.service.ts `responseTime`), so the dashboard's card and chart
   * open lists of exactly the leads they counted.
   */
  createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** `no` = nobody has responded yet (first_responded_at, migration 0090). */
  responded: z.enum(["yes", "no"]).optional(),
  sort: z.enum(["activity", "created", "value", "title"]).default("activity"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const BoardQuery = z.object({
  /** Cards fetched per column. The count is always the true total. */
  perStage: z.coerce.number().int().min(1).max(200).default(50),
  /** Which board (0136). Absent is the Main board. */
  boardId: BoardRef.optional(),
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
  /**
   * Hot / Medium / Cold (migration 0083). null clears it, which is not the
   * same as never sending it: clearing hands the rating BACK to the worker,
   * while setting one takes it away from the worker for good.
   */
  temperature: LeadTemperature.nullable().optional(),
  /**
   * Move the lead to another board (0136). It keeps its column when the
   * target has the same key, else it enters at the target's entry column -
   * or at `stage`, when that is sent too.
   */
  boardId: BoardRef.optional(),
});

const CreateLeadBody = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  value: z.number().nonnegative().nullable().optional(),
  /** Omitted: wherever "Added manually" is routed. */
  boardId: BoardRef.optional(),
});

/** Columns every lead view returns - one shape for the board and the list. */
const LEAD_COLUMNS = `
  l.id, l.title, l.stage, l.status, l.score, l.value_num, l.summary, l.next_action,
  -- Which board it is on (0136); null is the Main board.
  l.board_id,
  -- Hot/Medium/Cold, and whether it was derived or chosen. The console shows
  -- the second one: a rating somebody picked reads differently from one the
  -- AI guessed, and hiding that difference is what makes people mistrust both.
  l.temperature, l.temperature_source,
  -- Put away, and when (0154). Carried on every view rather than only the
  -- archived list: the drawer opens from a deep link that does not know, and a
  -- lead that is archived must say so wherever it is read instead of looking
  -- like an ordinary open lead whose board column has gone missing.
  l.archived_at,
  l.notes, l.facts, l.contact_name, l.contact_number_prefix, l.contact_number_last3,
  l.call_count, l.last_activity_at, l.stage_changed_at, l.created_at,
  l.telecaller_device_id, l.last_call_id,
  l.project_id, l.project_source,
  pr.key AS project_key, pr.name AS project_name, pr.color AS project_color,
  -- Where the lead came from (migration 0078). Until then this board could not
  -- tell a phone call from an ad from a CSV import, so "which channel is worth
  -- the money" was unanswerable from the screen people actually work in.
  l.source_channel, ls.name AS source_name, ms.name AS campaign_name,
  COALESCE(d.telecaller_name, d.label) AS telecaller,
  -- Whose lead it is (routing, or a person's bulk reassign), as opposed to
  -- whose handset took the call above.
  l.assigned_telecaller_id, atc.display_name AS assigned_telecaller_name,
  -- The "Callback" column (migration 0134): the last time this lead went
  -- unanswered and the last time anybody reached them, off the calls already
  -- linked to it (calls.lead_id, 0094) rather than the number-key matching
  -- owner-calls.controller.ts uses - once a call is on the lead this is a
  -- cheaper and equally correct source of the same fact. NULLs when the lead
  -- has never had a missed call; @aura/shared's leadCallbackState turns the
  -- pair into "returned" / "waiting" / nothing to show.
  cb.last_missed_at, cb.last_reached_at`;

/**
 * The joins LEAD_COLUMNS depends on. Kept beside it rather than repeated at
 * each of the three call sites, because adding a column to the list above and
 * forgetting one of the joins below is a runtime error the typechecker cannot
 * see - generated SQL is invisible to it.
 */
const LEAD_JOINS = `
  LEFT JOIN devices d      ON d.id = l.telecaller_device_id
  LEFT JOIN crm_projects pr ON pr.id = l.project_id
  LEFT JOIN lead_sources ls ON ls.id = l.lead_source_id
  LEFT JOIN marketing_sources ms ON ms.id = l.marketing_source_id
  LEFT JOIN telecallers atc ON atc.id = l.assigned_telecaller_id
  LEFT JOIN LATERAL (
    SELECT max(c.started_at) FILTER (WHERE c.direction = 'incoming' AND c.duration_s <= 0)
             AS last_missed_at,
           max(c.started_at) FILTER (WHERE c.direction = 'outgoing'
                                         OR (c.direction = 'incoming' AND c.duration_s > 0))
             AS last_reached_at
      FROM calls c WHERE c.lead_id = l.id
  ) cb ON true`;

/**
 * The AI read of the lead's most recent call - what the operator console has
 * always shown on `/calls`, narrowed to the one call that produced this card.
 *
 * SPLICED IN ONLY FOR TENANTS WITH THE `call_intel` MODULE (org-modules.ts).
 * A tenant without it gets exactly the response it got before this existed:
 * the keys are absent, not null, so the console can tell "this client does not
 * have call intelligence" from "this lead has no call yet" without a second
 * request or a flag on the wire.
 *
 * LATERAL with LIMIT 1 rather than a plain join, for the same reason the
 * booked-slot join in the funnel list carries one: `transcripts` holds one row
 * per call today, but a reprocess that ever wrote a second would duplicate the
 * LEAD in the list - a data bug showing up as a phantom pipeline card, which is
 * a far worse failure than a missing label. LIMIT 1 makes it impossible.
 *
 * `intelligence` is the ASR/LLM output blob; the three keys read here are the
 * ones the operator drawer renders as chips (calls-explorer.tsx:651).
 */
const CALL_INTEL_COLUMNS = `,
  ci.intent    AS call_intent,
  ci.sentiment AS call_sentiment,
  ci.outcome   AS call_outcome`;

/**
 * The same read, per call rather than per lead, for the drawer's call history.
 * `has_transcript` is here so the console can offer "read the transcript" only
 * where there is one, instead of promising text and opening an empty panel.
 */
const CALL_HISTORY_INTEL_COLUMNS = `,
  ci.intent, ci.sentiment, ci.outcome, ci.has_transcript, ca.quality_score`;

const CALL_HISTORY_INTEL_JOIN = `
  LEFT JOIN LATERAL (
    SELECT t.intelligence ->> 'overall_intent' AS intent,
           t.intelligence ->> 'sentiment'      AS sentiment,
           t.intelligence ->> 'outcome'        AS outcome,
           (t.text IS NOT NULL OR t.segments IS NOT NULL) AS has_transcript
      FROM transcripts t
     WHERE t.call_id = c.id
     LIMIT 1
  ) ci ON true
  LEFT JOIN LATERAL (
    SELECT a.quality_score FROM call_analytics a WHERE a.call_id = c.id LIMIT 1
  ) ca ON true`;

const CALL_INTEL_JOIN = `
  LEFT JOIN LATERAL (
    SELECT t.intelligence ->> 'overall_intent' AS intent,
           t.intelligence ->> 'sentiment'      AS sentiment,
           t.intelligence ->> 'outcome'        AS outcome
      FROM transcripts t
     WHERE t.call_id = l.last_call_id
     LIMIT 1
  ) ci ON true`;

/**
 * The lead pipeline (§4.2 owner console).
 *
 * Rows are written by the worker's lead projection; everything here is the
 * human side of it - reading the board, moving a card, taking a note. Stage
 * values are validated against the tenant's own organizations.lead_stages
 * rather than a CHECK constraint, so a customer can rename or add a column
 * without a migration and the API still rejects a stage that doesn't exist.
 */
/**
 * ── THE GRID REACHES THIS CONTROLLER AS OF 0103 ────────────────────────────
 *
 * Until then the console's Roles & permissions screen governed the CRM half of
 * the product and nothing else, and this - the lead board and the full lead
 * list, the pages an Aura tenant actually spends the day in - was gated by the
 * console PERSONA alone. An owner could rearrange forty checkboxes and change
 * nothing about them.
 *
 * TWO SCOPES NOW RIDE ON THE REQUEST, AND ONLY ONE IS READ HERE.
 * `CrmPermissionsGuard` writes `req.crmScope`, keyed on `owner_user_id`;
 * `OwnerScopeGuard` writes `req.ownerScope`, keyed on the caller's
 * `telecallers` row. Leads carry no `owner_user_id` at all, so every handler
 * below keeps reading `@OwnerScope()` exactly as it did - the grid decides
 * WHETHER, the persona decides WHOSE. Mixing them would be the bug: a lead is
 * assigned to a telecaller identity, which the CRM grid has no concept of.
 *
 * `lead` is filed under the `aura` module in `PERMISSION_OBJECT_MODULE`, not
 * `crm`. A recording-only tenant must keep their board.
 */
@Controller("leads")
// OwnerScopeGuard on the class - see OwnerController for why it is mounted
// here rather than per-handler. It never denies; it only resolves whose
// records these are.
@UseGuards(AdminKeyGuard, TenantGuard, OwnerScopeGuard, CrmPermissionsGuard)
export class LeadsController {
  constructor(
    private readonly db: DbService,
    private readonly ingest: CrmIngestService,
  ) {}

  /**
   * Whether the human making this request may read a word-for-word account of
   * a call, per the `recordings_listen` flag an operator sets on their account
   * in Owner accounts.
   *
   * NOT `principalHasPermission(req.principal, ...)`, and this is the whole
   * point of the helper: the owner console reaches this API with the PLATFORM
   * ADMIN KEY, asserting the signed-in user in `x-caller-user-id`, and
   * AdminKeyGuard mints that principal with `recordingsListen: true` because
   * the admin key is the platform's root credential (admin-key.guard.ts:104).
   * Trusting the principal here would hand every owner the verbatim transcript
   * no matter what flag was set on their account - the flag would be console
   * decoration. So the identity comes from the principal and the GRANT is read
   * from `memberships`: the same split CrmPermissionsGuard makes, for the same
   * reason ("a caller can say who they are, but not what they may do").
   *
   * NO MEMBERSHIP ROW MEANS NO. This route exists for the owner console alone -
   * the operator console reads calls through `/v1/calls/:id`, which is
   * unchanged - so there is no bare-admin-key caller to keep working, and
   * denying is the safe direction for a surface whose whole subject is
   * privacy-sensitive text.
   */
  private async canReadTranscript(
    client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    principal: PrincipalRequest["principal"],
    orgId: string,
  ): Promise<boolean> {
    const userId = z.string().uuid().safeParse(principal?.userId);
    if (!userId.success) return false;
    const {
      rows: [membership],
    } = await client.query(
      // `org_id` spelled out even though RLS has already narrowed the table:
      // belt and braces, and the same shape CrmPermissionsGuard uses, so the
      // two membership reads cannot drift into meaning different things.
      "SELECT recordings_listen FROM memberships WHERE user_id = $1 AND org_id = $2 LIMIT 1",
      [userId.data, orgId],
    );
    return membership?.recordings_listen === true;
  }

  /** List view: filtered, sorted, paginated. */
  @Get()
  @RequireCrmPermission("lead", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const {
      boardId,
      stage,
      status,
      telecallerId,
      assignedTo,
      projectId,
      sourceChannel,
      minAgeDays,
      maxAgeDays,
      stalledDays,
      unresponded,
      q,
      createdFrom,
      createdTo,
      responded,
      archived,
      sort,
      limit,
      offset,
    } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const intel = await orgHasModule(client, "call_intel");
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        // Global replace, matching tasks.controller.ts: the persona's
        // owned-scope clause carries TWO `$?` placeholders bound to the same
        // value (assignment OR attribution - see ownerScopeFilter), and a
        // single-occurrence replace would leave the second one literal and
        // send `$?` to Postgres as a syntax error. Every other clause here has
        // exactly one placeholder, so this is identical for them.
        where.push(clause.replace(/\$\?/g, `$${params.length}`));
      };

      // The persona narrowing (migration 0079), FIRST in the predicate list so
      // it can never be skipped by an early return added later.
      //
      // nav.ts has described this page as "All Leads (self-filtered)" for a
      // telecaller since the personas were designed, and until now nothing
      // filtered it: the nav hid the board and left the full list one URL
      // away. This is the filter that claim was always describing.
      //
      // It is an AND alongside the caller's own filters, never a replacement
      // for them - `?telecallerId=` still works for an owner, and still
      // narrows further (rather than widening) for anybody scoped to their
      // own records.
      const scoped = ownerScopeFilter("lead", scope, "l");
      if (scoped) add(scoped.sql, scoped.value);

      // Archived or live, never both (0154) - second in the list for the same
      // reason the persona narrowing is first: it is not one of the reader's
      // filters, it is the definition of which pipeline they are looking at.
      // `leads_org_activity_live` and `leads_org_stage_live` are partial over
      // this exact predicate, so the default list keeps its index.
      where.push(archived ? "l.archived_at IS NOT NULL" : "l.archived_at IS NULL");

      if (boardId === "main") where.push("l.board_id IS NULL");
      else if (boardId) add("l.board_id = $?", boardId);
      if (stage) add("l.stage = $?", stage);
      if (status) add("l.status = $?", status);
      if (telecallerId) add("l.telecaller_device_id = $?", telecallerId);
      if (assignedTo === "none") where.push("l.assigned_telecaller_id IS NULL");
      else if (assignedTo) add("l.assigned_telecaller_id = $?", assignedTo);
      // Day bounds in the org's reporting timezone, written exactly as
      // reports.service.ts responseTime writes them.
      const tz = `(SELECT reporting_timezone FROM organizations LIMIT 1)`;
      if (createdFrom) add(`l.created_at >= ($?::date)::timestamp AT TIME ZONE ${tz}`, createdFrom);
      if (createdTo) add(`l.created_at < (($?::date) + 1)::timestamp AT TIME ZONE ${tz}`, createdTo);
      if (responded === "no") where.push("l.first_responded_at IS NULL");
      else if (responded === "yes") where.push("l.first_responded_at IS NOT NULL");
      if (projectId === "none") where.push("l.project_id IS NULL");
      else if (projectId) add("l.project_id = $?", projectId);
      if (sourceChannel === "none") where.push("l.source_channel IS NULL");
      else if (sourceChannel) add("l.source_channel = $?", sourceChannel);
      // Age, expressed as a date bound rather than as arithmetic on every
      // row: `created_at <= now() - N days` can use leads_org_created_at
      // (0093), while `age(created_at) >= N` cannot.
      if (minAgeDays !== undefined) {
        add("l.created_at <= now() - make_interval(days => $?::int)", minAgeDays);
      }
      if (maxAgeDays !== undefined) {
        // +1 because the bucket is inclusive: "at most 7 days old" includes
        // everything up to the instant it turns 8.
        add("l.created_at > now() - make_interval(days => $?::int + 1)", maxAgeDays);
      }
      // Stalled: open and not moved for N days. A date bound rather than
      // arithmetic per row, the same reason the two age filters above give, and
      // `status = 'open'` is part of the definition rather than something the
      // caller has to remember to add.
      if (stalledDays !== undefined) {
        where.push("l.status = 'open'");
        add("l.stage_changed_at <= now() - make_interval(days => $?::int)", stalledDays);
      }
      if (unresponded) where.push("l.first_responded_at IS NULL");
      if (q) {
        // One param, three columns - pushed once so the placeholder numbering
        // stays in step with `params`.
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(l.title ILIKE ${p} OR l.contact_name ILIKE ${p} OR l.summary ILIKE ${p})`);
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
        `SELECT ${LEAD_COLUMNS}${intel ? CALL_INTEL_COLUMNS : ""},
                count(*) OVER()::int AS total_count
           FROM leads l
           ${LEAD_JOINS}${intel ? CALL_INTEL_JOIN : ""}
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${ORDER[sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      // Every board, so each row's stage reads in its own board's words.
      // `stages` stays the Main board's, for the stage filter.
      const boards = await listLeadBoards(client, orgId);
      return {
        leads: rows.map(({ total_count: _total, ...lead }) => lead),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
        stages: boards[0]?.stages ?? [],
        boards,
      };
    });
  }

  /** Board view: every column, with its true count and the top N cards. */
  @Get("board")
  @RequireCrmPermission("lead", "view")
  async board(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = BoardQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const { perStage, projectId } = parsed.data;
    const boardId = parsed.data.boardId ? boardIdOf(parsed.data.boardId) : null;

    return this.db.withOrg(orgId, async (client) => {
      // All boards in one read: this one's columns, and the switcher's list.
      const boards = await listLeadBoards(client, orgId);
      const board = boards.find((b) => b.id === boardId);
      if (!board) throw new NotFoundException("no such lead board");
      const stages = board.stages;

      const params: unknown[] = [perStage];
      // An archived lead is off the board entirely, with no filter to bring it
      // back (0154). The board is a place to work, not a place to look things
      // up, and the per-column counts and value subtotals are computed from
      // these same rows - a hidden card still swelling its column's total
      // would make the one number people read off this screen wrong.
      const boardWhere: string[] = ["l.archived_at IS NULL"];
      if (boardId === null) {
        boardWhere.push("l.board_id IS NULL");
      } else {
        params.push(boardId);
        boardWhere.push(`l.board_id = $${params.length}`);
      }
      if (projectId === "none") {
        boardWhere.push("l.project_id IS NULL");
      } else if (projectId) {
        params.push(projectId);
        boardWhere.push(`l.project_id = $${params.length}`);
      }

      // The persona narrowing (0079). The board is nav-restricted to
      // owner/manager, but the nav is the convenience and not the control -
      // this endpoint is reachable by URL, and a telecaller who reaches it
      // must see their own column counts rather than the floor's.
      //
      // Inside the subquery for the same reason the project filter is: the
      // window functions must see only the rows this person may read, or the
      // per-column totals would describe a board they are not being shown.
      const scoped = ownerScopeFilter("lead", scope, "l");
      if (scoped) {
        params.push(scoped.value);
        boardWhere.push(scoped.sql.replace(/\$\?/g, `$${params.length}`));
      }

      const projectWhere = boardWhere.length > 0 ? `WHERE ${boardWhere.join(" AND ")}` : "";

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

      return {
        columns,
        orphaned: orphans.length,
        stages,
        board: { id: board.id, name: board.name },
        boards: boards.map((b) => ({ id: b.id, name: b.name })),
      };
    });
  }

  /** Detail: the lead plus every call from that contact. */
  @Get(":id")
  @RequireCrmPermission("lead", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) leadId: string,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const intel = await orgHasModule(client, "call_intel");
      // The persona narrowing (0079) applied to a single-record read, which is
      // the one that matters most: hiding a lead from a LIST while leaving it
      // readable at /v1/leads/<id> protects nothing - the ids are in the list
      // response of anyone who ever had wider access, and a drawer deep-link
      // is shared between colleagues constantly.
      //
      // Folded into the WHERE rather than checked after the fetch, so an
      // out-of-scope lead is indistinguishable from one that does not exist.
      // A 403 here would confirm the record's existence to somebody not
      // allowed to read it; the 404 below says only "not yours to see".
      // `ownerScopeFilter` rather than `ownerScopeClause`, because the VALUE is
      // needed too and only the filter carries it - the sentinel an unresolved
      // identity falls back to lives in owner-scope.ts and must not be
      // re-derived here, where it could silently drift from the one every
      // other query uses.
      const owned = ownerScopeFilter("lead", scope, "l");
      const {
        rows: [lead],
      } = await client.query(
        `SELECT ${LEAD_COLUMNS}${intel ? CALL_INTEL_COLUMNS : ""},
                l.workspace_id, l.contact_number_hash, l.first_call_id,
                l.agent_id, l.agent_version
           FROM leads l
           ${LEAD_JOINS}${intel ? CALL_INTEL_JOIN : ""}
          WHERE l.id = $1${owned ? ` AND ${owned.sql.replace(/\$\?/g, "$2")}` : ""}`,
        owned ? [leadId, owned.value] : [leadId],
      );
      if (!lead) throw new NotFoundException("lead not found");

      // Calls reached through the contact hash, so the history survives the
      // lead being re-derived - plus the originating call when there is no
      // number to match on, plus anything actually LINKED to this lead.
      //
      // That third arm is 0146's, and it is what makes the drawer agree with
      // the rest of the product. The hash alone misses two populations: a call
      // matched on the normalised key (a lead stored as +9198…, the call log as
      // 098…), and a call a person placed here by hand from the triage queue.
      // Both have `calls.lead_id` set and neither has a matching hash, so until
      // now the timeline showed nothing while the call count, the response-time
      // report and the triage queue all counted them.
      //
      // Scoped to the lead's WORKSPACE. RLS keeps this inside the org, and an
      // org can hold several workspaces that are separate books of business -
      // 0094 is explicit that the hash is unique per workspace and not per org,
      // so an unscoped hash match can put another desk's calls on this card.
      //
      // With `call_intel` on, every row also carries its OWN read rather than
      // the lead's: a first call that went well and a third that went badly is
      // the most useful thing this history can say, and a single lead-level
      // label would hide it. Quality is call_analytics' score out of 100
      // (migration 0068), the same number the operator drawer shows. Both
      // LATERAL for the reason CALL_INTEL_JOIN is - a duplicate transcript row
      // must never duplicate the call in the history.
      //
      // Call escalations (0151, doc 38), in the SAME statement rather than a
      // round trip of their own: the latest escalation on each call (the
      // drawer's status chip), and whether the viewer may escalate it now -
      // the workspace switch is on, it is the viewer's OWN call (their
      // telecaller identity, from OwnerScopeGuard), and nothing is live on it.
      // `can_escalate` only decides whether the button is drawn; the raise
      // route checks all three again.
      const { rows: calls } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
                COALESCE(d.telecaller_name, d.label) AS telecaller${intel ? CALL_HISTORY_INTEL_COLUMNS : ""},
                COALESCE(
                  (SELECT o.call_escalation_enabled FROM organizations o WHERE o.id = $6::uuid)
                  AND $7::uuid IS NOT NULL AND c.telecaller_id = $7::uuid
                  AND (esc.status IS NULL OR esc.status NOT IN ('open', 'acknowledged')),
                  false) AS can_escalate,
                esc.id AS escalation_id, esc.status AS escalation_status
           FROM calls c
           LEFT JOIN devices d ON d.id = c.device_id${intel ? CALL_HISTORY_INTEL_JOIN : ""}
           LEFT JOIN LATERAL (
             SELECT ce.id, ce.status FROM call_escalations ce
              WHERE ce.call_id = c.id
              ORDER BY ce.created_at DESC
              LIMIT 1
           ) esc ON true
          WHERE (($1::text IS NOT NULL AND c.remote_number_hash = $1
                    AND c.workspace_id = $5::uuid)
                 OR c.lead_id = $4::uuid
                 OR c.id = $2 OR c.id = $3)
          ORDER BY c.started_at DESC
          LIMIT 50`,
        [
          lead.contact_number_hash,
          lead.first_call_id,
          lead.last_call_id,
          leadId,
          lead.workspace_id,
          orgId,
          scope.telecallerId ?? null,
        ],
      );

      // The lead's OWN board's columns for its stage picker, and every board
      // for the "move to board" one.
      const boards = await listLeadBoards(client, orgId);
      const stages = (boards.find((b) => b.id === (lead.board_id ?? null)) ?? boards[0])?.stages ?? [];
      return { lead, calls, stages, boards: boards.map((b) => ({ id: b.id, name: b.name })) };
    });
  }

  /**
   * What was actually said on one of this lead's calls: the transcript, the AI
   * read behind the chips, and the call's own quality analytics.
   *
   * A SEPARATE REQUEST, not part of the detail payload above, because a
   * transcript is unbounded text and the drawer lists up to 50 calls - folding
   * them in would make opening any lead pay for every conversation it ever had,
   * to render a panel the reader may never open.
   *
   * NESTED UNDER THE LEAD deliberately: the call has to satisfy the same
   * predicate the history list uses, so this route can only reach a call the
   * drawer already showed. RLS scopes both to the tenant regardless; what the
   * nesting buys is that the two can never disagree about which calls belong to
   * this card.
   *
   * TWO INDEPENDENT GATES, each refusing at the level it is about. The tenant's
   * `call_intel` module is an entitlement, so its absence is a 403 - this
   * client does not have the surface at all. The reader's own
   * `recordings_listen` is a permission over one artifact, so its absence
   * REDACTS: the AI read still comes back, the verbatim text does not. That
   * split mirrors `calls.controller.ts:406` exactly - status, summary and
   * analytics stay visible to any tenant member; a word-for-word account of
   * someone's phone call is the privileged part.
   */
  @Get(":id/calls/:callId")
  @RequireCrmPermission("lead", "view")
  async callDetail(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) leadId: string,
    @Param("callId", ParseUUIDPipe) callId: string,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }

      // Scoped on the LEAD, which is what gates this route: everything below -
      // the call row, its transcript, its analytics - is reached through this
      // lookup, so narrowing it here narrows all of them. A telecaller may
      // read the recording and the verbatim transcript of a call on their own
      // lead; on a colleague's lead this 404s before any of it is fetched.
      const owned = ownerScopeFilter("lead", scope, "");
      const {
        rows: [lead],
      } = await client.query(
        `SELECT workspace_id, contact_number_hash, first_call_id, last_call_id FROM leads
          WHERE id = $1${owned ? ` AND ${owned.sql.replace(/\$\?/g, "$2")}` : ""}`,
        owned ? [leadId, owned.value] : [leadId],
      );
      if (!lead) throw new NotFoundException("lead not found");

      const {
        rows: [call],
      } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
                COALESCE(d.telecaller_name, d.label) AS telecaller
           FROM calls c
           LEFT JOIN devices d ON d.id = c.device_id
          WHERE c.id = $1
            AND ((($2::text IS NOT NULL AND c.remote_number_hash = $2)
                    AND c.workspace_id = $6::uuid)
                 OR c.lead_id = $5::uuid
                 OR c.id = $3 OR c.id = $4)`,
        // The same three arms the drawer lists on, and they have to stay the
        // same three: this is the authorization gate for the transcript, the
        // recording and the analytics behind every row it shows. A row visible
        // in the list and 404 when opened is the mismatch; so is the reverse,
        // which would be a leak.
        [
          callId,
          lead.contact_number_hash,
          lead.first_call_id,
          lead.last_call_id,
          leadId,
          lead.workspace_id,
        ],
      );
      if (!call) throw new NotFoundException("call not found for this lead");

      const {
        rows: [transcript],
      } = await client.query(
        `SELECT language, engine, diarized, text, segments, intelligence
           FROM transcripts WHERE call_id = $1 LIMIT 1`,
        [callId],
      );
      const {
        rows: [analytics],
      } = await client.query(
        `SELECT quality_score, quality_criteria, talk_ratio, agent_talk_seconds,
                customer_talk_seconds, interruption_count, risk_flags,
                has_escalation_risk
           FROM call_analytics WHERE call_id = $1 LIMIT 1`,
        [callId],
      );

      const canRead = await this.canReadTranscript(client, req.principal, orgId);
      if (!canRead && transcript) {
        transcript.text = null;
        transcript.segments = null;
      }

      return {
        call,
        transcript: transcript ?? null,
        analytics: analytics ?? null,
        transcriptRedacted: !canRead,
      };
    });
  }

  /**
   * "New lead" - a person putting a card on a board by hand (0136).
   *
   * Through `CrmIngestService`, the same write every other door uses, so a
   * hand-made lead gets the contact, the deal, the project detection and the
   * telecaller rotation a web-form lead gets, and dedupes on the same phone
   * key: typing a number the business already knows opens THAT lead
   * (`created: false`) instead of forking a duplicate.
   *
   * The board is the person's pick when they made one, else wherever
   * "Added manually" is routed.
   */
  @Post()
  @RequireCrmPermission("lead", "create")
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreateLeadBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const b = parsed.data;
    // E.164, valid for its country - so a lead typed here dedupes against the
    // same person arriving from Meta or WhatsApp, which already send E.164.
    const phone = b.phone?.trim()
      ? consolePhone(b.phone, "phone", await this.db.withOrg(orgId, (client) => orgPhoneCountry(client, orgId)))
      : null;
    const lead = await this.ingest.createLead(orgId, {
      name: b.name,
      phone,
      email: b.email ?? null,
      company: b.company ?? null,
      notes: b.notes ?? null,
      value: b.value ?? null,
      sourceChannel: "manual",
      ...(b.boardId !== undefined ? { boardId: boardIdOf(b.boardId) } : {}),
    });
    return { leadId: lead.leadId, created: lead.created, boardId: lead.boardId };
  }

  /**
   * Give many leads to one telecaller - the Leads list's bulk "Reassign".
   *
   * ── OWNER AND MANAGER ONLY ─────────────────────────────────────────────────
   *
   * Assignment is what lead routing (0094) does, and its rules page is
   * owner/manager; a person redistributing the backlog by hand is making the
   * same decision, so it gets the same gate. A telecaller who could reassign
   * could hand their hard leads to a colleague, or take the easy ones.
   *
   * The target is a TELECALLER identity, checked against this org
   * (org-references.ts), not a user: a telecaller can have no console login.
   * The persona scope is still ANDed into the UPDATE, which for these two
   * personas narrows nothing today and keeps meaning something if that changes.
   *
   * Assignment is a person's decision (crm-ingest.service.ts keeps it across
   * re-submissions), so an assigned lead stays assigned until a person moves it.
   */
  @Post("reassign")
  @UseGuards(OwnerRoleGuard)
  @RequireOwnerRole("owner", "manager")
  async reassign(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Body() body: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ): Promise<BulkResult> {
    const parsed = BulkAssignLeadsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { ids, telecallerId } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertInOrg(client, orgId, { telecallerId });
      const updated = await assignInBulk(client, {
        orgId,
        table: "leads",
        column: "assigned_telecaller_id",
        value: telecallerId,
        ids,
        owned: ownerScopeFilter("lead", scope, "r"),
        audit: { targetType: "lead", action: "lead.reassign", actorId: req.principal?.userId ?? "unknown" },
      });

      // Tell the telecaller, once per click - and only one bound to a console
      // login (lead-routing.ts's notifyAssignee reasoning: an unbound
      // telecaller has nobody to tell, and that is a normal state). Not when
      // the person reassigning IS that telecaller.
      if (telecallerId && updated.length > 0) {
        const one = updated.length === 1;
        await client.query(
          `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path)
           SELECT $1, t.user_id, 'lead_assigned', $2, $3, $4
             FROM telecallers t
            WHERE t.id = $5 AND t.org_id = $1 AND t.user_id IS NOT NULL
              AND t.user_id::text IS DISTINCT FROM $6`,
          [
            orgId,
            one ? "A lead was assigned to you" : `${updated.length} leads were assigned to you`,
            "Reassigned to you from the Leads list.",
            one ? `/owner/leads?focus=${updated[0]}` : "/owner/leads",
            telecallerId,
            req.principal?.userId ?? null,
          ],
        );
      }

      return { updated: updated.length, skipped: ids.length - updated.length };
    });
  }

  /**
   * Put a lead away, or take it back out (migration 0154).
   *
   * ── WHY THIS IS NOT A FIELD ON PATCH ────────────────────────────────────────
   *
   * `UpdateLeadBody` is what the owner KEEPS on a card - its title, its note,
   * its rating, its column. Archiving is not an edit of the lead, it is a
   * decision about whether the lead is in the working list at all, and the two
   * want different shapes: an explicit, auditable act with its own name, which
   * a `PATCH {archived: true}` buried among six optional fields is not. It also
   * means a client cannot archive by accident while saving a note.
   *
   * ── WHAT IT IS AND IS NOT ───────────────────────────────────────────────────
   *
   * NOT a delete. Nothing is removed and nothing is scheduled to be: the calls,
   * the notes, the tasks, the stage ledger and every report that ranges over
   * them are untouched. The lead leaves the list and the board, and the Archived
   * filter is where it lives afterwards. 0108 drew that line and this keeps to
   * it.
   *
   * `lead:edit`, the same grant a stage move needs: hiding a lead from the
   * floor's list changes what everybody else sees, so it is not a read.
   * Idempotent on purpose - archiving an archived lead keeps the FIRST
   * archived_at rather than restamping it, because "when was this put away" is
   * a fact about the decision and a double click must not rewrite it.
   */
  @Post(":id/archive")
  @RequireCrmPermission("lead", "edit")
  async archive(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) leadId: string,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    return this.setArchived(req, orgId, leadId, scope, true);
  }

  @Post(":id/unarchive")
  @RequireCrmPermission("lead", "edit")
  async unarchive(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) leadId: string,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    return this.setArchived(req, orgId, leadId, scope, false);
  }

  private async setArchived(
    req: PrincipalRequest,
    orgId: string,
    leadId: string,
    scope: OwnerRecordScope,
    archived: boolean,
  ) {
    const actorId = req.principal?.userId ?? null;
    return this.db.withOrg(orgId, async (client) => {
      // The persona narrowing folded into the UPDATE, not checked after it -
      // the detail read's reasoning, for the same reason: a lead that is not
      // this person's to see must answer 404 here too, rather than confirming
      // it exists by refusing differently.
      // No alias - a bare `UPDATE leads`, the same way the PATCH below takes it.
      const owned = ownerScopeFilter("lead", scope, "");
      const params: unknown[] = [leadId, archived ? actorId : null];
      const sql = `UPDATE leads
                      SET archived_at = ${archived ? "COALESCE(archived_at, now())" : "NULL"},
                          archived_by = $2
                    WHERE id = $1${owned ? ` AND ${owned.sql.replace(/\$\?/g, "$3")}` : ""}
                RETURNING id, archived_at`;
      if (owned) params.push(owned.value);
      const {
        rows: [lead],
      } = await client.query<{ id: string; archived_at: string | null }>(sql, params);
      if (!lead) throw new NotFoundException("lead not found");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, $3, 'lead', $4)`,
        [orgId, actorId ?? "unknown", archived ? "lead.archive" : "lead.unarchive", leadId],
      );
      return { lead };
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
  @RequireCrmPermission("lead", "edit")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) leadId: string,
    @Body() body: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = UpdateLeadBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");
    const actorId = req.principal?.userId ?? "unknown";

    return this.db.withOrg(orgId, async (client) => {
      // The columns of the board this lead is on (0136) - a stage is only
      // valid against its own board. One read, the same cost as the org-wide
      // stage list this replaced. Scoped like the write below, so a lead this
      // person may not see answers 404 here too rather than a stage error.
      const readable = ownerScopeFilter("lead", scope, "l");
      const {
        rows: [current],
      } = await client.query<{ board_id: string | null; stage: string; stages: unknown }>(
        `SELECT l.board_id, l.stage, COALESCE(b.stages, o.lead_stages) AS stages
           FROM leads l
           JOIN organizations o ON o.id = l.org_id
           LEFT JOIN lead_boards b ON b.id = l.board_id
          WHERE l.id = $1${readable ? ` AND ${readable.sql.replace(/\$\?/g, "$2")}` : ""}`,
        readable ? [leadId, readable.value] : [leadId],
      );
      if (!current) throw new NotFoundException("lead not found");

      const targetBoardId = p.boardId !== undefined ? boardIdOf(p.boardId) : current.board_id;
      const moving = targetBoardId !== current.board_id;
      let stages = parseLeadStages(current.stages);
      if (moving) {
        const target = await leadBoardStages(client, orgId, targetBoardId);
        if (!target) throw new BadRequestException("no such lead board");
        stages = target.stages;
      }
      // A move keeps the card's column when the target board has that key.
      const nextStage = p.stage ?? (moving ? stageOnBoard(stages, current.stage) : undefined);
      if (nextStage && !stages.some((s) => s.key === nextStage)) {
        throw new BadRequestException(
          `unknown stage "${nextStage}" - valid stages: ${stages.map((s) => s.key).join(", ")}`,
        );
      }
      const status = nextStage ? statusForStage(stages, nextStage) : null;

      // The handset and project must be this org's - foreign-key checks
      // ignore RLS (doc 23, A2).
      await assertInOrg(client, orgId, { deviceId: p.telecallerDeviceId, projectId: p.projectId });

      // WRITES ARE SCOPED TOO, not only reads. A telecaller who can see just
      // their own leads but could still PATCH any lead id would be able to
      // move a colleague's card, reprice it, or reassign the handset on it -
      // and the read filter would then hide the evidence from them. Scoping
      // the read without the write is the worse of the two half-measures.
      const owned = ownerScopeFilter("lead", scope, "");
      const ownedAnd = owned ? ` AND ${owned.sql.replace(/\$\?/g, "$21")}` : "";

      const {
        rows: [updated],
      } = await client.query(
        // `prior` reads the card's stage BEFORE this write, for the stage
        // ledger below - in the same statement, so it costs no extra round
        // trip. FOR UPDATE so a move racing this one cannot hand the ledger a
        // stale "from": the lock waits for the other write and then reads it.
        `WITH prior AS (
           SELECT stage AS prior_stage, status AS prior_status
             FROM leads
            WHERE id = $1${ownedAnd}
              FOR UPDATE
         )
         UPDATE leads SET
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
           temperature = CASE WHEN $17::boolean THEN $18::text ELSE temperature END,
           -- HUMAN-OWNS-IT again, and the same shape as project_source above.
           -- Setting a rating takes it off the worker permanently; CLEARING it
           -- ($17 sent, $18 null) is the deliberate way to hand it back, which
           -- is why this cannot be a plain WHEN $17 THEN 'user'.
           temperature_source = CASE
                                  WHEN $17::boolean AND $18::text IS NOT NULL THEN 'user'
                                  WHEN $17::boolean THEN 'auto'
                                  ELSE temperature_source
                                END,
           board_id    = CASE WHEN $19::boolean THEN $20::uuid ELSE board_id END,
           -- Working a lead IS activity: without this a card the owner is
           -- actively progressing would age out of the retention sweep.
           last_activity_at = now()
          FROM prior
         WHERE id = $1${ownedAnd}
         RETURNING id, stage, status, title, value_num, next_action, notes, contact_name,
                   telecaller_device_id, project_id, project_source,
                   temperature, temperature_source, board_id,
                   stage_changed_at, last_activity_at,
                   prior.prior_stage, prior.prior_status`,
        [
          leadId,
          nextStage ?? null,
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
          p.temperature !== undefined,
          p.temperature ?? null,
          moving,
          targetBoardId,
          // $21, present only when the persona narrows. Spread rather than
          // pushed unconditionally so the placeholder numbering above stays
          // literal and readable.
          ...(owned ? [owned.value] : []),
        ],
      );
      // Same 404-not-403 reasoning as detail(): a scoped persona editing
      // somebody else's lead must not be told the lead exists.
      if (!updated) throw new NotFoundException("lead not found");
      const { prior_stage: priorStage, prior_status: priorStatus, ...lead } = updated as Record<string, unknown>;

      // The lead's own stage ledger (0075). In the main transaction, not the
      // non-blocking propagation below: this is the lead's history rather than
      // a copy of it on another record, and a move the ledger silently missed
      // is exactly the bug this call fixes. `console` because this endpoint is
      // only ever a person - which is also what lets 0093's trigger count the
      // move as the lead's first response.
      if (nextStage) {
        await recordLeadStageTransition(client, orgId, {
          leadId,
          fromStage: (priorStage as string | null) ?? null,
          toStage: String(lead.stage),
          fromStatus: (priorStatus as string | null) ?? null,
          toStatus: String(lead.status),
          source: "console",
          changedBy: actorUserId(req),
        });
      }

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

      // Everything below is carried onto the lead's deal and contact, and none
      // of it may cost the lead PATCH itself. A try/catch alone cannot promise
      // that: once a statement fails inside a Postgres transaction, every later
      // statement fails too - including the audit insert below - so the whole
      // PATCH would 500 after all. The SAVEPOINT is what makes "non-blocking"
      // true.
      await client.query("SAVEPOINT lead_propagation");
      try {
        // Edits a person made to the lead reach the records projected from it.
        // Before this, a renamed or repriced lead left its deal and contact on
        // the old values forever (doc 23, F1).
        await this.propagateFieldsToCrm(client, leadId, p);

        // A6: the worker's dual-write (projectLeadToCrm) only sets a deal's
        // stage/status ONCE, on creation - a follow-up call must never move a
        // deal a human is already working. This IS that human moving it, so
        // propagating it onto the linked deal is this endpoint's job.
        //
        // Main board only (0136): another board's column keys are its own and
        // have no deal equivalent, so carrying them over would only fill
        // reconciliation with false mismatches.
        if (nextStage && targetBoardId === null) {
          await this.propagateStageToDeal(client, orgId, leadId, nextStage, actorUserId(req));
        }
        await client.query("RELEASE SAVEPOINT lead_propagation");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT lead_propagation");
        console.error(`lead ${leadId}: deal/contact propagation error (non-blocking):`, err);
      }

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, $3, 'lead', $4, $5::jsonb)`,
        [
          orgId,
          actorId,
          moving ? "lead.board_move" : nextStage ? "lead.stage_change" : "lead.update",
          leadId,
          JSON.stringify(p),
        ],
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
    client: PropagationClient,
    orgId: string,
    leadId: string,
    newStage: string,
    actorId: string | null,
  ): Promise<void> {
    const {
      rows: [deal],
    } = await client.query<{
      id: string;
      stage: string;
      status: string;
      pipeline_id: string;
      contact_id: string | null;
      account_id: string | null;
      amount: string | null;
      owner_user_id: string | null;
    }>(
      `SELECT id, stage, status, pipeline_id, contact_id, account_id, amount, owner_user_id
         FROM deals WHERE source_lead_id = $1`,
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

    // The event the Deals board's own PATCH queues for the same move. Without
    // it a stage rule fired only when a card was dragged on Deals, never on the
    // Lead Board most of the floor works from (doc 23, C2).
    if (deal.stage !== newStage) {
      await enqueueAutomationEventSafely(
        client,
        orgId,
        "deal.stage_changed",
        "deal",
        deal.id,
        dealStageChangedSubject(deal, deal.stage, newStage, dealStatus),
      );
    }
  }

  /**
   * Carry a person's edits to a lead onto the deal and contact projected from
   * it (doc 23, F1). One direction only - lead to deal/contact - by decision X3.
   *
   * - title    -> deal.name       (the reconciler compares exactly these two)
   * - valueNum -> deal.amount
   * - contactName -> contact.display_name, but ONLY on the contact this lead
   *   created (`source_lead_id`). A contact is org-wide and several leads can
   *   collapse into it; renaming it from one of them would rename a person
   *   every other lead also points at.
   *
   * A cleared contact name is not carried: `display_name` is NOT NULL, and
   * blanking a person's name because a card's label was emptied is not an edit
   * anybody meant.
   */
  private async propagateFieldsToCrm(
    client: PropagationClient,
    leadId: string,
    p: { title?: string; valueNum?: number | null; contactName?: string | null },
  ): Promise<void> {
    if (p.title !== undefined || p.valueNum !== undefined) {
      await client.query(
        `UPDATE deals SET
           name   = COALESCE($2, name),
           amount = CASE WHEN $3::boolean THEN $4::numeric ELSE amount END
         WHERE source_lead_id = $1`,
        [leadId, p.title ?? null, p.valueNum !== undefined, p.valueNum ?? null],
      );
    }
    const name = p.contactName?.trim();
    if (name) {
      await client.query(
        // A person renamed the lead, so the name is now a human's (0107) and
        // the call projection will not write the extraction back over it.
        `UPDATE contacts SET display_name = $2, display_name_set_by_human_at = now()
          WHERE source_lead_id = $1 AND status <> 'merged'`,
        [leadId, name.slice(0, 200)],
      );
    }
  }
}

function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}

/** The client shape the propagation helpers need - a pg client inside withOrg. */
type PropagationClient = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};
