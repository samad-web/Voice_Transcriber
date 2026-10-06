import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { PartnerInvitesService } from "./partner-invites.service";

const Token = z.string().min(1).max(200);
const AccessToken = z.string().min(20).max(8192);

/**
 * The partner invitee's three routes - the mirror of
 * `AuthInvitesController` (0137), for an audience that has no membership.
 *
 * ── WHY THESE ARE *NOT* BEHIND `PartnerScopeGuard` ─────────────────────────
 *
 * There is no partner principal yet. That is the whole point of an invite: the
 * person holding the link is nobody to this platform until they accept, and a
 * guard whose job is to resolve `partner_users` would refuse all three.
 *
 * So the stack is `AdminKeyGuard + TenantGuard + @CrossTenant()`, byte for
 * byte what `AuthInvitesController` carries, and cross-tenant for the same
 * reason it is: the invitee belongs to no org, and the TOKEN is what names
 * one. Server-to-server only - the admin key never reaches a browser; the
 * portal's own invite page calls these from the Next server.
 *
 * They live under `/portal` so §17 rule 2 ("a partner may reach only
 * /portal/*") stays true of the whole surface rather than of most of it. That
 * also means they count as cross-tenant routes in `guard-mounting.spec.ts`,
 * not as part of the sixth class - which is the honest classification: an
 * acceptance spans tenants until the token has been read.
 *
 * ── AND WHY THEY ARE NOT THREE MORE BRANCHES ON /auth/invites ──────────────
 *
 * That controller dispatches by asking each invite table whether it issued the
 * token, and its org branch ends in `INSERT INTO memberships`. Adding a
 * partner branch there would mean the route that can make somebody a member of
 * a tenant and the route that can make somebody a broker are one route, with
 * the difference decided by a lookup. Migration 0163's header has the full
 * argument; this is the half of it that lives in TypeScript.
 */
@Controller("portal/invites")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class PortalInvitesController {
  constructor(private readonly invites: PartnerInvitesService) {}

  /** What the portal's invite page shows. Details only for a live invite. */
  @Get("preview")
  async preview(@Query("token") token: unknown) {
    const parsed = Token.safeParse(token);
    if (!parsed.success) return { kind: "partner" as const, status: "invalid" as const };
    return this.invites.preview(parsed.data);
  }

  /** "Continue with Google" was pressed on a live invite. */
  @Post("prepare")
  async prepare(@Body() body: unknown) {
    const parsed = z.object({ token: Token }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.prepare(parsed.data.token);
  }

  /** Back from Google holding the token: become a partner contact. */
  @Post("accept")
  async accept(@Body() body: unknown) {
    const parsed = z.object({ token: Token, accessToken: AccessToken }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.accept(parsed.data.token, parsed.data.accessToken);
  }
}
