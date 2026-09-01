import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { orgHasModule } from "../../common/org-modules";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

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
 * The lead this call produced or advanced, so a row can be followed back into
 * the pipeline. LATERAL because several leads can share a contact over time and
 * a plain join would emit the call once per lead.
 */
const LEAD_JOIN = `
  LEFT JOIN LATERAL (
    SELECT l.id, l.title
      FROM leads l
     WHERE l.last_call_id = c.id OR l.first_call_id = c.id
     ORDER BY l.last_activity_at DESC
     LIMIT 1
  ) lead ON true`;

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
@Controller("owner/calls")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class OwnerCallsController {
  constructor(private readonly db: DbService) {}

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
        `SELECT quality_score, talk_ratio, agent_talk_seconds, customer_talk_seconds,
                interruption_count, has_escalation_risk
           FROM call_analytics WHERE call_id = $1 LIMIT 1`,
        [callId],
      );
      const { rows: facts } = await client.query(
        `SELECT field_key, value_text, value_num, value_bool
           FROM call_facts WHERE call_id = $1 ORDER BY field_key`,
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
        facts,
        transcriptRedacted: !canRead,
      };
    });
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
