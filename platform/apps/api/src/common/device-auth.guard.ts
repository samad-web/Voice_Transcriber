import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import * as jwt from "jsonwebtoken";

export interface DevicePrincipal {
  deviceId: string;
  orgId: string;
  instanceId: string;
  cfgVer: number;
}

export interface DeviceRequest extends Request {
  device: DevicePrincipal;
}

/** Validates the 15-minute device access JWT issued by /v1/devices/authenticate. */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<DeviceRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("device access token required");
    }
    try {
      const payload = jwt.verify(
        header.slice("Bearer ".length),
        process.env.JWT_SECRET ?? "dev-jwt-secret-change-me",
      ) as jwt.JwtPayload;
      if (payload.scope !== "device" || typeof payload.sub !== "string") {
        throw new Error("wrong token scope");
      }
      req.device = {
        deviceId: payload.sub,
        orgId: payload.org_id,
        instanceId: payload.instance_id,
        cfgVer: payload.cfg_ver ?? 0,
      };
      return true;
    } catch {
      throw new UnauthorizedException("invalid or expired device token");
    }
  }
}
