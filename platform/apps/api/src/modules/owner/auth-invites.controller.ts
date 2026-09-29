import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { OperatorInvitesService } from "../admin/operator-invites.service";
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
 *
 * ── TWO KINDS OF INVITE, ONE SET OF ROUTES ──────────────────────────────────
 *
 * Doc 34 Part C added superadmin invites (0145), which have no organization. The
 * invitee's journey is identical - open a link, continue with Google, land
 * somewhere - so it reuses these three routes rather than growing a parallel set
 * that could drift on the checks that matter.
 *
 * Dispatch is by asking the operator invites whether they issued the token. That
 * is a hash lookup, and it happens FIRST because the answer is authoritative:
 * `knows()` is true only for a token that table actually holds. A token is opaque
 * and says nothing about its own kind, deliberately - a link that announced it
 * was worth platform-wide access would be a worse thing to find.
 *
 * The response carries `kind`, so the invite page can word itself for what is
 * being granted. `kind: "org"` is added here rather than inside InvitesService,
 * which predates the distinction and has no reason to know about it.
 */
@Controller("auth")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class AuthInvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly operatorInvites: OperatorInvitesService,
  ) {}

  /** What the invite page shows. Details only for a live invite. */
  @Get("invites/preview")
  async preview(@Query("token") token: unknown) {
    const parsed = Token.safeParse(token);
    if (!parsed.success) return { kind: "org" as const, status: "invalid" };
    if (await this.operatorInvites.knows(parsed.data)) {
      return this.operatorInvites.preview(parsed.data);
    }
    return { kind: "org" as const, ...(await this.invites.preview(parsed.data)) };
  }

  /** "Continue with Google" was pressed on a live invite. */
  @Post("invites/prepare")
  async prepare(@Body() body: unknown) {
    const parsed = z.object({ token: Token }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (await this.operatorInvites.knows(parsed.data.token)) {
      return this.operatorInvites.prepare(parsed.data.token);
    }
    return this.invites.prepare(parsed.data.token);
  }

  /**
   * Back from Google holding the token: join the workspace, or - for a superadmin
   * invite - become platform staff.
   *
   * The two answers differ in shape, so `kind` says which one this is. An org
   * acceptance returns the workspace it joined and the console redirects into it;
   * an operator acceptance has no workspace to name and goes to /dashboard.
   */
  @Post("invites/accept")
  async accept(@Body() body: unknown) {
    const parsed = z.object({ token: Token, accessToken: AccessToken }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (await this.operatorInvites.knows(parsed.data.token)) {
      const result = await this.operatorInvites.accept(parsed.data.token, parsed.data.accessToken);
      return { kind: "operator" as const, ...result };
    }
    const result = await this.invites.accept(parsed.data.token, parsed.data.accessToken);
    return { kind: "org" as const, ...result };
  }

  /** Back from Google with no invite: map to an existing user, never create one. */
  @Post("identity/link")
  async link(@Body() body: unknown) {
    const parsed = z.object({ accessToken: AccessToken }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.invites.linkIdentity(parsed.data.accessToken);
  }
}
