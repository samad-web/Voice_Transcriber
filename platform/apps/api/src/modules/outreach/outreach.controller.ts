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
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  CadenceInput,
  JourneyEnrolInput,
  StepActInput,
  materialiseSteps,
  OutreachJourneyStatus,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OperatorMayCall, OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { assertInOrg, assertMembers } from "../../common/org-references";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const JourneyQuery = z.object({
  status: OutreachJourneyStatus.optional(),
  contactId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const DueQuery = z.object({
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const JourneyPatch = z.object({ stopReason: z.string().max(200).optional() }).strict();

/**
 * Outreach cadences and journeys (migration 0058).
 *
 * ── GUARDS: AdminKeyGuard + TenantGuard, NOT CrmPermissionsGuard ────────
 *
 * A cadence is org configuration, in the same class as pipelines, roles and
 * automation rules. A JOURNEY is more arguable - enrolling somebody is a
 * decision about a contact - but the line drawn here is the same one
 * automation rules already sit on, and it is drawn on what the surface can
 * MUTATE: an automation rule can move a deal between stages and write custom
 * fields on it, while everything in this controller writes only to its own
 * two tables. Gating the smaller surface more tightly than the larger one
 * would be theatre.
 *
 * ── NOTHING HERE SENDS ──────────────────────────────────────────────────
 *
 * Acting on a step records that a person did something. It does not do it.
 * There is no dispatcher in this module and no message body anywhere in it -
 * safety rule 3, kept structurally rather than by convention.
 */
@Controller("outreach")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@OperatorMayCall()
export class OutreachController {
  constructor(private readonly db: DbService) {}

  // ── cadences ──────────────────────────────────────────────────────────

  @Get("cadences")
  async listCadences(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.name, c.description, c.stop_on, c.active, c.created_at,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                            'id', s.id, 'stepIndex', s.step_index, 'label', s.label,
                            'channel', s.channel, 'delayHours', s.delay_hours::float8,
                            'guidance', s.guidance)
                          ORDER BY s.step_index)
                     FROM outreach_cadence_steps s WHERE s.cadence_id = c.id),
                  '[]'::json) AS steps,
                (SELECT count(*) FROM outreach_journeys j
                  WHERE j.cadence_id = c.id AND j.status = 'active')::int AS active_journeys
           FROM outreach_cadences c
          WHERE c.org_id = $1
          ORDER BY c.active DESC, lower(c.name)`,
        [orgId],
      );
      return { cadences: rows };
    });
  }

  /**
   * Create a cadence and its rungs in ONE transaction.
   *
   * A cadence with no steps would enrol people and never ask anybody for
   * anything - the zod schema refuses it, and doing both writes in one
   * transaction means a failure halfway cannot leave one behind either.
   */
  @Post("cadences")
  // doc 31 §2 X8: a cadence is the org's shared ladder; reps work journeys, managers write the ladder.
  @RequireOwnerRole("owner", "manager")
  async createCadence(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CadenceInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [cadence],
        } = await client.query<{ id: string }>(
          `INSERT INTO outreach_cadences (org_id, name, description, stop_on, active)
           VALUES ($1, btrim($2), $3, $4, $5) RETURNING id`,
          [orgId, input.name, input.description ?? null, input.stopOn, input.active],
        );

        for (const [index, step] of input.steps.entries()) {
          await client.query(
            `INSERT INTO outreach_cadence_steps
               (org_id, cadence_id, step_index, label, channel, delay_hours, guidance)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              orgId,
              cadence.id,
              index,
              step.label,
              step.channel,
              step.delayHours,
              step.guidance ?? null,
            ],
          );
        }
        return { id: cadence.id };
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(`a cadence named "${input.name}" already exists`);
        }
        throw err;
      }
    });
  }

  /**
   * Retire or rename a cadence.
   *
   * The STEPS are deliberately not editable here. A journey copies its rungs
   * at enrolment (0058 denormalises label/channel/guidance onto the ledger),
   * so editing a live cadence's steps would leave running journeys on the old
   * wording while the definition said something else - two truths, no way to
   * tell which somebody was actually asked to do. Changing a process means a
   * new cadence, and retiring the old one.
   */
  @Patch("cadences/:id")
  // doc 31 §2 X8: same as createCadence.
  @RequireOwnerRole("owner", "manager")
  async updateCadence(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = CadenceInput.pick({ name: true, description: true, active: true })
      .partial()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown): void => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (parsed.data.name !== undefined) set("name", parsed.data.name);
    if (parsed.data.description !== undefined) set("description", parsed.data.description);
    if (parsed.data.active !== undefined) set("active", parsed.data.active);
    if (sets.length === 0) throw new BadRequestException("nothing to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [cadence],
      } = await client.query(
        `UPDATE outreach_cadences SET ${sets.join(", ")} WHERE id = $1
         RETURNING id, name, description, stop_on, active`,
        params,
      );
      if (!cadence) throw new NotFoundException("cadence not found");
      return { cadence };
    });
  }

  // ── journeys ──────────────────────────────────────────────────────────

  @Get("journeys")
  async listJourneys(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = JourneyQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    const where = ["j.org_id = $1"];
    const params: unknown[] = [orgId];
    const add = (sql: string, v: unknown): void => {
      params.push(v);
      where.push(sql.replace("$?", `$${params.length}`));
    };
    if (q.status) add("j.status = $?", q.status);
    if (q.contactId) add("j.contact_id = $?", q.contactId);
    const owner = q.mine ? actorUserId(req) : (q.ownerUserId ?? null);
    if (owner) add("j.owner_user_id = $?", owner);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT j.id, j.cadence_id, c.name AS cadence_name, j.contact_id,
                k.display_name AS contact_name, j.deal_id, j.owner_user_id,
                j.status, j.stop_reason, j.started_at, j.completed_at,
                (SELECT count(*) FROM outreach_journey_steps s
                  WHERE s.journey_id = j.id AND s.status = 'due')::int AS due_count,
                (SELECT count(*) FROM outreach_journey_steps s
                  WHERE s.journey_id = j.id)::int AS step_count
           FROM outreach_journeys j
           JOIN outreach_cadences c ON c.id = j.cadence_id
           LEFT JOIN contacts k     ON k.id = j.contact_id
          WHERE ${where.join(" AND ")}
          ORDER BY j.started_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit, q.offset],
      );
      return { journeys: rows };
    });
  }

  /**
   * Enrol a contact.
   *
   * The rungs are materialised HERE, at enrolment, rather than being computed
   * on read: it is what makes the ledger a record of what was actually asked
   * of somebody, and what lets a cadence be retired without rewriting the
   * history of everyone who ran through it.
   */
  @Post("journeys")
  async enrol(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = JourneyEnrolInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const startedAt = input.startedAt ?? new Date();

    return this.db.withOrg(orgId, async (client) => {
      const { rows: steps } = await client.query<{
        id: string;
        step_index: number;
        label: string;
        channel: string;
        delay_hours: string;
        guidance: string | null;
      }>(
        `SELECT s.id, s.step_index, s.label, s.channel, s.delay_hours::text, s.guidance
           FROM outreach_cadence_steps s
           JOIN outreach_cadences c ON c.id = s.cadence_id
          WHERE s.cadence_id = $1 AND c.org_id = $2 AND c.active
          ORDER BY s.step_index`,
        [input.cadenceId, orgId],
      );
      if (steps.length === 0) {
        throw new NotFoundException("cadence not found, inactive, or has no steps");
      }

      // Foreign-key checks ignore RLS, and `users` has none at all - so the
      // contact and deal must be this org's, and the owner a member of it
      // (doc 23, A1/A2).
      await assertInOrg(client, orgId, { contactId: input.contactId, dealId: input.dealId });
      await assertMembers(client, orgId, { ownerUserId: input.ownerUserId });

      let journeyId: string;
      try {
        const {
          rows: [journey],
        } = await client.query<{ id: string }>(
          `INSERT INTO outreach_journeys
             (org_id, cadence_id, contact_id, deal_id, owner_user_id, started_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            orgId,
            input.cadenceId,
            input.contactId,
            input.dealId ?? null,
            input.ownerUserId ?? actorUserId(req),
            startedAt,
          ],
        );
        journeyId = journey.id;
      } catch (err) {
        // The partial unique index allows re-running somebody next quarter but
        // not enrolling them twice at once - which would deliver every rung in
        // duplicate.
        if (isUniqueViolation(err)) {
          throw new ConflictException("this contact is already active on that cadence");
        }
        throw err;
      }

      // Dates computed by the same pure function the tests pin, so the
      // schedule the console previews is the schedule that gets written.
      const materialised = materialiseSteps(
        steps.map((s) => ({
          label: s.label,
          channel: s.channel as "call" | "whatsapp" | "email" | "other",
          delayHours: Number(s.delay_hours),
          guidance: s.guidance,
        })),
        startedAt,
      );

      for (const [i, step] of materialised.entries()) {
        await client.query(
          `INSERT INTO outreach_journey_steps
             (org_id, journey_id, cadence_step_id, step_index, label, channel, guidance,
              status, due_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   CASE WHEN $8::timestamptz <= now() THEN 'due' ELSE 'waiting' END, $8)`,
          [
            orgId,
            journeyId,
            steps[i].id,
            step.stepIndex,
            step.label,
            step.channel,
            step.guidance ?? null,
            step.dueAt,
          ],
        );
      }

      return { id: journeyId, steps: materialised.length };
    });
  }

  /** Stop chasing, by hand. */
  @Patch("journeys/:id")
  async stopJourney(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = JourneyPatch.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [journey],
      } = await client.query(
        `UPDATE outreach_journeys
            SET status = 'stopped', completed_at = now(), stop_reason = $2
          WHERE id = $1 AND status = 'active'
        RETURNING id, status, stop_reason`,
        [id, parsed.data.stopReason ?? "stopped by hand"],
      );
      if (!journey) throw new NotFoundException("journey not found or already finished");

      // Cancel, not skip - the rep did not decline these, the ladder ended.
      await client.query(
        `UPDATE outreach_journey_steps SET status = 'cancelled'
          WHERE journey_id = $1 AND status IN ('waiting', 'due')`,
        [id],
      );
      return { journey };
    });
  }

  // ── the work queue ────────────────────────────────────────────────────

  /**
   * What is owed right now.
   *
   * The screen a rep actually opens. Ordered by how late it is, because a
   * cadence's whole promise is about timing and the most overdue rung is the
   * one costing the most.
   */
  @Get("due")
  async due(@OrgId() orgId: string, @Query() query: unknown, @Req() req: PrincipalRequest) {
    const parsed = DueQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const where = ["s.org_id = $1", "s.status = 'due'", "j.status = 'active'"];
    const params: unknown[] = [orgId];
    const mineId = parsed.data.mine ? actorUserId(req) : null;
    if (mineId) {
      params.push(mineId);
      where.push(`j.owner_user_id = $${params.length}`);
    }

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.journey_id, s.step_index, s.label, s.channel, s.guidance,
                s.due_at, j.contact_id, k.display_name AS contact_name,
                k.phone_prefix, k.phone_last3, j.owner_user_id,
                c.name AS cadence_name
           FROM outreach_journey_steps s
           JOIN outreach_journeys j  ON j.id = s.journey_id
           JOIN outreach_cadences c  ON c.id = j.cadence_id
           LEFT JOIN contacts k      ON k.id = j.contact_id
          WHERE ${where.join(" AND ")}
          ORDER BY s.due_at ASC
          LIMIT $${params.length + 1}`,
        [...params, parsed.data.limit],
      );
      return { due: rows };
    });
  }

  /** Record that a rung was done, or deliberately skipped. */
  @Patch("steps/:id")
  async actOnStep(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = StepActInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [step],
      } = await client.query(
        `UPDATE outreach_journey_steps
            SET status = $2, note = $3, acted_at = now(), acted_by = $4
          WHERE id = $1 AND status IN ('waiting', 'due')
        RETURNING id, journey_id, step_index, status, acted_at`,
        [id, parsed.data.status, parsed.data.note ?? null, actorUserId(req)],
      );
      // Already acted on, or cancelled underneath them. Not an error worth a
      // 500 - two reps clicking the same due item is ordinary.
      if (!step) throw new NotFoundException("step not found or already actioned");
      return { step };
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
