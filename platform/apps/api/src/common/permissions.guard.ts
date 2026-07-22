import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  type Permission,
  type PrincipalRequest,
  principalHasPermission,
} from "./auth-principal";

export const PERMISSION_KEY = "required_permission";

/** Mark a route as requiring a specific privacy permission. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

/**
 * Enforces `@RequirePermission(...)`. Runs AFTER AdminKeyGuard, so `req.principal`
 * is set. platform_admin / admin-key pass everything; session users are checked
 * against their membership's `recordings:listen` / `recordings:export` grants.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    if (!req.principal || !principalHasPermission(req.principal, required)) {
      throw new ForbiddenException(`missing permission: ${required}`);
    }
    return true;
  }
}
