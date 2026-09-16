import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { resolveAdminKey } from "../../common/admin-key.guard";
import { timingSafeStringEqual } from "../../common/timing-safe-equal";

/**
 * The admin key, and nothing else.
 *
 * `/v1/internal/events` is reachable from the open internet like every other
 * `/v1/*` route (Caddy and nginx both send the whole prefix to this process),
 * so "internal" is a statement about intent, not about the network. The control
 * is the credential.
 *
 * Deliberately NOT `AdminKeyGuard`: that one also accepts a user session,
 * resolves memberships and validates `x-org-id` against the database. None of
 * that applies here - this stream is cross-tenant by construction, has exactly
 * one legitimate caller (the web tier's fanout), and must not open a database
 * connection per connection attempt. A narrower guard is the point.
 *
 * In production `resolveAdminKey()` returns null when ADMIN_API_KEY is unset,
 * and this then denies everybody rather than falling back to the dev literal
 * published in this repository.
 */
@Injectable()
export class InternalStreamGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const configured = resolveAdminKey();
    if (configured === null) throw new UnauthorizedException();

    const header = req.headers["x-admin-key"];
    const presented = Array.isArray(header) ? header[0] : header;
    if (presented === undefined || !timingSafeStringEqual(presented, configured)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
