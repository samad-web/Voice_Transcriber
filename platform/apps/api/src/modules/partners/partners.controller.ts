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
  PartnerKind,
  PartnerStatus,
  PartnerSubmissionOutcome,
  PartnerUserRole,
  mayMoveOutcome,
} from "@aura/shared/dist/partners";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { PartnerInvitesService } from "./partner-invites.service";

/**
 * The TENANT's side of channel partners (Build docs/39 §18) - the roster, the
 * submission queue, and the invite that lets a broker in.
 *
 * Nothing here is the portal. These routes are reached by the client's own
 * console with the ordinary admin-key + TenantGuard credential and are gated on
 * the `partner` object type in the permission grid, which migration 0162 seeds
 * for every system role in the same file that widens the enum - because
 * `CrmPermissionsGuard` denies whatever it finds no grant for, and shipping the
 * enum without the rows would 403 every user in every tenant on restart (0041
 * on `task`, 0103 on `lead`, 0158 on `dnc`).
 *
 * ── THERE IS NO DELETE ──────────────────────────────────────────────────────
 *
 * A partner is suspended or terminated, never removed: deleting one would take
 * the tenant's own record of where a year of leads came from with it, and that
 * record is what a commission is reconciled against. Same shape, same reason,
 * as a DNC list being disabled rather than dropped (0158), which is also why
 * `partner:delete` is not among the grants 0162 seeds - a cell that gated a
 * route that does not exist is exactly what `ENFORCED_PERMISSIONS` exists to
 * prevent.
 *
 * ── ROUTE ORDER IS LOAD-BEARING ─────────────────────────────────────────────
 *
 * `submissions` and `invites` are declared BEFORE `:id`. Nest matches in
 * declaration order, so `GET /partners/submissions` reaching `detail()` with
 * id="submissions" is a `ParseUUIDPipe` 400 rather than a queue - a failure
 * that looks like a client bug and is not.
 */

const CreatePartnerBody = z.object({
  name: z.string().trim().min(1).max(160),
  kind: PartnerKind,
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: "a referral code is letters, digits, dot, dash or underscore",
  }),
  email: z.string().trim().email().max(320).optional(),
  commissionPlanId: z.string().uuid().optional(),
});

/**
 * Hand-built, not `CreatePartnerBody.partial()`.
 *
 * `Input.partial()` KEEPS `.default()`, so a PATCH that never mentioned a field
 * would arrive carrying that field's default and overwrite whatever the tenant
 * had set. There is one live instance of that bug in outreach cadences; every
 * PATCH schema in doc 39 is written out by hand for this reason (Part K §5).
 */
const UpdatePartnerBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  kind: PartnerKind.optional(),
  status: PartnerStatus.optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  // Nullable: detaching a plan is a real thing to do, and `undefined` has to
  // keep meaning "leave it alone" or the hand-built schema above was pointless.
  commissionPlanId: z.string().uuid().nullable().optional(),
});

const DecideBody = z.object({
  outcome: PartnerSubmissionOutcome,
  rejectReason: z.string().trim().max(500).optional(),
});

const InviteBody = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(160).optional(),
  role: PartnerUserRole.default("member"),
  ttlHours: z.number().int().optional(),
});

const PARTNER_COLUMNS = `id, name, kind, code, status, commission_plan_id, phone_number_key,
  email, onboarded_at, created_at, updated_at`;

/**
 * The plan a partner is attached to must be this org's, and must be written for
 * partners.
 *
 * NOT `assertInOrg`: `commissionPlanId` is not one of its twelve reference
 * fields and `common/org-references.ts` belongs to another change. Hand-rolled
 * here instead, and deliberately checking `payee_kind` as well as the org -
 * which `assertInOrg` could not express anyway, since its whole contract is
 * "does this id name a row of the right TYPE in this org" and both plans are
 * the same type.
 *
 * Migration 0162's `partners_commission_plan_guard` enforces both conditions at
 * the table and is the real boundary (foreign keys do not see RLS, doc 23 A2).
 * This exists to turn that trigger's 23514 - which surfaces as a 500 - into a
 * 400 the console can print beside the field.
 */
