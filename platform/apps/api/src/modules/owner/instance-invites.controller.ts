import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { tenantRoleForOwnerRole } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { INVITE_TTL_MAX_HOURS, INVITE_TTL_MIN_HOURS } from "./invite-token";
import { InvitesService } from "./invites.service";

const Delivery = {
  /** Email the link now. Off means "just give me the link". */
  send: z.boolean().default(false),
  ttlHours: z.number().int().min(INVITE_TTL_MIN_HOURS).max(INVITE_TTL_MAX_HOURS).optional(),
};

const IssueBody = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(200).optional(),
  /** Same default as `POST /v1/owners`: listening is a privacy event owners get. */
  recordingsListen: z.boolean().default(true),
  recordingsExport: z.boolean().default(false),
  ...Delivery,
});

const ResendBody = z.object(Delivery);

/**
 * Invite an instance's OWNER by link (0137) - the operator console's half.
 *
 * The owner console's Team tab invites colleagues into its own workspace
 * (`owner-invites.controller.ts`). This is the provider inviting the first
 * owner of a customer's instance, beside "Create owner login" on the instance
 * page: same InvitesService, the persona fixed to `owner`.
 *
 * Tenant-scoped like `OwnersController` (the instance page sends the org), and
 * every WRITE also requires the `x-operator-email` the operator console sends
 * (0122). The owner console never sends it, so this cannot become a way for a
 * customer's own staff to mint owners - their Team tab, with its
 * `@RequireOwnerRole("owner")`, is the only door for that.
 */
@Controller("instance-invites")
@UseGuards(AdminKeyGuard, TenantGuard)
export class InstanceInvitesController {
  constructor(private readonly invites: InvitesService) {}

  private operator(req: PrincipalRequest): { id: string } {
    const email = req.principal?.operatorEmail;
    if (!email) throw new ForbiddenException("operator console only");
    // Not a users row in this tenant: invited_by stays NULL and the audit
    // row names the operator by email, as the call-access gate does (0122).
    return { id: email };
  }

  /** Read-only, like `GET /v1/owners`: the instance page reads it server-side. */
  @Get()
  async list(@OrgId() orgId: string) {
    return {
      invites: (await this.invites.list(orgId)).filter((i) => i.ownerRole === "owner"),
      mailConfigured: this.invites.mailConfigured,
      authConfigured: this.invites.authConfigured,
    };
  }

  @Post()
  async issue(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const actor = this.operator(req);
    const parsed = IssueBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    return this.invites.issue(
      orgId,
      {
        email: p.email,
        name: p.name ?? null,
        ownerRole: "owner",
        tenantRole: tenantRoleForOwnerRole("owner"),
        telecallerId: null,
        recordingsListen: p.recordingsListen,
        recordingsExport: p.recordingsExport,
        phone: null,
        whatsapp: null,
      },
      actor,
      { send: p.send, ttlHours: p.ttlHours },
    );
  }

  @Post(":id/resend")
  async resend(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const actor = this.operator(req);
    const parsed = ResendBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.resend(orgId, id, actor, parsed.data);
  }

  @Delete(":id")
  async revoke(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: PrincipalRequest) {
    return this.invites.revoke(orgId, id, this.operator(req));
  }
}
