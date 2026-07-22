import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { AuthService } from "./auth.service";

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

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
