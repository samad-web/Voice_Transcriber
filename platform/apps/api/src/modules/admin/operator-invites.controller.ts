import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { INVITE_TTL_MAX_HOURS, INVITE_TTL_MIN_HOURS } from "../owner/invite-token";
import { OperatorInvitesService } from "./operator-invites.service";

const IssueInvite = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  note: z.string().trim().max(200).optional(),
  ttlHours: z.number().int().min(INVITE_TTL_MIN_HOURS).max(INVITE_TTL_MAX_HOURS).optional(),
  sendEmail: z.boolean().default(false),
  /** Who is granting it, for the audit trail on the resulting row. */
  invitedBy: z.string().trim().toLowerCase().email().max(200),
});

const Resend = z.object({ sendEmail: z.boolean().default(false) });

/**
 * Superadmin invitations (migration 0145, doc 34 Part C).
 *
 * Mounted beside OperatorsController and under the same guards, and - like it -
 * this is honestly an admin-key surface. "Only the root operator may invite a
 * superadmin" is enforced in the web tier by `requireMax()`, because every
 * console request arrives here on one shared `ADMIN_API_KEY` and this layer
 * cannot tell one operator from another. See OperatorsController's header, which
 * sets out that reasoning in full; repeating the check here would be theatre.
 *
 * The invariants this layer CAN hold, it holds in the service: the root address
 * is never invited, and neither is somebody who is already a superadmin.
 *
 * Note the acceptance routes are NOT here. They are public - the invitee has no
 * admin key - and live on `auth-invites.controller.ts` with the owner ones,
 * dispatching on which table holds the token.
 */
@Controller("admin/operator-invites")
@UseGuards(AdminKeyGuard, TenantGuard)
// A platform operator belongs to no org, so there is no tenant to scope to.
@CrossTenant()
export class OperatorInvitesController {
  constructor(private readonly invites: OperatorInvitesService) {}

  /**
   * Every invite, and whether this deployment can mail one.
   *
   * `mailConfigured` rides along so the form can say "we will email it" or "copy
   * this link" before somebody presses the button, rather than reporting the
   * absence of SMTP as if it were a failure afterwards.
   */
  @Get()
  async list() {
    return { invites: await this.invites.list(), mailConfigured: this.invites.mailConfigured };
  }

  @Post()
  async issue(@Body() body: unknown) {
    const parsed = IssueInvite.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "Invalid invite");
    return this.invites.issue(parsed.data);
  }

  @Post(":id/resend")
  async resend(@Param("id") id: string, @Body() body: unknown) {
    const parsed = Resend.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException("Invalid request");
    return this.invites.resend(id, parsed.data);
  }

  @Delete(":id")
  async revoke(@Param("id") id: string) {
    return this.invites.revoke(id);
  }
}
