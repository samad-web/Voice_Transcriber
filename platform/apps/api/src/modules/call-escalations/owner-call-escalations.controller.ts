import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
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
  CALL_ESCALATION_STATUS_LABELS,
  CallEscalationListQuery,
  canReceiveEscalation,
  ESCALATION_POOL_LABEL,
  ForwardCallEscalationInput,
  isLiveEscalation,
  RaiseCallEscalationInput,
  ResolveCallEscalationInput,
  type CallEscalationDetail,
  type EscalationTargetCandidate,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerScope, type OwnerRecordScope } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  CallEscalationsService,
  escalationPermissions,
  escalationVisibleSql,
  type EscalationViewer,
  loadRaiseContext,
  type Queryable,
  type TransitionKind,
  userNameSql,
} from "./call-escalations.service";

/** The CHECK on `call_escalations.forward_count`. */
const MAX_FORWARDS = 50;

const DISABLED = {
  code: "escalation_disabled",
  message: "Escalations are switched off for this workspace. Handle the call yourself, or ask an owner to switch them on.",
};
const NOT_A_TELECALLER = {
  code: "not_a_telecaller",
  message: "Only the telecaller who took a call can escalate it.",
};
const NOT_YOURS = {
  code: "not_yours",
  message: "This escalation is with someone else. Only they, or an owner or manager, can act on it.",
};

/**
 * The console's side of call escalations (migration 0151, Build docs/38).
 *
 * ── NO CLASS-LEVEL PERSONA ──────────────────────────────────────────────────
 *
 * OwnerScopeGuard, not OwnerRoleGuard: every persona has a reason to be here
 * (a telecaller raising and withdrawing, a senior answering, an owner or
 * manager running the queue), so access is decided PER ROW in SQL
 * (`escalationVisibleSql`) and per step (`escalationPermissions`):
 *
 *  - owner / manager: see every escalation in the org, act on any live one;
 *  - anyone else: see one assigned to one of their memberships, raised by their
 *    telecaller identity, or one they acted on - and act only on what is
 *    assigned to them;
 *  - withdraw: only the raiser, while it is live.
 *
 * An escalation the viewer may not see is a 404, never a 403, so the route
 * does not confirm it exists.
 *
 * ── A PERSON, ALWAYS ────────────────────────────────────────────────────────
 *
 * Every route needs a real `users.id` with a membership in this org (403
 * otherwise). That refuses the bare admin key, so a platform operator cannot
 * read the queue - or, through `:id/call`, a call - from here; the 0122 gate
 * stays the only way an operator reads call content.
 *
 * The workspace switch only stops NEW escalations (403 escalation_disabled).
 * Live ones stay answerable after it is switched off, so turning it off
 * strands nobody.
 */
@Controller("owner/call-escalations")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerScopeGuard)
export class OwnerCallEscalationsController {
  constructor(
    private readonly db: DbService,
    private readonly escalations: CallEscalationsService,
  ) {}

