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
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import {
  CallAccessOtpInput,
  CallAccessRequestInput,
  CALL_ACCESS_OTP_MAX_ATTEMPTS,
  CALL_ACCESS_OTP_TTL_MS,
  validateCallAccessWindow,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import {
  generateCallAccessOtp,
  hashCallAccessOtp,
  lastThreeDigits,
  verifyCallAccessOtp,
} from "../../common/call-access-otp";
import { OperatorOnlyGuard } from "../../common/operator-only.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { sendCallAccessOtp } from "./call-access-otp.sender";

/**
 * The PLATFORM OPERATOR's side of the call-access gate (migration 0122).
 *
 * Asking a customer for permission to hear their calls, and finding out what
 * they said. The deciding happens on the other controller, in the customer's
 * own console, which is the point.
 *
 * `OperatorOnlyGuard` refuses any request carrying a real user identity, so a
 * tenant's own console can never reach these routes - an owner approving their
 * own vendor's request through the operator surface would defeat the whole
 * mechanism. It also means every caller here is, by construction, the same
 * shape of principal `CallAccessGuard` gates.
 */
@Controller("call-access")
@UseGuards(AdminKeyGuard, TenantGuard, OperatorOnlyGuard)
export class CallAccessController {
  constructor(private readonly db: DbService) {}

  /** Where this operator stands with this tenant right now. */
  @Get("mine")
  async mine(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const email = requireOperatorEmail(req);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query<{ call_access_gate_enabled: boolean }>(
        `SELECT call_access_gate_enabled FROM organizations WHERE id = $1`,
        [orgId],
      );
      const { rows } = await client.query(
        `SELECT id, status, reason, requested_start, requested_end,
                granted_start, granted_end, decided_at, decided_via,
                attempts, last_attempt_at, otp_sent_at, otp_sent_to_last3,
                otp_expires_at, created_at
           FROM call_access_requests
          WHERE org_id = $1 AND lower(btrim(requested_by_email)) = lower(btrim($2))
          ORDER BY created_at DESC
          LIMIT 20`,
        [orgId, email],
      );
      return { gateEnabled: org?.call_access_gate_enabled ?? false, requests: rows };
    });
  }

  /**
   * Ask, explicitly, with a reason and a proposed window.
   *
   * Distinct from the request `CallAccessGuard` raises on a blocked read: that
   * one is a side effect of bumping into the gate and carries a generic
   * reason, this one is somebody deciding to ask properly. Both collapse onto
   * the same open row - the partial unique index in 0122 permits exactly one
   * per operator per org - so asking properly after being blocked UPDATES the
   * reason and the window rather than queueing a second request the
   * administrator would have to answer twice.
   */
  @Post("requests")
  async request(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const email = requireOperatorEmail(req);
    const parsed = CallAccessRequestInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { reason, requestedStart, requestedEnd } = parsed.data;

    const window = validateCallAccessWindow(requestedStart, requestedEnd);
    if (!window.ok) throw new BadRequestException(window.message);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO call_access_requests
           (org_id, requested_by_email, reason, requested_start, requested_end)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, lower(btrim(requested_by_email))) WHERE status = 'pending'
         DO UPDATE SET reason          = EXCLUDED.reason,
                       requested_start = EXCLUDED.requested_start,
                       requested_end   = EXCLUDED.requested_end,
                       updated_at      = now()
         RETURNING id, status, reason, requested_start, requested_end, attempts, created_at`,
        [orgId, email, reason, requestedStart, requestedEnd],
      );
      return row;
    });
  }

  /**
   * Send a one-time code to the administrator's phone.
   *
   * ── THIS SENDS A REAL MESSAGE TO A REAL PERSON ────────────────────────────
   *
   * Off unless `CALL_ACCESS_OTP_ENABLED=true` AND the deployment's existing
   * `WHATSAPP_SENDING_ENABLED=true`. Both, deliberately: the second is the
   * platform's switch for all outbound WhatsApp, and this feature must not be
   * the thing that quietly turns messaging on for a deployment that had it
   * off. A deployment with either unset gets a clear refusal and the console
   * approval path, which sends nothing anywhere.
   *
   * The code proves the person holding the administrator's phone agreed. It is
   * therefore the ONLY thing standing between an operator and a customer's
   * recordings on this path, which is why the message states the window and
   * the reason in full - a code with no context is consent to nothing.
   */
  @Post("requests/:id/otp")
  async sendOtp(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const email = requireOperatorEmail(req);
    if (process.env.CALL_ACCESS_OTP_ENABLED !== "true") {
      throw new ServiceUnavailableException(
        "one-time codes are switched off on this deployment (CALL_ACCESS_OTP_ENABLED) - " +
          "ask the administrator to approve from their console instead",
      );
    }
    if (process.env.WHATSAPP_SENDING_ENABLED !== "true") {
      throw new ServiceUnavailableException(
        "outbound WhatsApp is switched off on this deployment (WHATSAPP_SENDING_ENABLED)",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [request],
      } = await client.query<{
        id: string;
        status: string;
        reason: string;
        requested_start: Date;
        requested_end: Date;
        otp_sent_at: Date | null;
      }>(
        `SELECT id, status, reason, requested_start, requested_end, otp_sent_at
           FROM call_access_requests
          WHERE id = $1 AND org_id = $2
            AND lower(btrim(requested_by_email)) = lower(btrim($3))`,
        [id, orgId, email],
      );
      if (!request) throw new NotFoundException("request not found");
      if (request.status !== "pending") {
        throw new BadRequestException(`this request is already ${request.status}`);
      }

      // One code a minute, at most. Without this the route is a free way to
      // make somebody's phone buzz indefinitely, which is both a nuisance to
      // the customer and the fastest route to the business's number being
      // reported.
      if (request.otp_sent_at && Date.now() - request.otp_sent_at.getTime() < 60_000) {
        throw new BadRequestException("a code was just sent - wait a minute before asking for another");
      }

      const { rows: admins } = await client.query<{
        user_id: string;
        phone: string | null;
        name: string | null;
      }>(
        `SELECT m.user_id, m.phone, u.name
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN organizations o ON o.id = m.org_id
          WHERE m.org_id = $1 AND m.status = 'active' AND m.phone IS NOT NULL
            AND (
              (o.call_access_admin_user_id IS NOT NULL AND m.user_id = o.call_access_admin_user_id)
              OR (o.call_access_admin_user_id IS NULL AND m.owner_role = 'owner')
            )
          ORDER BY (o.call_access_admin_user_id = m.user_id) DESC NULLS LAST
          LIMIT 1`,
        [orgId],
      );
      const admin = admins[0];
      if (!admin?.phone) {
        throw new BadRequestException(
          "this organisation's administrator has no phone number on file, so no code can be sent - " +
            "ask them to approve from their console instead",
        );
      }

      const code = generateCallAccessOtp();
      const expiresAt = new Date(Date.now() + CALL_ACCESS_OTP_TTL_MS);

      // Send BEFORE storing the hash. If the send throws, nothing has changed
      // and the operator can try again; storing first would leave a live code
      // nobody ever received, which reads to the administrator as a code they
      // missed rather than one that was never sent.
      await sendCallAccessOtp(client, {
        orgId,
        toPhone: admin.phone,
        code,
        operatorEmail: email,
        reason: request.reason,
        windowStart: request.requested_start,
        windowEnd: request.requested_end,
      });

      await client.query(
        `UPDATE call_access_requests
            SET otp_hash = $2, otp_expires_at = $3, otp_attempts = 0,
                otp_sent_at = now(), otp_sent_to_last3 = $4, updated_at = now()
          WHERE id = $1`,
        [id, hashCallAccessOtp(code), expiresAt, lastThreeDigits(admin.phone)],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'operator', $2, 'call_access.otp_sent', 'call_access_request', $3, $4)`,
        [orgId, email, id, JSON.stringify({ toLast3: lastThreeDigits(admin.phone) })],
      );

      // Never the code itself, not even to the operator who asked for it to be
      // sent. The whole point is that it travels to the administrator and back
      // through them.
      return {
        sent: true,
        toLast3: lastThreeDigits(admin.phone),
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /**
   * Redeem the code the administrator read out.
   *
   * A successful redemption grants the window the operator ASKED for, because
   * that is the window the message quoted and therefore the only one the
   * administrator agreed to. An administrator who wants to narrow it uses
   * their console instead.
   */
  @Post("requests/:id/redeem")
  async redeem(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const email = requireOperatorEmail(req);
    const parsed = CallAccessOtpInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      // FOR UPDATE: two redemptions racing must not both spend the attempt
      // budget against a stale count, and must not both approve. Same
      // serialisation the qualification queue uses for two reviewers.
      const {
        rows: [request],
      } = await client.query<{
        id: string;
        status: string;
        otp_hash: string | null;
        otp_expires_at: Date | null;
        otp_attempts: number;
        requested_start: Date;
        requested_end: Date;
      }>(
        `SELECT id, status, otp_hash, otp_expires_at, otp_attempts,
                requested_start, requested_end
           FROM call_access_requests
          WHERE id = $1 AND org_id = $2
            AND lower(btrim(requested_by_email)) = lower(btrim($3))
          FOR UPDATE`,
        [id, orgId, email],
      );
      if (!request) throw new NotFoundException("request not found");
      if (request.status !== "pending") {
        throw new BadRequestException(`this request is already ${request.status}`);
      }
      if (!request.otp_hash || !request.otp_expires_at) {
        throw new BadRequestException("no code has been sent for this request");
      }
      if (request.otp_expires_at.getTime() <= Date.now()) {
        throw new BadRequestException("that code has expired - ask for a new one");
      }
      if (request.otp_attempts >= CALL_ACCESS_OTP_MAX_ATTEMPTS) {
        throw new BadRequestException("too many wrong codes - ask for a new one");
      }

      if (!verifyCallAccessOtp(parsed.data.code, request.otp_hash)) {
        await client.query(
          `UPDATE call_access_requests
              SET otp_attempts = otp_attempts + 1, updated_at = now()
            WHERE id = $1`,
          [id],
        );
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
           VALUES ($1, 'operator', $2, 'call_access.otp_failed', 'call_access_request', $3)`,
          [orgId, email, id],
        );
        throw new ForbiddenException("that code is not right");
      }

      // Correct. Spend the code - single use, always, whatever happens next.
      const {
        rows: [granted],
      } = await client.query(
        `UPDATE call_access_requests
            SET status = 'approved',
                granted_start = requested_start,
                granted_end   = requested_end,
                decided_at    = now(),
                decided_via   = 'otp',
                -- decided_by_user_id stays NULL: nobody signed in, and 0122's
                -- CHECK requires exactly that pairing for an OTP decision.
                otp_hash = NULL, otp_expires_at = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING id, status, granted_start, granted_end, decided_at, decided_via`,
        [id],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'operator', $2, 'call_access.granted', 'call_access_request', $3, $4)`,
        [
          orgId,
          email,
          id,
          JSON.stringify({
            via: "otp",
            grantedStart: request.requested_start,
            grantedEnd: request.requested_end,
          }),
        ],
      );

      return granted;
    });
  }
}

/**
 * The operator behind this request, or a refusal.
 *
 * `OperatorOnlyGuard` has already established that no real user is behind the
 * call; this establishes that we know WHICH operator, which the request row
 * cannot exist without. A script holding the bare admin key gets a 403 here
 * for the same reason `CallAccessGuard` gives it one: an access request
 * nobody's name is on is not a request anybody can answer.
 */
function requireOperatorEmail(req: PrincipalRequest): string {
  const email = req.principal?.operatorEmail;
  if (!email) {
    throw new ForbiddenException(
      "this endpoint needs to know which operator is asking - use the operator console",
    );
  }
  return email;
}
