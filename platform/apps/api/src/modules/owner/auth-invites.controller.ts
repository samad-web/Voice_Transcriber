import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { InvitesService } from "./invites.service";

const Token = z.string().min(1).max(200);
const AccessToken = z.string().min(20).max(8192);

/**
 * The invitee's half of an invite, and Google identity linking.
 *
 * SERVER-TO-SERVER ONLY, like `GET /v1/auth/context`: behind the admin key,
 * which never reaches a browser, and called by the console's public invite
 * page and its OAuth callback. Cross-tenant because the invitee has no
 * workspace yet - the token is what names one.
 *
 * Nothing here trusts the web tier about WHO signed in. `accept` and
 * `identity/link` take the person's Supabase access token and ask GoTrue.
 */
@Controller("auth")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class AuthInvitesController {
  constructor(private readonly invites: InvitesService) {}

  /** What the invite page shows. Details only for a live invite. */
  @Get("invites/preview")
  async preview(@Query("token") token: unknown) {
    const parsed = Token.safeParse(token);
    if (!parsed.success) return { status: "invalid" };
    return this.invites.preview(parsed.data);
  }

  /** "Continue with Google" was pressed on a live invite. */
  @Post("invites/prepare")
  async prepare(@Body() body: unknown) {
    const parsed = z.object({ token: Token }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.prepare(parsed.data.token);
  }

  /** Back from Google holding the token: join the workspace. */
  @Post("invites/accept")
  async accept(@Body() body: unknown) {
    const parsed = z.object({ token: Token, accessToken: AccessToken }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.accept(parsed.data.token, parsed.data.accessToken);
  }

  /** Back from Google with no invite: map to an existing user, never create one. */
  @Post("identity/link")
  async link(@Body() body: unknown) {
    const parsed = z.object({ accessToken: AccessToken }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.linkIdentity(parsed.data.accessToken);
  }
}