  /**
   * Escalate one of the viewer's own calls (the lead drawer's Escalate button).
   * A second press while one is live returns it with `duplicate: true`.
   */
  @Post()
  async raise(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @OwnerScope() scope: OwnerRecordScope,
    @Body() body: unknown,
  ): Promise<{ escalation: CallEscalationDetail; duplicate: boolean }> {
    const viewer = this.viewer(req, scope);
    const parsed = RaiseCallEscalationInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const telecallerId = viewer.telecallerId;
    if (!telecallerId) throw new ForbiddenException(NOT_A_TELECALLER);
    const actor = auditActor(req);

    const out = await this.db.withOrg(orgId, async (client) => {
      const ctx = await loadRaiseContext(
        client,
        { kind: "console", orgId, telecallerId, userId: viewer.userId },
        input.callId,
      );
      if (!ctx) throw new NotFoundException("organization not found");
      if (ctx.enabled !== true) throw new ForbiddenException(DISABLED);
      if (!ctx.tc_id) throw new ForbiddenException(NOT_A_TELECALLER);
      // The call must be the viewer's own - 404 rather than 403 either way, so
      // a colleague's call id confirms nothing.
      if (!ctx.call_found || ctx.call_telecaller_id !== ctx.tc_id) {
        throw new NotFoundException({ code: "call_not_found", message: "That call is not one of yours." });
      }

      const r = await this.escalations.raise(client, {
        ctx,
        orgId,
        callId: input.callId,
        reason: input.reason,
        note: input.note?.trim() || null,
        source: "console",
        deviceId: null,
        clientRef: null,
        raisedByUserId: viewer.userId,
        // The name the floor knows them by, as the phone writes it.
        actorName: ctx.tc_name ?? ctx.actor_name ?? "A telecaller",
        audit: { type: actor.type, id: actor.id },
      });
      const escalation = await this.escalations.readDetail(client, r.id, viewer);
      if (!escalation) throw new NotFoundException("escalation not found");
      return { escalation, duplicate: r.duplicate, tokens: r.tokens };
    });

    this.escalations.pushAlerts(out.tokens);
    return { escalation: out.escalation, duplicate: out.duplicate };
  }

  /** The queue: what the viewer may see, plus the live counts for the nav badge. */
  @Get()
  async list(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @OwnerScope() scope: OwnerRecordScope,
    @Query() query: unknown,
  ) {
    const viewer = this.viewer(req, scope);
    const parsed = CallEscalationListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.db.withOrg(orgId, (client) => this.escalations.readList(client, viewer, parsed.data));
  }