async function assertPartnerPlan(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  orgId: string,
  planId: string | undefined,
): Promise<void> {
  if (!planId) return;
  const { rows } = await client.query(
    `SELECT 1 FROM commission_plans
      WHERE id = $1 AND org_id = $2 AND payee_kind = 'partner' AND deleted_at IS NULL`,
    [planId, orgId],
  );
  if (rows.length === 0) {
    // One message for "no such plan" and "that plan is for your own staff":
    // the same answer for both is what stops this being a probe for another
    // tenant's plan ids, the reasoning `assertInOrg` gives for its own 400.
    throw new BadRequestException(
      "commissionPlanId: no such partner commission plan in this organization",
    );
  }
}

@Controller("partners")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class PartnersController {
  constructor(
    private readonly db: DbService,
    private readonly invites: PartnerInvitesService,
  ) {}

  @Get()
  @RequireCrmPermission("partner", "view")
  async list(@OrgId() orgId: string, @Query("status") status?: string) {
    const filter = PartnerStatus.safeParse(status);
    return this.db.withOrg(orgId, async (client) => {
      // The submission counts come back with the roster rather than from a
      // second call per row: a tenant with forty brokers would otherwise cost
      // forty round trips to Seoul to render one table (Part K §13).
      const { rows } = await client.query(
        `SELECT ${PARTNER_COLUMNS.split(",").map((c) => `p.${c.trim()}`).join(", ")},
                count(s.id)                                        AS submission_count,
                count(s.id) FILTER (WHERE s.outcome = 'submitted')  AS awaiting_count,
                count(s.id) FILTER (WHERE s.outcome = 'converted')  AS converted_count
           FROM partners p
           LEFT JOIN partner_submissions s ON s.partner_id = p.id
          WHERE ($1::text IS NULL OR p.status = $1)
          GROUP BY p.id
          ORDER BY p.status = 'active' DESC, p.name ASC`,
        [filter.success ? filter.data : null],
      );
      return { partners: rows };
    });
  }

  @Post()
  @RequireCrmPermission("partner", "create")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreatePartnerBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertPartnerPlan(client, orgId, p.commissionPlanId);
      try {
        const {
          rows: [partner],
        } = await client.query(
          `INSERT INTO partners (org_id, name, kind, code, email, commission_plan_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${PARTNER_COLUMNS}`,
          [orgId, p.name, p.kind, p.code, p.email ?? null, p.commissionPlanId ?? null],
        );
        await this.audit(client, orgId, "partner.create", partner.id, req);
        return { partner };
      } catch (err) {
        // partners_org_code is unique on lower(code). A duplicate is a person
        // re-typing a code they already used, not a system fault.
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(`another partner already uses the code ${p.code}`);
        }
        throw err;
      }
    });
  }

  /**
   * The tenant's queue: every partner's submissions, newest first.
   *
   * Runs under `withOrg`, where `app.partner_id` is unset - so 0162's
   * RESTRICTIVE `partner_isolation` policy evaluates its first arm and the
   * whole org is visible, which is exactly the asymmetry the policy encodes:
   * staff see every partner, a partner sees one.
   */
  @Get("submissions")
  @RequireCrmPermission("partner", "view")
  async queue(@OrgId() orgId: string, @Query("outcome") outcome?: string) {
    const filter = PartnerSubmissionOutcome.safeParse(outcome);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.outcome, s.reject_reason, s.lead_id, s.lead_name, s.lead_phone,
                s.lead_email, s.note, s.submitted_at, s.decided_at,
                p.id AS partner_id, p.name AS partner_name, p.code AS partner_code
           FROM partner_submissions s
           JOIN partners p ON p.id = s.partner_id
          WHERE ($1::text IS NULL OR s.outcome = $1)
          ORDER BY s.submitted_at DESC
          LIMIT 200`,
        [filter.success ? filter.data : null],
      );
      return { submissions: rows };
    });
  }

  /**
   * Accept, decline or mark converted.
   *
   * The transition is checked against `mayMoveOutcome` BEFORE the write, and
   * the rule it enforces is that `rejected` and `converted` are terminal. A
   * declined referral cannot be re-opened: doing so would quietly reverse a
   * commercial decision the partner was already told about, weeks later, with
   * nothing in the row to say it ever happened. The honest way to change your
   * mind is a new submission, which gets its own date.
   *
   * Gated on `partner:edit` rather than `partner:view`, because this is the
   * route that decides whether somebody is owed a commission.
   */
  @Patch("submissions/:id")
  @RequireCrmPermission("partner", "edit")
  async decide(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = DecideBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { outcome, rejectReason } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // FOR UPDATE on the row itself, NOT inside a CTE. A lazy CTE does not
      // lock what you think it does - the planner may never execute it - which
      // is the trap 0146's header and doc 39 Part K §7 both record. Two
      // statements, one transaction, a real lock.
      const {
        rows: [current],
      } = await client.query<{ outcome: string }>(
        `SELECT outcome FROM partner_submissions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!current) throw new NotFoundException("submission not found");

      const from = PartnerSubmissionOutcome.safeParse(current.outcome);
      if (!from.success || !mayMoveOutcome(from.data, outcome)) {
        throw new ConflictException(
          `a submission that is already ${current.outcome} cannot be marked ${outcome}`,
        );
      }

      const {
        rows: [submission],
      } = await client.query(
        `UPDATE partner_submissions
            SET outcome = $2,
                reject_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE NULL END,
                decided_at = now(),
                decided_by = $4
          WHERE id = $1
          RETURNING id, outcome, reject_reason, decided_at`,
        [id, outcome, rejectReason ?? null, auditActor(req).id],
      );
      await this.audit(client, orgId, `partner.submission.${outcome}`, id, req);
      return { submission };
    });
  }

  /**
   * Withdraw an invite nobody accepted. A POST rather than a DELETE: the row
   * is kept and stamped, because "this link was issued and then pulled" is
   * part of the record of who was offered access.
   */
  @Post("invites/:inviteId/revoke")
  @RequireCrmPermission("partner", "edit")
  async revokeInvite(
    @OrgId() orgId: string,
    @Param("inviteId", ParseUUIDPipe) inviteId: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.invites.revoke(orgId, inviteId, { id: auditActor(req).id });
  }

  @Get(":id")
  @RequireCrmPermission("partner", "view")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [partner],
      } = await client.query(`SELECT ${PARTNER_COLUMNS} FROM partners WHERE id = $1`, [id]);
      if (!partner) throw new NotFoundException("partner not found");
      const { rows: people } = await client.query(
        `SELECT pu.id, pu.role, pu.status, pu.created_at, u.email, u.name
           FROM partner_users pu JOIN users u ON u.id = pu.user_id
          WHERE pu.partner_id = $1
          ORDER BY pu.created_at ASC`,
        [id],
      );
      const { rows: invites } = await client.query(
        `SELECT id, email, name, role, expires_at, emailed_at, accepted_at, revoked_at, created_at
           FROM partner_invites
          WHERE partner_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [id],
      );
      return { partner, people, invites };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("partner", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdatePartnerBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      await assertPartnerPlan(client, orgId, p.commissionPlanId ?? undefined);
      const {
        rows: [partner],
      } = await client.query(
        `UPDATE partners SET
           name   = COALESCE($2, name),
           kind   = COALESCE($3, kind),
           status = COALESCE($4, status),
           email  = CASE WHEN $5::boolean THEN $6 ELSE email END,
           commission_plan_id = CASE WHEN $7::boolean THEN $8::uuid ELSE commission_plan_id END,
           -- Stamped the first time they go live and never again: this is
           -- "when did the relationship start", which a suspension and a
           -- later reinstatement must not reset.
           onboarded_at = CASE WHEN $4 = 'active' THEN COALESCE(onboarded_at, now()) ELSE onboarded_at END
         WHERE id = $1
         RETURNING ${PARTNER_COLUMNS}`,
        [
          id,
          p.name ?? null,
          p.kind ?? null,
          p.status ?? null,
          p.email !== undefined,
          p.email ?? null,
          p.commissionPlanId !== undefined,
          p.commissionPlanId ?? null,
        ],
      );
      if (!partner) throw new NotFoundException("partner not found");
      await this.audit(client, orgId, "partner.update", id, req);
      return { partner };
    });
  }

  /**
   * Invite a person at this partner to the portal.
   *
   * `partner:edit`, not `create`: issuing one hands a third party a login into
   * this workspace's portal, which is a bigger decision than adding a row to a
   * roster.
   */
  @Post(":id/invites")
  @RequireCrmPermission("partner", "edit")
  async invite(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = InviteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.issue(orgId, id, parsed.data, { id: auditActor(req).id });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    req: PrincipalRequest,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'partner', $4)`,
      [orgId, auditActor(req).id, action, targetId, auditActor(req).type],
    );
  }
}
