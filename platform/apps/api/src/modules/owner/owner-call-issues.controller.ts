import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  CALL_ISSUE_LIVE_STATUSES,
  CallIssueCategory,
  CallIssueSeverity,
  MAX_LIVE_CALL_ISSUES_PER_ORG,
  resolveOwnerRole,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { orgHasModule } from "../../common/org-modules";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { isUniqueViolation, violatedConstraint } from "../../common/pg-errors";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const FileIssueBody = z.object({
  callId: z.string().uuid(),
  category: CallIssueCategory,
  severity: CallIssueSeverity.default("wrong"),
  description: z.string().trim().min(1).max(2000),
  /** Seconds from the start of the recording; the console prefills the player's position. */
  atSeconds: z.number().int().min(0).max(86_400).optional(),
});

/**
 * Deliberately NOT `FileIssueBody.partial()` for the later PATCH somebody will
 * want. `.partial()` keeps `.default()`, so a request that omitted `severity`
 * would silently reset it to 'wrong' - see zod-partial-default-trap, which
 * records a live instance of exactly that in outreach cadences.
 */
const ReplyBody = z.object({ body: z.string().trim().min(1).max(4000) });

const ListQuery = z.object({
  /** `live` is the default: a list where closed reports outnumber open ones is one nobody opens. */
  state: z.enum(["live", "closed", "all"]).default("live"),
  callId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The columns a CLIENT may read off their own report.
 *
 * `assigned_to_email` and `acknowledged_by_email` are deliberately absent, and
 * `acknowledged` is a boolean instead. A customer is entitled to know that
 * somebody here has picked their report up; naming WHICH of our staff invites
 * mail straight to that person and around the queue, and those addresses are
 * ours to disclose rather than the API's to leak by default.
 */
const CLIENT_COLUMNS = `r.id, r.ref, r.call_id, r.category, r.severity, r.status,
       r.description, r.at_seconds,
       r.reported_by_user_id, r.reported_by_name, r.reported_by_role, r.reported_at,
       r.acknowledged_at IS NOT NULL AS acknowledged, r.acknowledged_at,
       r.resolution, r.resolution_note, r.resolved_at, r.client_confirmed_at,
       r.reprocess_count, r.last_reprocess_at,
       c.started_at AS call_started_at, c.direction AS call_direction,
       c.duration_s AS call_duration_s,
       COALESCE(d.telecaller_name, d.label) AS telecaller`;

const CLIENT_FROM = `FROM call_issue_reports r
       JOIN calls c ON c.id = r.call_id
       LEFT JOIN devices d ON d.id = c.device_id`;

/**
 * A client reporting that something is wrong with a processed call, and reading
 * what we did about it (migration 0147, doc 36).
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 *
 * `POST /owner/calls/:id/reprocess`, which used to sit on OwnerCallsController.
 * It spent money at the ASR provider on every press and captured nothing about
 * what was actually wrong, so a run that changed nothing was indistinguishable
 * from one that fixed it. Reprocessing is now ours (OperatorOnlyGuard on
 * CallsController) and this is the client's side of the exchange.
 *
 * ── OWNER AND MANAGER, THE SAME AS THE CALL LOG ─────────────────────────────
 *
 * Class-level `owner, manager`, matching OwnerCallsController exactly: you may
 * report a problem with a call if you may see the call, and a telecaller cannot
 * see the log at all (guard-mounting.spec.ts - "a call log is a manager's view
 * of the floor, not a telecaller's view of their own work"). Giving a telecaller
 * a reporting surface is a separate decision about a separate screen, not a
 * quiet widening here.
 *
 * Only `confirm` narrows to owner: accepting the vendor's answer on the
 * business's behalf is the account holder's call, the same split 0122 uses
 * (manager reads the call-access page, owner decides on it).
 *
 * ── NO CALL CONTENT CROSSES THIS BOUNDARY ───────────────────────────────────
 *
 * Nothing written here holds a transcript, a segment, a summary or a presigned
 * URL - only the client's own words plus metadata and digests taken in-database.
 * A platform operator reads this queue without any 0122 grant, so a ticket that
 * carried content would be a side channel around the one control that governs
 * whether the vendor may hear a customer's calls.
 */
@Controller("owner/call-issues")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class OwnerCallIssuesController {
  constructor(private readonly db: DbService) {}

  /**
   * File a report.
   *
   * Everything below happens in ONE transaction - `withOrg` opens it - because
   * the snapshot has to describe the call as it was when the row was written. A
   * snapshot taken by a second statement can disagree with the row that claims
   * to hold it.
   */
  @Post()
  async file(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = FileIssueBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    const reporterId = z.string().uuid().safeParse(req.principal?.userId);
    if (!reporterId.success) {
      // OwnerRoleGuard has already refused a caller with no user behind it, so
      // this is unreachable rather than defensive - but a report has to name who
      // filed it, and "unreachable" is not a reason to write a row that cannot.
      throw new ForbiddenException("a report must name the person filing it");
    }

    return this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }

      // The persona from `memberships`, never from the request: `admin-key.guard`
      // still parses `x-caller-owner-role` into the principal and nothing trusts
      // it any more (see owner-role.guard.ts's header). Same filter
      // `AuthService.ownerRoleFor` uses, including `status = 'active'`.
      const {
        rows: [reporter],
      } = await client.query<{ owner_role: string | null; name: string }>(
        `SELECT m.owner_role, COALESCE(u.name, u.email) AS name
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`,
        [reporterId.data, orgId],
      );
      if (!reporter) throw new ForbiddenException("no active membership in this organisation");

      /*
       * The ceiling, checked here and not by a constraint because it is a POLICY
       * and not an invariant: a tenant sitting at it has a relationship problem
       * rather than a form-submission problem, and the refusal should say so.
       *
       * Two simultaneous filings could both pass this and land on 26. That is
       * accepted: the number is a brake on a runaway script, not a quota, and
       * locking the table to make it exact would serialise every report in the
       * org behind every other.
       */
      const {
        rows: [live],
      } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM call_issue_reports WHERE status = ANY($1::text[])`,
        [[...CALL_ISSUE_LIVE_STATUSES]],
      );
      if (live.n >= MAX_LIVE_CALL_ISSUES_PER_ORG) {
        throw new HttpException(
          `you already have ${live.n} open reports - we will work through those first`,
          429,
        );
      }

      /*
       * One statement: the insert and the snapshot it freezes.
       *
       * The recording and the transcript come through LEFT JOIN LATERAL ... LIMIT
       * 1 rather than a plain LEFT JOIN, and that is not style. Neither table has
       * a unique constraint on `call_id`; a call that somehow held two transcript
       * rows would multiply the SELECT and insert TWO reports from one request.
       *
       * `md5(tr.text)` is taken in the database on purpose - see the column's
       * comment in 0147. The transcript never enters this process.
       */
      let inserted: {
        id: string;
        ref: string;
        status: string;
        reported_at: string;
        snap_call_status: string;
      };
      try {
        const { rows } = await client.query(
          `INSERT INTO call_issue_reports (
             org_id, call_id, category, severity, description, at_seconds,
             reported_by_user_id, reported_by_name, reported_by_role,
             snap_call_status, snap_pipeline_attempts, snap_call_started_at,
             snap_duration_s, snap_direction, snap_device_id, snap_audio_source_used,
             snap_agent_id, snap_agent_version,
             snap_recording_s3_key, snap_recording_bytes, snap_recording_sha256,
             snap_recording_codec, snap_recording_sample_rate,
             snap_asr_engine, snap_asr_language, snap_asr_diarized, snap_asr_confidence,
             snap_transcript_chars, snap_transcript_md5)
           SELECT $1, c.id, $3, $4, $5, $6,
                  $7, $8, $9,
                  c.status, c.pipeline_attempts, c.started_at,
                  c.duration_s, c.direction, c.device_id, c.audio_source_used,
                  c.agent_id, c.agent_version,
                  r.s3_key, r.bytes, r.sha256, r.codec, r.sample_rate,
                  t.engine, t.language, t.diarized, t.confidence,
                  t.text_chars, t.text_md5
             FROM calls c
             LEFT JOIN LATERAL (
               SELECT rec.s3_key, rec.bytes, rec.sha256, rec.codec, rec.sample_rate
                 FROM recordings rec WHERE rec.call_id = c.id
                ORDER BY rec.created_at DESC LIMIT 1
             ) r ON true
             -- The digest and the length are computed INSIDE the lateral, so the
             -- verbatim transcript is never even projected into a row this
             -- statement handles. call-issue-content.spec.ts asserts exactly
             -- that: on these tables a transcript may be MEASURED and DIGESTED
             -- and never selected.
             LEFT JOIN LATERAL (
               SELECT tr.engine, tr.language, tr.diarized, tr.confidence,
                      char_length(tr.text) AS text_chars, md5(tr.text) AS text_md5
                 FROM transcripts tr WHERE tr.call_id = c.id
                ORDER BY tr.created_at DESC LIMIT 1
             ) t ON true
            WHERE c.id = $2
           RETURNING id, ref::text AS ref, status, reported_at, snap_call_status`,
          [
            orgId,
            input.callId,
            input.category,
            input.severity,
            input.description,
            input.atSeconds ?? null,
            reporterId.data,
            reporter.name,
            resolveOwnerRole(reporter.owner_role),
            // $10.. are inside the SELECT above; nothing further is bound.
          ],
        );
        // No row means the WHERE matched nothing: RLS scopes `calls` to this org,
        // so it is either another tenant's call or a deleted one, and both are
        // "not found" from here.
        if (!rows[0]) throw new NotFoundException("call not found");
        inserted = rows[0];
      } catch (err) {
        // Branch on the CONSTRAINT and not on the code. This table has two unique
        // indexes (`ref` and the live-report one) and both raise 23505 - the same
        // trap 0145 fell into, where two different indexes made one error code
        // mean two unrelated things.
        if (isUniqueViolation(err) && violatedConstraint(err) === "call_issue_reports_live") {
          throw new ConflictException(
            "you have already reported this problem with this call - we are looking at it",
          );
        }
        throw err;
      }

      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name, body, meta)
         VALUES ($1, $2, 'filed', 'client', 'user', $3, $4, $5, $6::jsonb)`,
        [
          orgId,
          inserted.id,
          reporterId.data,
          reporter.name,
          input.description,
          JSON.stringify({
            category: input.category,
            severity: input.severity,
            atSeconds: input.atSeconds ?? null,
            callStatus: inserted.snap_call_status,
          }),
        ],
      );

      const actor = auditActor(req);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'call_issue.filed', 'call', $4, $5::jsonb)`,
        [
          orgId,
          actor.type,
          actor.id,
          input.callId,
          JSON.stringify({ reportId: inserted.id, ref: inserted.ref, category: input.category }),
        ],
      );

      return {
        id: inserted.id,
        ref: Number(inserted.ref),
        status: inserted.status,
        reported_at: inserted.reported_at,
      };
    });
  }

  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { state, callId, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${CLIENT_COLUMNS}
           ${CLIENT_FROM}
          WHERE ($1::uuid IS NULL OR r.call_id = $1)
            AND ($2::text = 'all'
                 OR ($2 = 'live' AND r.status = ANY($3::text[]))
                 OR ($2 = 'closed' AND NOT (r.status = ANY($3::text[]))))
          ORDER BY r.reported_at DESC
          LIMIT $4 OFFSET $5`,
        [callId ?? null, state, [...CALL_ISSUE_LIVE_STATUSES], limit, offset],
      );
      const {
        rows: [counts],
      } = await client.query<{ live: number; total: number }>(
        `SELECT count(*) FILTER (WHERE status = ANY($1::text[]))::int AS live,
                count(*)::int AS total
           FROM call_issue_reports`,
        [[...CALL_ISSUE_LIVE_STATUSES]],
      );
      return { reports: rows, live: counts.live, total: counts.total };
    });
  }

  @Get(":id")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [report],
      } = await client.query(
        `SELECT ${CLIENT_COLUMNS} ${CLIENT_FROM} WHERE r.id = $1`,
        [id],
      );
      if (!report) throw new NotFoundException("report not found");

      /*
       * `visibility = 'client'` is the whole of this filter and it is not
       * optional: an operator's internal note ("client is confused, the audio is
       * fine") lives in the same table, and the only thing keeping it out of the
       * customer's console is this predicate. Never widen it to read the timeline
       * "for completeness".
       */
      const { rows: events } = await client.query(
        `SELECT id, kind, actor_type, actor_name, body, meta, created_at
           FROM call_issue_events
          WHERE report_id = $1 AND visibility = 'client'
          ORDER BY created_at`,
        [id],
      );
      return { report, events };
    });
  }

  /** The client answering us. Also un-parks a report that was waiting on them. */
  @Post(":id/replies")
  async reply(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ReplyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success) throw new ForbiddenException("a reply must name its author");

    return this.db.withOrg(orgId, async (client) => {
      const report = await this.liveReport(client, id);
      const {
        rows: [author],
      } = await client.query<{ name: string }>(
        `SELECT COALESCE(u.name, u.email) AS name
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`,
        [userId.data, orgId],
      );
      if (!author) throw new ForbiddenException("no active membership in this organisation");

      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name, body)
         VALUES ($1, $2, 'client_reply', 'client', 'user', $3, $4, $5)`,
        [orgId, id, userId.data, author.name, parsed.data.body],
      );

      // A reply is the answer to a question we asked, so the ball comes back to
      // us. Any other live status is left alone: a client adding detail to a
      // report we have not looked at yet must not make it look started.
      if (report.status === "awaiting_client") {
        await client.query(
          `UPDATE call_issue_reports SET status = 'in_progress', updated_at = now() WHERE id = $1`,
          [id],
        );
      }
      return { ok: true, status: report.status === "awaiting_client" ? "in_progress" : report.status };
    });
  }

  /**
   * The client closing their own report - "never mind, it was our handset".
   *
   * Withdrawing is the client's only terminal move, and the one disposal route
   * they have: they cannot delete a report and neither can we, because a
   * complaint channel whose records the complained-about party can erase is not
   * a channel. `resolution = 'withdrawn'` with no `resolved_by_email` is the
   * shape 0147's CHECK demands - it names nobody on our side, deliberately.
   */
  @Post(":id/withdraw")
  async withdraw(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success) throw new ForbiddenException("withdrawing must name who did it");

    return this.db.withOrg(orgId, async (client) => {
      const report = await this.liveReport(client, id);

      // The reporter, or an owner. A manager may not withdraw a colleague's
      // report: they did not file it and cannot know whether it was answered.
      const ownerRole = await this.ownerRoleOf(client, userId.data, orgId);
      if (report.reported_by_user_id !== userId.data && ownerRole !== "owner") {
        throw new ForbiddenException("only the person who reported this, or the owner, can withdraw it");
      }

      const { rows: names } = await client.query<{ name: string }>(
        `SELECT COALESCE(u.name, u.email) AS name
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`,
        [userId.data, orgId],
      );

      await client.query(
        `UPDATE call_issue_reports
            SET status = 'withdrawn', resolution = 'withdrawn',
                resolved_at = now(), resolved_by_email = NULL, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name)
         VALUES ($1, $2, 'withdrawn', 'client', 'user', $3, $4)`,
        [orgId, id, userId.data, names[0]?.name ?? null],
      );
      const actor = auditActor(req);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'call_issue.withdrawn', 'call', $4, $5::jsonb)`,
        [orgId, actor.type, actor.id, report.call_id, JSON.stringify({ reportId: id })],
      );
      return { ok: true, status: "withdrawn" as const };
    });
  }

  /**
   * The owner accepting our answer.
   *
   * Owner only - the one route here that narrows the class decorator. Accepting
   * the vendor's account of what happened is the account holder's decision, and
   * it is what lets the queue tell "resolved" from "resolved and the customer
   * agrees", which are different facts about how well this worked.
   */
  @Post(":id/confirm")
  @RequireOwnerRole("owner")
  async confirm(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success) throw new ForbiddenException("confirming must name who did it");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [report],
      } = await client.query<{
        call_id: string;
        resolved_at: string | null;
        client_confirmed_at: string | null;
      }>(
        `SELECT call_id, resolved_at, client_confirmed_at FROM call_issue_reports WHERE id = $1`,
        [id],
      );
      if (!report) throw new NotFoundException("report not found");
      if (!report.resolved_at) {
        throw new ConflictException("this report has no answer to accept yet");
      }
      // Idempotent rather than a 409: pressing a button twice is not an error,
      // and the second press must not move the timestamp.
      if (report.client_confirmed_at) return { ok: true, already: true as const };

      const { rows: names } = await client.query<{ name: string }>(
        `SELECT COALESCE(u.name, u.email) AS name
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`,
        [userId.data, orgId],
      );
      await client.query(
        `UPDATE call_issue_reports SET client_confirmed_at = now(), updated_at = now()
          WHERE id = $1 AND client_confirmed_at IS NULL`,
        [id],
      );
      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name)
         VALUES ($1, $2, 'client_confirmed', 'client', 'user', $3, $4)`,
        [orgId, id, userId.data, names[0]?.name ?? null],
      );
      const actor = auditActor(req);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'call_issue.confirmed', 'call', $4, $5::jsonb)`,
        [orgId, actor.type, actor.id, report.call_id, JSON.stringify({ reportId: id })],
      );
      return { ok: true, already: false as const };
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** The report, or the reason it cannot be written to. */
  private async liveReport(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    id: string,
  ): Promise<{ status: string; call_id: string; reported_by_user_id: string | null }> {
    const {
      rows: [report],
    } = await client.query(
      `SELECT status, call_id, reported_by_user_id FROM call_issue_reports WHERE id = $1`,
      [id],
    );
    if (!report) throw new NotFoundException("report not found");
    const status = String(report.status);
    if (!(CALL_ISSUE_LIVE_STATUSES as readonly string[]).includes(status)) {
      throw new ConflictException(`this report is ${status} - reopen it by filing a new one`);
    }
    return {
      status,
      call_id: String(report.call_id),
      reported_by_user_id: (report.reported_by_user_id as string | null) ?? null,
    };
  }

  private async ownerRoleOf(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    userId: string,
    orgId: string,
  ): Promise<string> {
    const {
      rows: [row],
    } = await client.query(
      `SELECT owner_role FROM memberships
        WHERE user_id = $1 AND org_id = $2 AND status = 'active'`,
      [userId, orgId],
    );
    return resolveOwnerRole((row?.owner_role as string | null) ?? null);
  }
}