  @Get(":id")
  async detail(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @OwnerScope() scope: OwnerRecordScope,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CallEscalationDetail> {
    const viewer = this.viewer(req, scope);
    const escalation = await this.db.withOrg(orgId, (client) => this.escalations.readDetail(client, id, viewer));
    if (!escalation) throw new NotFoundException("escalation not found");
    return escalation;
  }

  /**
   * The escalated call, for the drawer: the same `{call, transcript, analytics,
   * transcriptRedacted}` shape as GET /leads/:id/calls/:callId, under the same
   * two gates - the `call_intel` module (403 without it) and the READER's own
   * `memberships.recordings_listen` (the verbatim text and segments are
   * redacted without it; the AI read still comes back).
   *
   * Anyone who can see the escalation may read its call: a senior asked to
   * answer one cannot do it blind.
   *
   * ONE statement: the module, the reader's grant, the visibility check, the
   * call, its transcript and its analytics. The transcript text is withheld IN
   * SQL when the reader may not have it, so it never reaches this process.
   */
  @Get(":id/call")
  async call(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @OwnerScope() scope: OwnerRecordScope,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const viewer = this.viewer(req, scope);
    const row = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [r],
      } = await client.query<CallReadRow>(
        `WITH ctx AS (
           -- org-modules.ts's predicate, folded in rather than a round trip of its own.
           SELECT ('call_intel' = ANY(o.enabled_modules)) AS intel,
                  COALESCE((SELECT m.recordings_listen FROM memberships m
                             WHERE m.user_id = $2::uuid AND m.org_id = o.id
                             ORDER BY (m.scope_type = 'org') DESC, m.id LIMIT 1), false) AS can_read
             FROM organizations o
            WHERE o.id = $3::uuid
         )
         SELECT ctx.intel, ctx.can_read, e.id AS escalation_id,
                c.id, c.direction, c.started_at, c.duration_s, c.status,
                COALESCE(d.telecaller_name, d.label) AS telecaller,
                tr.found AS has_transcript, tr.language, tr.engine, tr.diarized,
                CASE WHEN ctx.can_read THEN tr.text END AS text,
                CASE WHEN ctx.can_read THEN tr.segments END AS segments,
                tr.intelligence,
                an.found AS has_analytics, an.quality_score, an.quality_criteria, an.talk_ratio,
                an.agent_talk_seconds, an.customer_talk_seconds, an.interruption_count,
                an.risk_flags, an.has_escalation_risk
           FROM ctx
           LEFT JOIN call_escalations e
             ON e.id = $1::uuid AND ${escalationVisibleSql("e", "$2::uuid", viewer.admin)}
           LEFT JOIN calls c ON c.id = e.call_id
           LEFT JOIN devices d ON d.id = c.device_id
           -- LATERAL ... LIMIT 1 for the reason leads.controller.ts gives: a
           -- second transcript row must never duplicate the call.
           LEFT JOIN LATERAL (
             SELECT true AS found, tx.language, tx.engine, tx.diarized, tx.text, tx.segments, tx.intelligence
               FROM transcripts tx WHERE tx.call_id = c.id AND ctx.intel LIMIT 1
           ) tr ON true
           LEFT JOIN LATERAL (
             SELECT true AS found, a.quality_score, a.quality_criteria, a.talk_ratio, a.agent_talk_seconds,
                    a.customer_talk_seconds, a.interruption_count, a.risk_flags, a.has_escalation_risk
               FROM call_analytics a WHERE a.call_id = c.id AND ctx.intel LIMIT 1
           ) an ON true`,
        [id, viewer.userId, orgId],
      );
      return r ?? null;
    });

    if (!row) throw new NotFoundException("organization not found");
    if (row.intel !== true) throw new ForbiddenException("call intelligence is not enabled for this instance");
    if (!row.escalation_id || !row.id) throw new NotFoundException("escalation not found");

    return {
      call: {
        id: row.id,
        direction: row.direction,
        started_at: row.started_at,
        duration_s: row.duration_s,
        status: row.status,
        telecaller: row.telecaller,
      },
      transcript: row.has_transcript
        ? {
            language: row.language,
            engine: row.engine,
            diarized: row.diarized,
            text: row.text,
            segments: row.segments,
            intelligence: row.intelligence,
          }
        : null,
      analytics: row.has_analytics
        ? {
            quality_score: row.quality_score,
            quality_criteria: row.quality_criteria,
            talk_ratio: row.talk_ratio,
            agent_talk_seconds: row.agent_talk_seconds,
            customer_talk_seconds: row.customer_talk_seconds,
            interruption_count: row.interruption_count,
            risk_flags: row.risk_flags,
            has_escalation_risk: row.has_escalation_risk,
          }
        : null,
      transcriptRedacted: row.can_read !== true,
    };
  }

  /** "I'm on it." */
  @Post(":id/acknowledge")
  @HttpCode(200)
  acknowledge(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @OwnerScope() scope: OwnerRecordScope,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.step(req, orgId, scope, id, "acknowledged", undefined);
  }

  /** Answered, with an optional note that goes back to the telecaller's phone. */
  @Post(":id/resolve")
  @HttpCode(200)
  resolve(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @OwnerScope() scope: OwnerRecordScope,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.step(req, orgId, scope, id, "resolved", body);
  }

  /** Pass it up: to a chosen owner, manager or senior, or to the pool (`toMembershipId: null`). */
  @Post(":id/forward")
  @HttpCode(200)
  forward(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @OwnerScope() scope: OwnerRecordScope,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.step(req, orgId, scope, id, "forwarded", body);
  }

  /** The raiser takes it back before anyone answers. */
  @Post(":id/withdraw")
  @HttpCode(200)
  withdraw(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @OwnerScope() scope: OwnerRecordScope,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.step(req, orgId, scope, id, "withdrawn", undefined);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Every step: lock the row the viewer can see, decide, write the row + its
   * history + its audit row, tell whoever needs telling, and read it back - one
   * transaction. Pushes go out after commit.
   */
  private async step(
    req: PrincipalRequest,
    orgId: string,
    scope: OwnerRecordScope,
    id: string,
    kind: TransitionKind,
    body: unknown,
  ): Promise<{ escalation: CallEscalationDetail }> {
    const viewer = this.viewer(req, scope);
    let resolutionNote: string | null = null;
    let forward: { toMembershipId: string | null; note: string | null } | null = null;
    if (kind === "resolved") {
      const parsed = ResolveCallEscalationInput.safeParse(body ?? {});
      if (!parsed.success) throw new BadRequestException(parsed.error.issues);
      resolutionNote = parsed.data.note?.trim() || null;
    } else if (kind === "forwarded") {
      const parsed = ForwardCallEscalationInput.safeParse(body);
      if (!parsed.success) throw new BadRequestException(parsed.error.issues);
      forward = { toMembershipId: parsed.data.toMembershipId, note: parsed.data.note?.trim() || null };
    }
    const actor = auditActor(req);
    const audit = (meta: Record<string, unknown>) => ({ type: actor.type, id: actor.id, meta });

    const out = await this.db.withOrg(orgId, async (client) => {
      const cur = await this.escalations.lockForAction(client, id, viewer);
      if (!cur) throw new NotFoundException("escalation not found");
      if (!isLiveEscalation(cur.status)) {
        throw new ConflictException({
          code: "not_live",
          message: `This escalation is already ${CALL_ESCALATION_STATUS_LABELS[cur.status].toLowerCase()}.`,
        });
      }
      const perms = escalationPermissions(cur.status, viewer.admin, {
        assignedToMe: cur.assigned_to_me === true,
        raisedByMe: cur.raised_by_me === true,
      });
      const actorName = cur.viewer_name ?? "Someone";
      const raiserUserId = cur.raised_by_user_id ?? cur.tc_user_id;
      let tokens: string[] = [];

      if (kind === "withdrawn") {
        if (!perms.canWithdraw) {
          throw new ForbiddenException({ code: "not_raiser", message: "Only the telecaller who raised it can withdraw it." });
        }
        await this.escalations.transition(client, {
          id,
          kind,
          actorUserId: viewer.userId,
          actorName,
          audit: audit({ previousStatus: cur.status }),
        });
      } else {
        if (!perms.canAct) throw new ForbiddenException(NOT_YOURS);

        if (kind === "acknowledged") {
          if (cur.status === "acknowledged") {
            throw new ConflictException({
              code: "already_acknowledged",
              message: `${cur.acknowledged_by_name ?? "Someone"} has already picked this up.`,
            });
          }
          await this.escalations.transition(client, {
            id,
            kind,
            actorUserId: viewer.userId,
            actorName,
            audit: audit({}),
          });
        } else if (kind === "resolved") {
          await this.escalations.transition(client, {
            id,
            kind,
            actorUserId: viewer.userId,
            actorName,
            note: resolutionNote,
            value: resolutionNote,
            audit: audit({ previousStatus: cur.status, withNote: resolutionNote !== null }),
          });
          tokens = await this.escalations.deliverResolution(client, orgId, {
            escalationId: id,
            // The bell only for a raiser who can open the console; most
            // telecallers have a phone and nothing else.
            raiserUserId: cur.raiser_has_login ? raiserUserId : null,
            telecallerId: cur.telecaller_id,
            telecallerUserId: cur.tc_user_id,
            resolverUserId: viewer.userId,
            resolverName: actorName,
            reason: cur.reason,
            customerLabel: cur.customer_label,
            note: resolutionNote,
            callId: cur.call_id,
          });
        } else if (kind === "forwarded" && forward) {
          if (Number(cur.forward_count) >= MAX_FORWARDS) {
            throw new ConflictException({
              code: "too_many_forwards",
              message: "This escalation has been passed on too many times. Answer it, or ask the telecaller to raise a new one.",
            });
          }
          let toName = ESCALATION_POOL_LABEL;
          if (forward.toMembershipId) {
            const target = await this.forwardTarget(client, forward.toMembershipId);
            if (
              !target ||
              !canReceiveEscalation(target, raiserUserId) ||
              target.userId === viewer.userId ||
              target.membershipId === cur.assigned_membership_id
            ) {
              throw new BadRequestException({
                code: "invalid_target",
                message: "That person can't receive this escalation. Choose an active owner, manager or senior - not yourself or the telecaller who raised it.",
              });
            }
            toName = target.name;
          }
          const moved = await this.escalations.transition(client, {
            id,
            kind,
            actorUserId: viewer.userId,
            actorName,
            toMembershipId: forward.toMembershipId,
            toName,
            note: forward.note,
            value: forward.toMembershipId,
            audit: audit({ from: cur.assigned_membership_id, to: forward.toMembershipId }),
          });
          tokens = await this.escalations.deliverAssignment(client, orgId, {
            escalationId: id,
            forwardCount: moved.forward_count,
            assignedMembershipId: forward.toMembershipId,
            exclude: [cur.raised_by_user_id, cur.tc_user_id],
            actorUserId: viewer.userId,
            event: "forwarded",
            telecallerName: cur.telecaller_name ?? "A telecaller",
            actorName,
            reason: cur.reason,
            customerLabel: cur.customer_label,
            note: forward.note,
            callId: cur.call_id,
          });
        }
      }

      const escalation = await this.escalations.readDetail(client, id, viewer);
      if (!escalation) throw new NotFoundException("escalation not found");
      return { escalation, tokens };
    });

    this.escalations.pushAlerts(out.tokens);
    return { escalation: out.escalation };
  }

  /** A forward target as `canReceiveEscalation` judges it, plus its name. */
  private async forwardTarget(
    client: Queryable,
    membershipId: string,
  ): Promise<(EscalationTargetCandidate & { name: string }) | null> {
    const {
      rows: [m],
    } = await client.query<{
      id: string;
      user_id: string;
      owner_role: string | null;
      status: string;
      user_status: string;
      escalation_senior: boolean;
      name: string | null;
    }>(
      `SELECT m.id, m.user_id, m.owner_role, m.status, u.status AS user_status, m.escalation_senior,
              ${userNameSql("u")} AS name
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.id = $1::uuid`,
      [membershipId],
    );
    if (!m) return null;
    return {
      membershipId: m.id,
      userId: m.user_id,
      ownerRole: m.owner_role,
      status: m.status,
      userStatus: m.user_status,
      senior: m.escalation_senior === true,
      name: m.name ?? "A colleague",
    };
  }

  /**
   * The viewer, from the principal and OwnerScopeGuard's answer - which read
   * the persona from `memberships`, never from a header. No resolvable user,
   * or no membership in this org (the guard's unscoped fallbacks), is a 403.
   */
  private viewer(req: PrincipalRequest, scope: OwnerRecordScope): EscalationViewer {
    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success || !scope.userId || scope.userId !== userId.data) {
      throw new ForbiddenException("escalations need a signed-in member of this workspace");
    }
    return {
      userId: userId.data,
      admin: scope.role === "owner" || scope.role === "manager",
      telecallerId: scope.telecallerId,
    };
  }
}

interface CallReadRow {
  intel: boolean | null;
  can_read: boolean | null;
  escalation_id: string | null;
  id: string | null;
  direction: string | null;
  started_at: Date | null;
  duration_s: number | null;
  status: string | null;
  telecaller: string | null;
  has_transcript: boolean | null;
  language: string | null;
  engine: string | null;
  diarized: boolean | null;
  text: string | null;
  segments: unknown;
  intelligence: unknown;
  has_analytics: boolean | null;
  quality_score: unknown;
  quality_criteria: unknown;
  talk_ratio: unknown;
  agent_talk_seconds: unknown;
  customer_talk_seconds: unknown;
  interruption_count: unknown;
  risk_flags: unknown;
  has_escalation_risk: unknown;
}
