import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { OwnerRole, tenantRoleForOwnerRole } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { consolePhone, orgPhoneCountry } from "../../common/console-phone";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { INVITE_TTL_MAX_HOURS, INVITE_TTL_MIN_HOURS } from "./invite-token";
import { InvitesService } from "./invites.service";

const PhoneNumber = z.string().trim().max(40);
const blankToNull = (value: string | null | undefined): string | null => (value && value.trim() ? value : null);

/** Delivery options, shared by issue and resend. */
const Delivery = {
  /** Email the link now. Off means "just give me the link". */
  send: z.boolean().default(false),
  ttlHours: z.number().int().min(INVITE_TTL_MIN_HOURS).max(INVITE_TTL_MAX_HOURS).optional(),
};

/**
 * The same fields as `POST /v1/owner/team` (owner-team.controller.ts), for the
 * same reasons - above all, `ownerRole` is REQUIRED with no default, so a
 * missing field can never invite somebody as an Owner.
 */
const IssueBody = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(200).optional(),
  ownerRole: OwnerRole,
  telecallerId: z.string().uuid().nullable().optional(),
  phone: PhoneNumber.nullish(),
  whatsapp: PhoneNumber.nullish(),
  recordingsListen: z.boolean().default(false),
  recordingsExport: z.boolean().default(false),
  ...Delivery,
});

const ResendBody = z.object(Delivery);

/**
 * Invite a colleague by link (migration 0137) - the owner's half.
 *
 * Beside "Create login" on the Team tab, not instead of it: that path still
 * suits somebody with no Google account. Same authority as that path -
 * `@RequireOwnerRole("owner")` on every write, enforced by `OwnerRoleGuard`
 * from `memberships`, not from anything the web tier asserts. A manager may
 * SEE who has been invited, as they may see the roster.
 *
 * `/owner/invites`, not `/owner/team/invites`: the team controller has
 * `:userId` routes, and a sibling path that could be read as one is a routing
 * question nobody should have to answer.
 */
@Controller("owner/invites")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class OwnerInvitesController {
  constructor(
    private readonly db: DbService,
    private readonly invites: InvitesService,
  ) {}

  @Get()
  @RequireOwnerRole("owner", "manager")
  async list(@OrgId() orgId: string) {
    return {
      invites: await this.invites.list(orgId),
      // Said up front so the form can offer "Email it" only when it would work.
      mailConfigured: this.invites.mailConfigured,
      authConfigured: this.invites.authConfigured,
    };
  }

  @Post()
  @RequireOwnerRole("owner")
  async issue(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = IssueBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    // Normalised now, not at acceptance: the owner is the one who can fix a
    // bad number, and they are here now.
    const country = await this.db.withOrg(orgId, (client) => orgPhoneCountry(client, orgId));
    const phone = consolePhone(blankToNull(p.phone), "phone", country);
    const whatsapp = consolePhone(blankToNull(p.whatsapp), "whatsapp", country);

    return this.invites.issue(
      orgId,
      {
        email: p.email,
        name: p.name ?? null,
        ownerRole: p.ownerRole,
        // One rung below the persona - see tenantRoleForOwnerRole.
        tenantRole: tenantRoleForOwnerRole(p.ownerRole),
        telecallerId: p.telecallerId ?? null,
        recordingsListen: p.recordingsListen,
        recordingsExport: p.recordingsExport,
        phone,
        whatsapp,
      },
      { id: req.principal?.userId ?? "unknown" },
      { send: p.send, ttlHours: p.ttlHours },
    );
  }

  /** A new link and a new expiry. The old link stops working at once. */
  @Post(":id/resend")
  @RequireOwnerRole("owner")
  async resend(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = ResendBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.resend(orgId, id, { id: req.principal?.userId ?? "unknown" }, parsed.data);
  }

  @Delete(":id")
  @RequireOwnerRole("owner")
  async revoke(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: PrincipalRequest) {
    return this.invites.revoke(orgId, id, { id: req.principal?.userId ?? "unknown" });
  }
}
