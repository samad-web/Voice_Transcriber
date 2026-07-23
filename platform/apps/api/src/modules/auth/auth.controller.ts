import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { AuthService } from "./auth.service";

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

const ContextQuery = z
  .object({
    /** Supabase Auth user id, stored as users.sso_subject. */
    subject: z.string().min(1).max(200).optional(),
    email: z.string().email().max(200).optional(),
  })
  .refine((v) => v.subject || v.email, { message: "subject or email is required" });

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Dev credential login → session bearer token (OIDC swaps in here later). */
  @Post("login")
  async login(@Body() body: unknown) {
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await this.auth.login(parsed.data.email, parsed.data.password);
    if (!result) throw new UnauthorizedException("invalid email or password");
    return {
      token: result.token,
      user: {
        userId: result.principal.userId,
        orgId: result.principal.orgId,
        role: result.principal.role,
        recordingsListen: result.principal.recordingsListen,
        recordingsExport: result.principal.recordingsExport,
      },
    };
  }

  /**
   * Resolve an external identity to its tenant binding.
   *
   * The console signs in against Supabase Auth, which knows nothing about orgs.
   * This is how the web app turns "user 3f2a… is signed in" into "and they own
   * instance X", so every page it renders is scoped to that org instead of a
   * build-time DEV_ORG_ID.
   *
   * Server-to-server only: it is behind the admin key, which never reaches a
   * browser. It answers `{ memberships: [] }` for an unknown subject rather
   * than 404, so the caller cannot use it to probe which accounts exist.
   */
  @Get("context")
  @UseGuards(AdminKeyGuard)
  async context(@Query() query: unknown) {
    const parsed = ContextQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.auth.contextFor(parsed.data);
  }

  /** Who am I — proves the session + surfaces role/permissions to the web app. */
  @Get("me")
  @UseGuards(AdminKeyGuard)
  me(@Req() req: PrincipalRequest) {
    return { principal: req.principal };
  }

  @Post("logout")
  async logout(@Req() req: PrincipalRequest) {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) await this.auth.logout(header.slice("Bearer ".length));
    return { ok: true };
  }
}
