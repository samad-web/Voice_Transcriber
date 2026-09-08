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
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  LeadSourceChannel,
  LeadTemperature,
  parseLeadStages,
  parsePipelineStages,
  statusForStage,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { orgHasModule } from "../../common/org-modules";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerScope, type OwnerRecordScope, ownerScopeFilter } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
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
  /** Nobody has touched it yet (0093's first_responded_at). */
  unresponded: z.coerce.boolean().optional(),
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
  /**
   * Hot / Medium / Cold (migration 0083). null clears it, which is not the
   * same as never sending it: clearing hands the rating BACK to the worker,
   * while setting one takes it away from the worker for good.
   */
  temperature: LeadTemperature.nullable().optional(),
});

/** Columns every lead view returns - one shape for the board and the list. */
const LEAD_COLUMNS = `
  l.id, l.title, l.stage, l.status, l.score, l.value_num, l.summary, l.next_action,
  -- Hot/Medium/Cold, and whether it was derived or chosen. The console shows
  -- the second one: a rating somebody picked reads differently from one the
  -- AI guessed, and hiding that difference is what makes people mistrust both.
  l.temperature, l.temperature_source,
  l.notes, l.facts, l.contact_name, l.contact_number_prefix, l.contact_number_last3,
  l.call_count, l.last_activity_at, l.stage_changed_at, l.created_at,
  l.telecaller_device_id, l.last_call_id,
  l.project_id, l.project_source,
  pr.key AS project_key, pr.name AS project_name, pr.color AS project_color,
  -- Where the lead came from (migration 0078). Until then this board could not
  -- tell a phone call from an ad from a CSV import, so "which channel is worth
  -- the money" was unanswerable from the screen people actually work in.
  l.source_channel, ls.name AS source_name, ms.name AS campaign_name,
  COALESCE(d.telecaller_name, d.label) AS telecaller`;

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
  LEFT JOIN marketing_sources ms ON ms.id = l.marketing_source_id`;

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
      stage,
      status,
      telecallerId,
      projectId,
      sourceChannel,
      minAgeDays,
      maxAgeDays,
      unresponded,
      q,
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

      if (stage) add("l.stage = $?", stage);
      if (status) add("l.status = $?", status);
      if (telecallerId) add("l.telecaller_device_id = $?", telecallerId);
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
  @RequireCrmPermission("lead", "view")
  async board(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = BoardQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const { perStage, projectId } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const stages = await this.stagesFor(client);

      const params: unknown[] = [perStage];
      const boardWhere: string[] = [];
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

      return { columns, orphaned: orphans.length, stages };
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
      // number to match on.
      //
      // With `call_intel` on, every row also carries its OWN read rather than
      // the lead's: a first call that went well and a third that went badly is
      // the most useful thing this history can say, and a single lead-level
      // label would hide it. Quality is call_analytics' score out of 100
      // (migration 0068), the same number the operator drawer shows. Both
      // LATERAL for the reason CALL_INTEL_JOIN is - a duplicate transcript row
      // must never duplicate the call in the history.
      const { rows: calls } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
                COALESCE(d.telecaller_name, d.label) AS telecaller${intel ? CALL_HISTORY_INTEL_COLUMNS : ""}
           FROM calls c
           LEFT JOIN devices d ON d.id = c.device_id${intel ? CALL_HISTORY_INTEL_JOIN : ""}
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
        `SELECT contact_number_hash, first_call_id, last_call_id FROM leads
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
            AND (($2::text IS NOT NULL AND c.remote_number_hash = $2)
                 OR c.id = $3 OR c.id = $4)`,
        [callId, lead.contact_number_hash, lead.first_call_id, lead.last_call_id],
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
      const stages = await this.stagesFor(client);
      if (p.stage && !stages.some((s) => s.key === p.stage)) {
        throw new BadRequestException(
          `unknown stage "${p.stage}" - valid stages: ${stages.map((s) => s.key).join(", ")}`,
        );
      }
      const status = p.stage ? statusForStage(stages, p.stage) : null;

      // WRITES ARE SCOPED TOO, not only reads. A telecaller who can see just
      // their own leads but could still PATCH any lead id would be able to
      // move a colleague's card, reprice it, or reassign the handset on it -
      // and the read filter would then hide the evidence from them. Scoping
      // the read without the write is the worse of the two half-measures.
      const owned = ownerScopeFilter("lead", scope, "");

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
           -- Working a lead IS activity: without this a card the owner is
           -- actively progressing would age out of the retention sweep.
           last_activity_at = now()
         WHERE id = $1${owned ? ` AND ${owned.sql.replace(/\$\?/g, "$19")}` : ""}
         RETURNING id, stage, status, title, value_num, next_action, notes, contact_name,
                   telecaller_device_id, project_id, project_source,
                   temperature, temperature_source,
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
          p.temperature !== undefined,
          p.temperature ?? null,
          // $19, present only when the persona narrows. Spread rather than
          // pushed unconditionally so the placeholder numbering above stays
          // literal and readable.
          ...(owned ? [owned.value] : []),
        ],
      );
      // Same 404-not-403 reasoning as detail(): a scoped persona editing
      // somebody else's lead must not be told the lead exists.
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
      if (p.stage)
        await this.propagateStageToDeal(client, orgId, leadId, p.stage, actorUserId(req));

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
      query: <R = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => Promise<{ rows: R[] }>;
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
      } = await client.query<{ stages: unknown }>(
        `SELECT stages FROM deal_pipelines WHERE id = $1`,
        [deal.pipeline_id],
      );
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
