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
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { AuthService } from "./auth.service";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /**
   * Optional hint for a user who belongs to more than one org — without it,
   * `AuthService.login` falls back to the earliest-created membership, which
   * is unreachable-by-design for any OTHER org a multi-org user belongs to.
   * Ignored if the caller isn't actually a member of the named org.
   */
  orgId: z.string().uuid().optional(),
});

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
  // 5/min per IP (checklist 08 §0.7). This is the only endpoint on the platform
  // that turns a guess into a session, and it is also expensive to guess at:
  // AuthService.login matches on `lower(u.email)` while the only index on the
  // column is UNIQUE(email) over the raw value, so every attempt sequentially
  // scans `users`. The limit caps both the brute force and the scan.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() body: unknown) {
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await this.auth.login(parsed.data.email, parsed.data.password, parsed.data.orgId);
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
  @UseGuards(AdminKeyGuard, TenantGuard)
  @CrossTenant()
  async context(@Query() query: unknown) {
    const parsed = ContextQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.auth.contextFor(parsed.data);
  }

  /** Who am I — proves the session + surfaces role/permissions to the web app. */
  @Get("me")
  @UseGuards(AdminKeyGuard, TenantGuard)
  @CrossTenant()
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
