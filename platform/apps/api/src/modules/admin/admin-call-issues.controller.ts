import {
  BadRequestException,
  Body,
  ConflictException,
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
import { publishPipeline } from "@aura/queue";
import {
  CALL_ISSUE_LIVE_STATUSES,
  CallIssueCategory,
  CallIssueResolution,
  CallIssueSeverity,
  CallIssueStatus,
  isCallAccessLive,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OperatorOnlyGuard } from "../../common/operator-only.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { rewindForReprocess } from "../calls/reprocess";
import { notify } from "../notifications/notify";

const ListQuery = z.object({
  /** `live` is the work list; the default, because a closed ticket is nobody's job. */
  state: z.enum(["live", "unacknowledged", "mine", "closed", "all"]).default("live"),
  category: CallIssueCategory.optional(),
  severity: CallIssueSeverity.optional(),
  orgId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The triage moves. No `.partial()` anywhere near this: it would keep the
 * `.default()` off a sibling schema and silently rewrite a field the operator
 * never touched (zod-partial-default-trap).
 */
const PatchBody = z
  .object({
    assignedToEmail: z.string().trim().min(3).max(320).nullable().optional(),
    severity: CallIssueSeverity.optional(),
    status: CallIssueStatus.optional(),
    duplicateOf: z.string().uuid().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

const NoteBody = z.object({
  body: z.string().trim().min(1).max(4000),
  /**
   * Defaults to `internal`. The safe default is the one that does not reach the
   * customer: an operator who forgets the flag has written a private note, not
   * published a candid one.
   */
  visibility: z.enum(["internal", "client"]).default("internal"),
});

const ResolveBody = z.object({
  resolution: CallIssueResolution.exclude(["withdrawn"]),
  note: z.string().trim().min(1).max(2000),
});

const ReopenBody = z.object({ note: z.string().trim().min(1).max(2000) });

/**
 * A `withOrg` client, as both this file and `notify()` need it.
 *
 * Spelled out rather than intersecting `Parameters<typeof notify>[0]`: that
 * intersection makes `query` an overload set and TypeScript picks notify's own
 * narrower signature, so `rows` vanishes from a client that certainly has it.
 */
type OrgClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

/** What the queue shows per row. No call content - see the class docblock. */
const QUEUE_COLUMNS = `r.id, r.ref, r.org_id, o.name AS org_name, r.call_id,
       r.category, r.severity, r.status, r.description, r.at_seconds,
       r.reported_by_name, r.reported_by_role, r.reported_at,
       r.acknowledged_at, r.acknowledged_by_email, r.assigned_to_email,
       r.resolution, r.resolved_at, r.resolved_by_email, r.client_confirmed_at,
       r.reprocess_count, r.last_reprocess_at, r.duplicate_of,
       r.snap_call_status, r.snap_call_started_at, r.snap_duration_s, r.snap_direction,
       o.call_access_gate_enabled`;

/**
 * The escalation queue: every tenant's reported call problems, in one place
 * (migration 0147, doc 36 §10).
 *
 * ── WHY THIS IS CROSS-TENANT AND ON THE ADMIN POOL ──────────────────────────
 *
 * The whole point is one work list spanning every customer, so there is no
 * single org context to scope to - the same reason `AdminController` uses the
 * admin pool. Reads run there; WRITES drop into `withOrg(report.org_id)` so that
 * every mutation lands inside the tenant's own RLS context and one transaction,
 * with the cross-tenant lookup reduced to "which org is this ticket in".
 *
 * ── WHAT THIS DOES NOT SEE ──────────────────────────────────────────────────
 *
 * Call CONTENT. Not one route here returns a transcript, a segment, an AI summary
 * or a presigned URL, and the ticket rows hold none. An operator reaching the
 * recording still goes through the eight `@CallContent()` routes and still needs
 * a live 0122 grant from that tenant's own administrator - which `GET :id`
 * reports as `contentAccess` so the console can offer "ask the client" instead of
 * a dead player.
 *
 * These routes deliberately do NOT carry `@CallContent()` themselves. Gating
 * triage on a grant would mean we cannot read a complaint until the customer
 * approves access, which would make the queue unopenable in exactly the orgs that
 * care most. The gate asks who may READ the call; this asks who may see that
 * somebody complained about it.
 *
 * ── EVERY WRITE NAMES AN OPERATOR ───────────────────────────────────────────
 *
 * `x-operator-email` is mandatory on every mutation, for the reason
 * `CallAccessGuard` refuses without it: a resolution nobody's name is on is not a
 * resolution. `OperatorOnlyGuard` has already established that no tenant user is
 * behind the request, so the email is the only identity available.
 */
@Controller("admin/call-issues")
@UseGuards(AdminKeyGuard, TenantGuard, OperatorOnlyGuard)
@CrossTenant()
export class AdminCallIssuesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Req() req: PrincipalRequest, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { state, category, severity, orgId, q, limit, offset } = parsed.data;
    const me = req.principal?.operatorEmail ?? null;

    const { rows } = await this.db.adminPool().query(
      `SELECT ${QUEUE_COLUMNS}
         FROM call_issue_reports r
         JOIN organizations o ON o.id = r.org_id
        WHERE ($1::text = 'all'
               OR ($1 = 'live' AND r.status = ANY($2::text[]))
               OR ($1 = 'unacknowledged' AND r.status = 'open')
               OR ($1 = 'mine' AND r.status = ANY($2::text[])
                   AND lower(btrim(r.assigned_to_email)) = lower(btrim(coalesce($3, ''))))
               OR ($1 = 'closed' AND NOT (r.status = ANY($2::text[]))))
          AND ($4::text IS NULL OR r.category = $4)
          AND ($5::text IS NULL OR r.severity = $5)
          AND ($6::uuid IS NULL OR r.org_id = $6)
          AND ($7::text IS NULL OR r.description ILIKE '%' || $7 || '%'
               OR r.ref::text = $7 OR o.name ILIKE '%' || $7 || '%')
        -- Worst first, then oldest. Severity sorts by MEANING, not alphabetically:
        -- blocking < wrong < minor is not the text order, and sorting by the text
        -- would put 'blocking' after 'minor' and quietly bury the urgent ones.
        ORDER BY CASE r.severity WHEN 'blocking' THEN 0 WHEN 'wrong' THEN 1 ELSE 2 END,
                 r.reported_at
        LIMIT $8 OFFSET $9`,
      [
        state,
        [...CALL_ISSUE_LIVE_STATUSES],
        me,
        category ?? null,
        severity ?? null,
        orgId ?? null,
        q ?? null,
        limit,
        offset,
      ],
    );
    return { reports: rows };
  }

  /**
   * The tiles.
   *
   * One query with FILTER aggregates rather than five round trips: at Mumbai →
   * Seoul latency (prod-latency-root-cause) five sequential counts is half a
   * second of waiting for numbers that must agree with each other anyway.
   */
  @Get("stats")
  async stats() {
    const {
      rows: [row],
    } = await this.db.adminPool().query(
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS unacknowledged,
              count(*) FILTER (WHERE status = ANY($1::text[]))::int AS live,
              count(*) FILTER (WHERE status = ANY($1::text[]) AND severity = 'blocking')::int AS blocking,
              count(*) FILTER (WHERE status = 'awaiting_client')::int AS awaiting_client,
              count(*) FILTER (WHERE resolved_at > now() - interval '7 days')::int AS resolved_7d,
              count(*) FILTER (WHERE resolution = 'reprocessed'
                               AND resolved_at > now() - interval '30 days')::int AS reprocessed_30d,
              -- The oldest thing nobody has acknowledged, in hours. The tile this
              -- feeds is the one that should make somebody open the queue.
              round(EXTRACT(EPOCH FROM (now() - min(reported_at) FILTER (WHERE status = 'open'))) / 3600)::int
                AS oldest_unacknowledged_hours
         FROM call_issue_reports`,
      [[...CALL_ISSUE_LIVE_STATUSES]],
    );
    return row;
  }

  @Get(":id")
  async detail(@Req() req: PrincipalRequest, @Param("id", ParseUUIDPipe) id: string) {
    const {
      rows: [report],
    } = await this.db.adminPool().query(
      `SELECT ${QUEUE_COLUMNS},
              r.snap_pipeline_attempts, r.snap_device_id, r.snap_audio_source_used,
              r.snap_agent_id, r.snap_agent_version,
              r.snap_recording_s3_key, r.snap_recording_bytes, r.snap_recording_sha256,
              r.snap_recording_codec, r.snap_recording_sample_rate,
              r.snap_asr_engine, r.snap_asr_language, r.snap_asr_diarized,
              r.snap_asr_confidence, r.snap_transcript_chars, r.snap_transcript_md5,
              r.access_request_id,
              -- The call AS IT IS NOW, so the console can say whether a reprocess
              -- has moved it since the snapshot was taken.
              c.status AS live_call_status, c.pipeline_attempts AS live_pipeline_attempts
         FROM call_issue_reports r
         JOIN organizations o ON o.id = r.org_id
         JOIN calls c ON c.id = r.call_id
        WHERE r.id = $1`,
      [id],
    );
    if (!report) throw new NotFoundException("report not found");

    // BOTH visibilities - this is the operator's side. The client's own route
    // filters to 'client'; that predicate is the only thing separating the two
    // audiences, so neither route may borrow the other's query.
    const { rows: events } = await this.db.adminPool().query(
      `SELECT id, kind, visibility, actor_type, actor_id, actor_name, body, meta, created_at
         FROM call_issue_events
        WHERE report_id = $1
        ORDER BY created_at`,
      [id],
    );

    return {
      report,
      events,
      contentAccess: await this.contentAccess(
        String(report.org_id),
        Boolean(report.call_access_gate_enabled),
        req.principal?.operatorEmail ?? null,
      ),
    };
  }

  @Patch(":id")
  async patch(
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const operator = this.operatorEmail(req);
    const { orgId, status: current } = await this.locate(id);

    return this.db.withOrg(orgId, async (client) => {
      if (input.status && input.status !== current) {
        this.assertTransition(current, input.status);
      }

      /*
       * Acknowledging is a side effect of the first move rather than its own
       * route: whichever action an operator takes first, the customer's question
       * "has anybody looked at this" is answered by it. 0147's
       * `call_issue_open_is_untouched` CHECK also refuses an assignment on a row
       * still calling itself 'open', so this is not optional.
       */
      const nextStatus =
        input.status ?? (current === "open" && (input.assignedToEmail || input.severity)
          ? "acknowledged"
          : current);
      const acknowledging = current === "open" && nextStatus !== "open";

      const { rows } = await client.query(
        `UPDATE call_issue_reports
            SET status = $2,
                assigned_to_email = COALESCE($3, assigned_to_email),
                severity = COALESCE($4, severity),
                duplicate_of = CASE WHEN $2 = 'duplicate' THEN $5 ELSE NULL END,
                resolution = CASE WHEN $2 = 'duplicate' THEN 'duplicate'
                                  WHEN $2 = ANY($8::text[]) THEN resolution
                                  ELSE NULL END,
                resolved_at = CASE WHEN $2 = 'duplicate' THEN now()
                                   WHEN $2 = ANY($8::text[]) THEN resolved_at
                                   ELSE NULL END,
                resolved_by_email = CASE WHEN $2 = 'duplicate' THEN $6
                                        WHEN $2 = ANY($8::text[]) THEN resolved_by_email
                                        ELSE NULL END,
                acknowledged_at = COALESCE(acknowledged_at, CASE WHEN $7 THEN now() END),
                acknowledged_by_email = COALESCE(acknowledged_by_email, CASE WHEN $7 THEN $6 END),
                updated_at = now()
          WHERE id = $1
         RETURNING status, assigned_to_email, severity`,
        [
          id,
          nextStatus,
          input.assignedToEmail ?? null,
          input.severity ?? null,
          input.duplicateOf ?? null,
          operator,
          acknowledging,
          ["resolved", "rejected", "withdrawn"],
        ],
      );

      const events: Array<[string, Record<string, unknown>]> = [];
      if (acknowledging) events.push(["acknowledged", {}]);
      if (input.assignedToEmail !== undefined)
        events.push(["assigned", { to: input.assignedToEmail }]);
      if (input.severity) events.push(["severity_changed", { to: input.severity }]);
      if (input.status && input.status !== current)
        events.push(["status_changed", { from: current, to: input.status }]);
      for (const [kind, meta] of events) {
        await client.query(
          `INSERT INTO call_issue_events
             (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name, meta)
           VALUES ($1, $2, $3, $4, 'operator', $5, $5, $6::jsonb)`,
          [
            orgId,
            id,
            kind,
            // The customer is told it was seen and where it stands. Who it was
            // assigned to, and how we grade it, are ours.
            kind === "acknowledged" || kind === "status_changed" ? "client" : "internal",
            operator,
            JSON.stringify(meta),
          ],
        );
      }

      if (acknowledging || (input.status && input.status !== current)) {
        await this.tellTheClient(client, orgId, id, "We have an update on the problem you reported.");
      }
      return rows[0];
    });
  }

  @Post(":id/notes")
  async note(
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = NoteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const operator = this.operatorEmail(req);
    const { orgId } = await this.locate(id);

    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name, body)
         VALUES ($1, $2, 'note', $3, 'operator', $4, $4, $5)`,
        [orgId, id, parsed.data.visibility, operator, parsed.data.body],
      );
      // A note the customer can see is a message to them; an internal one is not,
      // and ringing their bell for it would tell them something happened without
      // being able to say what.
      if (parsed.data.visibility === "client") {
        await client.query(
          `UPDATE call_issue_reports
              SET status = 'awaiting_client', updated_at = now()
            WHERE id = $1 AND status = ANY($2::text[]) AND status <> 'awaiting_client'`,
          [id, [...CALL_ISSUE_LIVE_STATUSES]],
        );
        await this.tellTheClient(client, orgId, id, "Our team replied about a problem you reported.");
      }
      return { ok: true };
    });
  }

  /**
   * Re-run the call from its ticket.
   *
   * The one remaining door to a reprocess that a person walks through, and the
   * reason the client's button could be taken away: here the spend is a decision
   * somebody makes with the complaint in front of them, against a snapshot that
   * can say whether a second run could plausibly differ at all.
   */
  @Post(":id/reprocess")
  async reprocess(@Req() req: PrincipalRequest, @Param("id", ParseUUIDPipe) id: string) {
    const operator = this.operatorEmail(req);
    const { orgId, callId, status, ref } = await this.locate(id);
    if (!(CALL_ISSUE_LIVE_STATUSES as readonly string[]).includes(status)) {
      throw new ConflictException(`this report is ${status} - reopen it before re-running the call`);
    }

    const result = await this.db.withOrg(orgId, async (client) => {
      const { from } = await rewindForReprocess(client, {
        orgId,
        callId,
        actor: auditActor(req),
        meta: { reportId: id, ref, via: "escalation-queue" },
      });

      await client.query(
        `UPDATE call_issue_reports
            SET reprocess_count = reprocess_count + 1,
                last_reprocess_at = now(),
                status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
                acknowledged_at = COALESCE(acknowledged_at, now()),
                acknowledged_by_email = COALESCE(acknowledged_by_email, $2),
                updated_at = now()
          WHERE id = $1`,
        [id, operator],
      );
      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name, meta)
         VALUES ($1, $2, 'reprocess_queued', 'client', 'operator', $3, $3, $4::jsonb)`,
        [orgId, id, operator, JSON.stringify({ fromStatus: from })],
      );
      await this.tellTheClient(
        client,
        orgId,
        id,
        "We are re-running the call you reported a problem with.",
      );
      return { from };
    });

    // After the commit, never inside it: the DB flip is the source of truth and
    // the queue is only a wake-up.
    await publishPipeline({ callId, orgId });
    return { ok: true, from: result.from, status: "UPLOADED" as const };
  }

  @Post(":id/resolve")
  async resolve(
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ResolveBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const operator = this.operatorEmail(req);
    const { orgId, callId, status } = await this.locate(id);
    if (!(CALL_ISSUE_LIVE_STATUSES as readonly string[]).includes(status)) {
      throw new ConflictException(`this report is already ${status}`);
    }

    return this.db.withOrg(orgId, async (client) => {
      // `rejected` rather than `resolved` when we are declining it: the customer
      // reads the resolution, and calling "we are not changing this" a resolution
      // is the kind of wording that makes people stop reporting things.
      const declined =
        parsed.data.resolution === "working_as_intended" ||
        parsed.data.resolution === "not_reproducible" ||
        parsed.data.resolution === "client_error";

      await client.query(
        `UPDATE call_issue_reports
            SET status = $2, resolution = $3, resolution_note = $4,
                resolved_at = now(), resolved_by_email = $5,
                acknowledged_at = COALESCE(acknowledged_at, now()),
                acknowledged_by_email = COALESCE(acknowledged_by_email, $5),
                updated_at = now()
          WHERE id = $1`,
        [id, declined ? "rejected" : "resolved", parsed.data.resolution, parsed.data.note, operator],
      );
      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name, body, meta)
         VALUES ($1, $2, $3, 'client', 'operator', $4, $4, $5, $6::jsonb)`,
        [
          orgId,
          id,
          declined ? "rejected" : "resolved",
          operator,
          parsed.data.note,
          JSON.stringify({ resolution: parsed.data.resolution }),
        ],
      );
      const actor = auditActor(req);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'call_issue.resolved', 'call', $4, $5::jsonb)`,
        [
          orgId,
          actor.type,
          actor.id,
          callId,
          JSON.stringify({ reportId: id, resolution: parsed.data.resolution }),
        ],
      );
      await this.tellTheClient(
        client,
        orgId,
        id,
        declined
          ? "We have answered the problem you reported."
          : "The problem you reported has been fixed.",
      );
      return { ok: true, status: declined ? "rejected" : "resolved" };
    });
  }

  /** Undo a wrong answer. The trail keeps both, which is the point. */
  @Post(":id/reopen")
  async reopen(
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ReopenBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const operator = this.operatorEmail(req);
    const { orgId, status } = await this.locate(id);
    if ((CALL_ISSUE_LIVE_STATUSES as readonly string[]).includes(status)) {
      throw new ConflictException("this report is already open");
    }
    if (status === "withdrawn") {
      // The client closed it. Re-opening on their behalf would put words in their
      // mouth; they can file again, and that new report is honestly theirs.
      throw new ConflictException("the client withdrew this report - it is not ours to reopen");
    }

    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE call_issue_reports
            SET status = 'in_progress', resolution = NULL, resolution_note = NULL,
                resolved_at = NULL, resolved_by_email = NULL,
                duplicate_of = NULL, client_confirmed_at = NULL, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name, body)
         VALUES ($1, $2, 'reopened', 'client', 'operator', $3, $3, $4)`,
        [orgId, id, operator, parsed.data.note],
      );
      await this.tellTheClient(client, orgId, id, "We have reopened a problem you reported.");
      return { ok: true, status: "in_progress" as const };
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Which org a ticket belongs to, on the admin pool - the one genuinely
   * cross-tenant read every write needs before it can enter an org's context.
   */
  private async locate(
    id: string,
  ): Promise<{ orgId: string; callId: string; status: string; ref: string }> {
    const {
      rows: [row],
    } = await this.db
      .adminPool()
      .query(
        `SELECT org_id, call_id, status, ref::text AS ref FROM call_issue_reports WHERE id = $1`,
        [id],
      );
    if (!row) throw new NotFoundException("report not found");
    return {
      orgId: String(row.org_id),
      callId: String(row.call_id),
      status: String(row.status),
      ref: String(row.ref),
    };
  }

  private operatorEmail(req: PrincipalRequest): string {
    const email = req.principal?.operatorEmail;
    if (!email) {
      // The same refusal `CallAccessGuard` makes, for the same reason: a decision
      // about somebody else's customer that names nobody cannot be answered for
      // later.
      throw new ForbiddenException(
        "this request does not say which operator is acting - use the operator console",
      );
    }
    return email;
  }

  /**
   * Legal moves only. A status machine enforced in one place beats a set of
   * routes that each allow a slightly different subset - and the DB's CHECKs
   * cannot express ORDER, only shape.
   */
  private assertTransition(from: string, to: string): void {
    const live = CALL_ISSUE_LIVE_STATUSES as readonly string[];
    if (to === "withdrawn") {
      throw new ForbiddenException("only the client can withdraw their own report");
    }
    if (!live.includes(from)) {
      throw new ConflictException(`this report is ${from} - reopen it before changing its status`);
    }
    if (!live.includes(to) && to !== "duplicate") {
      throw new ConflictException(`use the resolve route to close a report as ${to}`);
    }
  }

  /**
   * Whether this operator may currently read that org's call content.
   *
   * Mirrors `CallAccessGuard`'s own lookup deliberately - approved rows only,
   * newest WINDOW first (`granted_end`, not `created_at`, because an older
   * request may have been approved for a later window). Duplicated rather than
   * shared because the guard's job is to refuse and this one's is to describe;
   * a helper that did both would be one edit away from the console reporting
   * access the guard does not actually grant.
   */
  private async contentAccess(
    orgId: string,
    gateEnabled: boolean,
    operatorEmail: string | null,
  ): Promise<{
    gateEnabled: boolean;
    live: boolean;
    grantEndsAt: string | null;
    requestId: string | null;
  }> {
    if (!gateEnabled) return { gateEnabled: false, live: true, grantEndsAt: null, requestId: null };
    if (!operatorEmail) return { gateEnabled: true, live: false, grantEndsAt: null, requestId: null };

    const {
      rows: [grant],
    } = await this.db.adminPool().query(
      `SELECT id, status, granted_start, granted_end
         FROM call_access_requests
        WHERE org_id = $1
          AND lower(btrim(requested_by_email)) = lower(btrim($2))
          AND status = 'approved'
        ORDER BY granted_end DESC
        LIMIT 1`,
      [orgId, operatorEmail],
    );
    const live = grant
      ? isCallAccessLive(
          {
            status: grant.status as "approved",
            grantedStart: grant.granted_start as Date | null,
            grantedEnd: grant.granted_end as Date | null,
          },
          new Date(),
        )
      : false;
    return {
      gateEnabled: true,
      live,
      grantEndsAt: live ? String(grant.granted_end) : null,
      requestId: grant ? String(grant.id) : null,
    };
  }

  /**
   * Ring the reporter's bell.
   *
   * One kind for the whole thread, deduped on the report's current status, so
   * five internal notes do not produce five bells - and addressed to whoever
   * filed it, falling back to every `owner` persona when that person has since
   * left. Runs inside the caller's org transaction, so a failed notify rolls the
   * decision back with it rather than leaving a silent resolution.
   */
  private async tellTheClient(
    client: OrgClient,
    orgId: string,
    reportId: string,
    title: string,
  ): Promise<void> {
    const {
      rows: [report],
    } = await client.query(
      `SELECT ref::text AS ref, status, reported_by_user_id FROM call_issue_reports WHERE id = $1`,
      [reportId],
    );
    if (!report) return;

    const recipients: string[] = [];
    if (report.reported_by_user_id) {
      recipients.push(String(report.reported_by_user_id));
    } else {
      const { rows } = await client.query(
        // COALESCE: a null persona IS the owner persona (resolveOwnerRole), and
        // the operator console's member writer never sets that column. This is
        // the fallback for a reporter who has since left, so `owner_role =
        // 'owner'` meant the answer to their ticket reached nobody at all.
        `SELECT user_id FROM memberships
          WHERE org_id = $1 AND COALESCE(owner_role, 'owner') = 'owner' AND status = 'active'`,
        [orgId],
      );
      recipients.push(...rows.map((r) => String(r.user_id)));
    }

    for (const userId of recipients) {
      await notify(client, orgId, {
        userId,
        kind: "call_issue_update",
        title,
        body: `Report AUR-${String(report.ref).padStart(6, "0")}`,
        linkPath: "/owner/call-issues",
        dedupeKey: `call_issue:${reportId}:${String(report.status)}`,
      });
    }
  }
}
