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
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { publishPipeline } from "@aura/queue";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { orgHasModule } from "../../common/org-modules";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";
import { AgentsService, replyDrafterActive } from "../agents/agents.service";

const CreateNoteBody = z.object({
  body: z.string().min(1).max(10000),
});

const ListQuery = z.object({
  /**
   * The three buckets the operator explorer uses, kept identical so the same
   * call is never "failed" on one screen and "in progress" on the other.
   * TRANSCRIPTION_OFF is terminal by choice and belongs in neither.
   */
  state: z.enum(["complete", "in_pipeline", "failed"]).optional(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
  sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
  /** The handset, not the person - `devices.id`, as the dashboard ranks them. */
  deviceId: z.string().uuid().optional(),
  /**
   * Free text over the contact and the AI SUMMARY - deliberately not over the
   * transcript. A reader without `recordings_listen` may not read the verbatim
   * text, and a search that matched it would report its contents by telling
   * them which calls contain a phrase.
   */
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The AI read, per call. Shared by the list and the detail so a call cannot
 * describe itself differently depending on which one you asked.
 */
const READ_JOIN = `
  LEFT JOIN LATERAL (
    SELECT t.intelligence ->> 'overall_intent' AS intent,
           t.intelligence ->> 'sentiment'      AS sentiment,
           t.intelligence ->> 'outcome'        AS outcome,
           t.intelligence ->> 'summary'        AS summary,
           (t.text IS NOT NULL OR t.segments IS NOT NULL) AS has_transcript
      FROM transcripts t
     WHERE t.call_id = c.id
     LIMIT 1
  ) ci ON true
  LEFT JOIN LATERAL (
    SELECT a.quality_score FROM call_analytics a WHERE a.call_id = c.id LIMIT 1
  ) ca ON true`;

/**
 * The lead this call was about.
 *
 * A plain join on `calls.lead_id` since migration 0094. It used to be a
 * LATERAL over first_call_id/last_call_id, which could only ever find the
 * lead a call CREATED - so a call to a lead that arrived from a web form, a
 * Meta ad or an import showed no lead at all, however many times it was rung.
 * 0094 links by number hash instead, and the column it fills is authoritative:
 * one lead per call, or none, with no ordering rule to pick between candidates.
 */
const LEAD_JOIN = `
  LEFT JOIN leads lead ON lead.id = c.lead_id`;

/**
 * The client's own call log (`call_intel` module, org-modules.ts).
 *
 * WHY THIS IS NOT `GET /v1/calls`. The operator explorer's list is built for
 * the platform: it joins `instances` because its whole job is answering "what
 * did THIS customer record" across tenants, and it carries pipeline internals -
 * attempt counts, next_attempt_at, error_message, consent status - that are
 * ours to act on, not a client's to interpret. A client wants the opposite
 * shape: their own calls, what each one was about, and the lead it produced.
 * Pointing the owner console at the operator route would have meant either
 * showing them our plumbing or teaching one endpoint to lie about itself
 * depending on who asked.
 *
 * THE ENTITLEMENT IS CHECKED PER REQUEST, not assumed from the nav. The console
 * hides the page without the module, but a hidden page is not a closed door -
 * the URL is guessable and the session is real, so both routes ask
 * `organizations` directly and 403 when the answer is no.
 *
 * OWNER AND MANAGER ONLY. A call log is a view over the whole floor's
 * conversations; a telecaller's console stays their own leads and follow-ups
 * (design doc §9), the same restriction Call Quality carries.
 */
/** `null` clears the verdict; a key sets it. */
const DispositionBody = z.object({ key: z.string().max(40).nullable() });

@Controller("owner/calls")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class OwnerCallsController {
  constructor(
    private readonly db: DbService,
    private readonly s3: S3Service,
    private readonly agents: AgentsService,
  ) {}

  /** List view: filtered, paginated, newest first. */
  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { state, direction, sentiment, deviceId, q, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }

      // One predicate, shared by the page and the count, so "showing 50 of 312"
      // can never disagree with the rows underneath it.
      const where = `WHERE ($1::text IS NULL OR
                 CASE $1::text
                   WHEN 'complete'    THEN c.status = 'COMPLETE'
                   WHEN 'failed'      THEN c.status LIKE 'FAILED%'
                   WHEN 'in_pipeline' THEN c.status NOT IN ('COMPLETE', 'TRANSCRIPTION_OFF')
                                       AND c.status NOT LIKE 'FAILED%'
                 END)
            AND ($2::text IS NULL OR c.direction = $2::text)
            AND ($3::text IS NULL OR ci.sentiment = $3::text)
            AND ($4::uuid IS NULL OR c.device_id = $4::uuid)
            AND ($5::text IS NULL OR c.remote_name ILIKE $5::text OR ci.summary ILIKE $5::text)`;
      const filters = [
        state ?? null,
        direction ?? null,
        sentiment ?? null,
        deviceId ?? null,
        q ? `%${q}%` : null,
      ];

      const { rows } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
                c.remote_name, c.remote_number_prefix, c.remote_number_last3,
                c.device_id, c.disposition_key,
                c.device_id, COALESCE(d.telecaller_name, d.label) AS telecaller,
                ci.intent, ci.sentiment, ci.outcome, ci.summary, ci.has_transcript,
                ca.quality_score,
                lead.id AS lead_id, lead.title AS lead_title
           FROM calls c
           LEFT JOIN devices d ON d.id = c.device_id
           ${READ_JOIN}
           ${LEAD_JOIN}
          ${where}
          ORDER BY c.started_at DESC
          LIMIT $6 OFFSET $7`,
        [...filters, limit, offset],
      );

      const {
        rows: [count],
      } = await client.query(
        // The read join is not optional in the count even though it selects
        // nothing from it: `where` filters on ci.sentiment and ci.summary.
        `SELECT count(*)::int AS total
           FROM calls c
           LEFT JOIN devices d ON d.id = c.device_id
           ${READ_JOIN}
          ${where}`,
        filters,
      );

      return { calls: rows, total: count?.total ?? 0, limit, offset };
    });
  }

  /**
   * One call in full: the transcript, the read behind the chips, and the
   * talk-time analytics.
   *
   * Redaction, not refusal, for `recordings_listen` - the same split
   * `calls.controller.ts:406` makes, and for the same reason: what the call was
   * about is the tenant's own business record, while a word-for-word account of
   * a customer's conversation is the privileged part. The flag is read from
   * `memberships` rather than the principal because the owner console arrives
   * on the platform admin key, which AdminKeyGuard mints with
   * `recordingsListen: true`; believing it would make the per-account flag
   * decorative. See owner/leads.controller.ts's canReadTranscript for the full
   * reasoning - this is the same check, on the surface a manager reaches when
   * they are looking at calls rather than at a lead.
   */
  @Get(":id")
  async detail(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }

      const {
        rows: [call],
      } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
                c.remote_name, c.remote_number_prefix, c.remote_number_last3,
                c.device_id, c.disposition_key,
                c.device_id, COALESCE(d.telecaller_name, d.label) AS telecaller,
                ci.intent, ci.sentiment, ci.outcome, ci.summary, ci.has_transcript,
                ca.quality_score,
                lead.id AS lead_id, lead.title AS lead_title
           FROM calls c
           LEFT JOIN devices d ON d.id = c.device_id
           ${READ_JOIN}
           ${LEAD_JOIN}
          WHERE c.id = $1`,
        [callId],
      );
      if (!call) throw new NotFoundException("call not found");

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
        // quality_criteria and risk_flags come back here for the same reason the
        // score does: the client is the one being coached. Withholding the
        // breakdown while showing the number it produces leaves a manager with
        // a verdict and no way to act on it - and leads.controller.ts already
        // returns risk_flags on the lead-side view of the same call, so keeping
        // them out here only made one call describe itself two ways.
        `SELECT quality_score, quality_criteria, talk_ratio, agent_talk_seconds,
                customer_talk_seconds, interruption_count, risk_flags,
                has_escalation_risk
           FROM call_analytics WHERE call_id = $1 LIMIT 1`,
        [callId],
      );
      const { rows: facts } = await client.query(
        `SELECT field_key, value_text, value_num, value_bool
           FROM call_facts WHERE call_id = $1 ORDER BY field_key`,
        [callId],
      );

      /*
       * SOP adherence (migration 0091), joined to the SOP VERSION that judged
       * this call rather than to whichever version is active now.
       *
       * That join condition is the whole reason `call_sops` is versioned. The
       * step labels a reviewer reads have to be the ones the call was scored
       * against - joining on `is_active` would relabel February's verdicts with
       * March's wording, and a step renamed between the two would render a
       * verdict under a rule it was never given.
       *
       * LEFT JOIN because an SOP version can be deleted while its scores
       * remain; the result then renders by key with no label, which is
       * degraded but honest.
       */
      const {
        rows: [sop],
      } = await client.query(
        `SELECT r.step_results, r.steps_met, r.steps_total, r.adherence_pct,
                r.sop_id, r.sop_version, s.name AS sop_name, s.steps AS sop_steps
           FROM call_sop_results r
           LEFT JOIN call_sops s ON s.id = r.sop_id AND s.version = r.sop_version
          WHERE r.call_id = $1
          LIMIT 1`,
        [callId],
      );

      const canRead = await this.canReadTranscript(client, req.principal, orgId);
      if (!canRead && transcript) {
        transcript.text = null;
        transcript.segments = null;
      }

      /*
       * SOP EVIDENCE IS VERBATIM TRANSCRIPT TEXT, so it is redacted by exactly
       * the same permission that redacts the transcript above.
       *
       * Easy to miss, because the field is called `evidence` and lives on a
       * scoring row rather than on `transcripts`. It is a word-for-word quote
       * of what somebody said on a customer's phone call, and a reviewer
       * without `recordings_listen` reading seven of them per call would be
       * reading the transcript in instalments - which is the same reasoning
       * that keeps `q` search off the transcript body (see ListQuery).
       *
       * The VERDICTS stay. Whether a step was met is a judgement about the
       * agent's conduct, which is what this reader is entitled to; the
       * customer's words are not. So the checklist still renders, with the
       * quotes withheld and the console saying so.
       */
      if (!canRead && sop && Array.isArray(sop.step_results)) {
        sop.step_results = (sop.step_results as Array<Record<string, unknown>>).map((r) => ({
          ...r,
          evidence: null,
        }));
        sop.evidence_redacted = true;
      }

      return {
        call,
        transcript: transcript ?? null,
        analytics: analytics ?? null,
        facts,
        sop: sop ?? null,
        transcriptRedacted: !canRead,
        // "Draft a follow-up" is offered only where it can succeed: a drafter
        // is on, and this reader may read the words it would paraphrase.
        replyDrafterActive: canRead && Boolean(transcript) && (await replyDrafterActive(client)),
      };
    });
  }

  /**
   * Draft a follow-up message from this call with the org's reply drafter
   * (0121). Returns text for a person to copy, edit and send; sends nothing.
   *
   * ── GATED LIKE THE TRANSCRIPT ITSELF ────────────────────────────────────────
   *
   * A draft recaps what the customer said, which is the transcript in other
   * words - the same reasoning that redacts SOP evidence above. So it needs the
   * `call_intel` module AND the reader's transcript permission, not just a seat
   * at the call log; without them a follow-up would be a way to read a
   * redacted call one paraphrase at a time.
   */
  @Post(":id/draft-reply")
  async draftReply(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    await this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }
      const { rowCount } = await client.query("SELECT 1 FROM calls WHERE id = $1", [callId]);
      if (!rowCount) throw new NotFoundException("call not found");
      if (!(await this.canReadTranscript(client, req.principal, orgId))) {
        throw new ForbiddenException("drafting a follow-up needs permission to read call transcripts");
      }
    });
    const draft = await this.agents.draftReply(orgId, { source: { callId } });
    return { reply: draft.reply, provider: draft.provider };
  }

  /**
   * Reviewer notes on a call, in the CLIENT's console.
   *
   * The SAME `call_notes` rows the operator console writes (notes.controller.ts)
   * rather than a second table. A note is about the call, not about who happened
   * to be looking at it - two stores would let support and customer open the
   * same conversation and each see notes the other had never heard of, which is
   * the exact confusion a shared record exists to prevent.
   *
   * Owner and manager only, inherited from the controller.
   */
  @Get(":id/notes")
  async listNotes(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) callId: string) {
    return this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }
      const { rows } = await client.query(
        `SELECT id, body, author, created_at
           FROM call_notes WHERE call_id = $1 ORDER BY created_at DESC`,
        [callId],
      );
      return { notes: rows };
    });
  }

  @Post(":id/notes")
  async createNote(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
    @Body() body: unknown,
  ) {
    const parsed = CreateNoteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }
      // FK checks bypass RLS, so confirm the call is visible in this org first -
      // the same order notes.controller.ts uses, and for the same reason.
      const call = await client.query("SELECT 1 FROM calls WHERE id = $1", [callId]);
      if (call.rowCount === 0) throw new NotFoundException("call not found");

      const author = req.principal?.userId ?? "owner";
      const {
        rows: [note],
      } = await client.query(
        `INSERT INTO call_notes (org_id, call_id, body, author)
         VALUES ($1, $2, $3, $4)
         RETURNING id, body, author, created_at`,
        [orgId, callId, parsed.data.body, author],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'call.note', 'call', $3)`,
        [orgId, author, callId],
      );
      return note;
    });
  }

  /**
   * A short-lived URL for the recording itself.
   *
   * Gated on the membership's `recordings_listen`, NOT on PermissionsGuard. The
   * operator route can use that decorator because it is reached with a real
   * platform principal; the owner console arrives on the platform admin key,
   * which AdminKeyGuard mints with `recordingsListen: true` - so the same
   * decorator here would wave every client member straight through to the audio.
   * This is `canReadTranscript`'s check applied to the more sensitive half of
   * the same split: someone who may not read the words certainly may not hear
   * them said.
   *
   * Playback is audited for the same reason the operator path audits it -
   * listening to a customer's recording is an event the tenant may later need
   * to account for, whoever did it.
   */
  @Get(":id/audio")
  async audio(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }
      if (!(await this.canReadTranscript(client, req.principal, orgId))) {
        throw new ForbiddenException("your account cannot play call recordings");
      }
      const {
        rows: [rec],
      } = await client.query(`SELECT s3_key FROM recordings WHERE call_id = $1`, [callId]);
      if (!rec) throw new NotFoundException("no recording for this call");

      const url = await this.s3.presignedGetUrl(rec.s3_key, 300);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'recording.playback', 'call', $3, $4)`,
        [orgId, req.principal?.userId ?? "owner", callId, JSON.stringify({ s3Key: rec.s3_key })],
      );
      return { url };
    });
  }

  /**
   * Re-run the pipeline for a finished call.
   *
   * OWNER ONLY - narrowing the controller's owner+manager, which is what
   * `getAllAndOverride` in OwnerRoleGuard makes possible. Every press rewinds
   * the call to UPLOADED, and `processCall` clears `asr_job_id` on its way
   * through, so the audio goes to the ASR provider AGAIN and analyze runs again
   * behind it. That is real money per press, on a transcript the tenant has
   * already paid for once - a spending decision, and it belongs with the account
   * holder rather than with everyone who can read the call log.
   *
   * The terminal-state guard is calls.controller.ts's, repeated rather than
   * shared: an in-flight call must never be rewound underneath the worker
   * holding it, and a 409 naming the current status is what tells the console to
   * stop offering the button rather than to retry.
   */
  /**
   * Record what a PERSON says this call was (migration 0097).
   *
   * ── WHY THE AI READ IS NOT THIS ─────────────────────────────────────────
   *
   * `transcripts.intelligence->>'outcome'` is already on the row and the
   * console already shows it. It is a machine's reading, in a vocabulary we
   * chose, and it is right often enough to be useful and wrong often enough
   * that nobody should be measured on it. This column is what somebody agreed
   * to, in the tenant's own words - the same split SOP scoring and WhatsApp
   * qualification already make.
   *
   * ── AND WHY IT MOVES THE LEAD'S TEMPERATURE ─────────────────────────────
   *
   * A disposition that only coloured a chip would be a filing exercise. The
   * point of `lead_quality` is that judging the call re-rates the lead, which
   * is the one thing a telecaller knows and the board does not.
   *
   * It writes `temperature_source = 'user'` because a person chose it, and
   * 0083's rule then makes that permanent against the pipeline - a later call's
   * automatic read cannot overwrite a human's verdict. Dispositions with no
   * `lead_quality` touch the lead at all, which is why most of the seeded set
   * has none: "no answer" is the most-pressed button on any floor, and a floor
   * that re-rated its whole board every time somebody did not pick up would
   * have a rating that measures reachability.
   */
  @Post(":id/disposition")
  async disposition(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
    @Body() body: unknown,
  ) {
    const parsed = DispositionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { key } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }

      // Clearing is its own path: it removes the verdict but deliberately does
      // NOT put the lead's temperature back. There is nothing to put it back
      // to - the previous value may have come from another call entirely - and
      // silently re-rating a lead because somebody undid a chip would be a
      // change nobody asked for.
      if (key === null) {
        const { rowCount } = await client.query(
          `UPDATE calls SET disposition_key = NULL, disposition_by = NULL, disposition_at = NULL
            WHERE id = $1`,
          [callId],
        );
        if (!rowCount) throw new NotFoundException("call not found");
        return { ok: true, disposition: null, leadRerated: false };
      }

      const {
        rows: [disposition],
      } = await client.query<{ key: string; label: string; lead_quality: string | null }>(
        `SELECT key, label, lead_quality FROM call_dispositions
          WHERE key = $1 AND is_active`,
        [key],
      );
      if (!disposition) throw new BadRequestException("no active disposition with that name");

      const {
        rows: [call],
      } = await client.query<{ lead_id: string | null }>(
        `UPDATE calls
            SET disposition_key = $2, disposition_by = $3, disposition_at = now()
          WHERE id = $1
         RETURNING lead_id`,
        [callId, disposition.key, req.principal?.userId ?? null],
      );
      if (!call) throw new NotFoundException("call not found");

      let leadRerated = false;
      if (disposition.lead_quality && call.lead_id) {
        const { rowCount } = await client.query(
          `UPDATE leads
              SET temperature = $2, temperature_source = 'user'
            WHERE id = $1 AND status = 'open'`,
          [call.lead_id, disposition.lead_quality],
        );
        // Only open leads. Re-rating a lead somebody already marked won or lost
        // would overwrite a conclusion with an observation.
        leadRerated = Boolean(rowCount);
      }

      return { ok: true, disposition: disposition.key, leadRerated };
    });
  }

  @Post(":id/reprocess")
  @RequireOwnerRole("owner")
  async reprocess(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    const result = await this.db.withOrg(orgId, async (client) => {
      if (!(await orgHasModule(client, "call_intel"))) {
        throw new ForbiddenException("call intelligence is not enabled for this instance");
      }
      const {
        rows: [call],
      } = await client.query(`SELECT status FROM calls WHERE id = $1`, [callId]);
      if (!call) throw new NotFoundException("call not found");

      const terminal =
        call.status === "COMPLETE" ||
        call.status === "TRANSCRIPTION_OFF" ||
        String(call.status).startsWith("FAILED_");
      if (!terminal) {
        throw new ConflictException(
          `call is ${call.status}; only COMPLETE, TRANSCRIPTION_OFF or FAILED_* calls can be reprocessed`,
        );
      }

      await client.query(
        `UPDATE calls
            SET status = 'UPLOADED', pipeline_attempts = 0, next_attempt_at = NULL
          WHERE id = $1
            AND (status IN ('COMPLETE', 'TRANSCRIPTION_OFF') OR status LIKE 'FAILED_%')`,
        [callId],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'call.reprocess', 'call', $3, $4)`,
        [
          orgId,
          req.principal?.userId ?? "owner",
          callId,
          JSON.stringify({ from: call.status, via: "owner-console" }),
        ],
      );
      return { status: "UPLOADED" as const };
    });

    // Source of truth is the DB flip above; the queue is only a wake-up.
    await publishPipeline({ callId, orgId });
    return result;
  }

  /** See the class docblock: identity from the principal, grant from the row. */
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
      "SELECT recordings_listen FROM memberships WHERE user_id = $1 AND org_id = $2 LIMIT 1",
      [userId.data, orgId],
    );
    return membership?.recordings_listen === true;
  }
}
