import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { CallAccessApprovalInput, validateCallAccessWindow } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * The CUSTOMER's side of the call-access gate (migration 0122) - the half that
 * actually decides.
 *
 * ── WHY `owner` AND NOT THE DESIGNATED PERSON ALONE ───────────────────────
 *
 * `organizations.call_access_admin_user_id` decides who is TOLD. It does not
 * decide who may answer, and the two are deliberately different: a named
 * administrator who leaves the company, loses their phone or is simply on
 * leave would otherwise make the tenant permanently unable to approve
 * anything, and the only remedy would be the vendor editing their database -
 * which is precisely the power this feature exists to constrain.
 *
 * So: any active `owner` persona may decide. `manager` may not, and neither
 * may anyone else - this is the one decision in the product that is about the
 * business's relationship with its vendor rather than about its own work.
 *
 * ── WHY THE OPERATOR CANNOT REACH THESE ROUTES ────────────────────────────
 *
 * `OwnerRoleGuard` resolves the persona from `memberships` and refuses a bare
 * admin-key caller outright, because such a caller has no user behind it and
 * therefore no persona (see operator-only.guard.ts's header). The operator
 * console sends exactly that shape. A gate whose subject can approve their own
 * request is not a gate.
 */
@Controller("owner/call-access")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class OwnerCallAccessController {
  constructor(private readonly db: DbService) {}

  /** The queue, plus how this org is configured. Managers may look, not act. */
  @Get()
  @RequireOwnerRole("owner", "manager")
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query<{
        call_access_gate_enabled: boolean;
        call_access_admin_user_id: string | null;
        admin_name: string | null;
        admin_email: string | null;
      }>(
        `SELECT o.call_access_gate_enabled, o.call_access_admin_user_id,
                u.name AS admin_name, u.email AS admin_email
           FROM organizations o
           LEFT JOIN users u ON u.id = o.call_access_admin_user_id
          WHERE o.id = $1`,
        [orgId],
      );

      const { rows } = await client.query(
        `SELECT r.id, r.requested_by_email, r.reason, r.status,
                r.requested_start, r.requested_end,
                r.granted_start, r.granted_end,
                r.decided_at, r.decided_via, r.revoked_at,
                r.attempts, r.last_attempt_at,
                r.otp_sent_at, r.otp_sent_to_last3,
                r.created_at,
                u.name AS decided_by_name,
                -- Computed here rather than in the console so the list and the
                -- guard cannot disagree about what "live" means.
                (r.status = 'approved'
                 AND r.granted_start <= now() AND r.granted_end > now()) AS live
           FROM call_access_requests r
           LEFT JOIN users u ON u.id = r.decided_by_user_id
          WHERE r.org_id = $1
          ORDER BY (r.status = 'pending') DESC, r.created_at DESC
          LIMIT 100`,
        [orgId],
      );

      return {
        gateEnabled: org?.call_access_gate_enabled ?? false,
        designatedAdmin: org?.call_access_admin_user_id
          ? {
              userId: org.call_access_admin_user_id,
              name: org.admin_name,
              email: org.admin_email,
            }
          : null,
        requests: rows,
      };
    });
  }

  /**
   * Approve, with an explicit start and end.
   *
   * The window is NOT defaulted and NOT inherited from what was asked for. The
   * administrator states it, every time, because the length of time a vendor
   * can hear your calls is the entire substance of this decision and a field
   * the server filled in on their behalf would be a decision the server made.
   * (The partial/default trap, with real consequences.)
   */
  @Post(":id/approve")
  @RequireOwnerRole("owner")
  async approve(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireUser(req);
    const parsed = CallAccessApprovalInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { grantedStart, grantedEnd } = parsed.data;

    const window = validateCallAccessWindow(grantedStart, grantedEnd);
    if (!window.ok) throw new BadRequestException(window.message);

    return this.db.withOrg(orgId, async (client) => {
      // `AND status = 'pending'` in the WHERE, not checked beforehand: two
      // owners pressing approve at once must produce one decision, and the
      // second must be told it was already decided rather than overwriting the
      // first one's window.
      const {
        rows: [row],
      } = await client.query(
        `UPDATE call_access_requests
            SET status = 'approved',
                granted_start = $3, granted_end = $4,
                decided_at = now(), decided_via = 'console', decided_by_user_id = $5,
                -- Any code in flight dies here. Otherwise a narrowed grant
                -- could be widened back to the requested window by an operator
                -- redeeming a code that was sent before the narrowing.
                otp_hash = NULL, otp_expires_at = NULL,
                updated_at = now()
          WHERE id = $1 AND org_id = $2 AND status = 'pending'
          RETURNING id, status, granted_start, granted_end, decided_at, decided_via`,
        [id, orgId, grantedStart, grantedEnd, userId],
      );
      if (!row) throw new NotFoundException("no pending request with that id");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'call_access.granted', 'call_access_request', $3, $4)`,
        [orgId, userId, id, JSON.stringify({ via: "console", grantedStart, grantedEnd })],
      );
      return row;
    });
  }

  @Post(":id/deny")
  @RequireOwnerRole("owner")
  async deny(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireUser(req);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `UPDATE call_access_requests
            SET status = 'denied', decided_at = now(), decided_by_user_id = $3,
                otp_hash = NULL, otp_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND org_id = $2 AND status = 'pending'
          RETURNING id, status, decided_at`,
        [id, orgId, userId],
      );
      if (!row) throw new NotFoundException("no pending request with that id");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'call_access.denied_by_admin', 'call_access_request', $3)`,
        [orgId, userId, id],
      );
      return row;
    });
  }

  /**
   * Take it back before the window ends.
   *
   * The reason `denied` and `revoked` are separate states: one is "you may
   * not", the other is "you may no longer", and a customer looking at this
   * list a month later needs to be able to tell which happened. Revocation
   * takes effect on the operator's very next request - the guard reads this
   * row every time and holds nothing in memory.
   */
  @Post(":id/revoke")
  @RequireOwnerRole("owner")
  async revoke(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireUser(req);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `UPDATE call_access_requests
            SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE id = $1 AND org_id = $2 AND status = 'approved'
          RETURNING id, status, revoked_at`,
        [id, orgId],
      );
      if (!row) throw new NotFoundException("no approved grant with that id");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'call_access.revoked', 'call_access_request', $3)`,
        [orgId, userId, id],
      );
      return row;
    });
  }

  /**
   * The gate itself, and who is told about it.
   *
   * Owner-only, and deliberately on the CUSTOMER's controller with no operator
   * equivalent anywhere: a vendor who could switch off the gate that protects
   * the customer from the vendor has not built a gate. The operator console
   * can see the state on the instance page and cannot write it.
   */
  @Put("settings")
  @RequireOwnerRole("owner")
  async settings(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const userId = requireUser(req);
    const parsed = z
      .object({
        // No `.default()` on either: a PUT that omits a field must fail rather
        // than silently switching the gate off or clearing the designated
        // administrator.
        gateEnabled: z.boolean(),
        designatedAdminUserId: z.string().uuid().nullable(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { gateEnabled, designatedAdminUserId } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      if (designatedAdminUserId) {
        // Must be a real, active member of THIS org. Without the check a typo
        // addresses every future alert to nobody, and the failure is silent
        // until the day an alert matters.
        const {
          rows: [member],
        } = await client.query(
          `SELECT 1 FROM memberships
            WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
          [orgId, designatedAdminUserId],
        );
        if (!member) {
          throw new BadRequestException("that person is not an active member of this organisation");
        }
      }

      const {
        rows: [row],
      } = await client.query(
        `UPDATE organizations
            SET call_access_gate_enabled = $2,
                call_access_admin_user_id = $3,
                updated_at = now()
          WHERE id = $1
          RETURNING call_access_gate_enabled, call_access_admin_user_id`,
        [orgId, gateEnabled, designatedAdminUserId],
      );

      await client.query(
        // Separate params for `org_id` (uuid) and `target_id` (text): one `$N`
        // spanning both types throws 42P08 at runtime.
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'call_access.settings', 'organization', $3, $4)`,
        [orgId, userId, orgId, JSON.stringify({ gateEnabled, designatedAdminUserId })],
      );
      return row;
    });
  }
}

function requireUser(req: PrincipalRequest): string {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  if (!parsed.success) {
    throw new ForbiddenException("deciding on call access needs a signed-in administrator");
  }
  return parsed.data;
}
