import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import * as jwt from "jsonwebtoken";
import { jwtSecret } from "../config/secrets";

export interface DevicePrincipal {
  deviceId: string;
  orgId: string;
  instanceId: string;
  cfgVer: number;
}

export interface DeviceRequest extends Request {
  device: DevicePrincipal;
}

/**
 * A uuid, as this schema writes them.
 *
 * Deliberately a shape check and not a database read. See the class comment for
 * why this guard stays dependency-free, and why that is not the same as
 * trusting the token.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates the 15-minute device access JWT issued by /v1/devices/authenticate.
 *
 * ── WHAT THIS GUARD DOES NOT DO, AND WHY THAT IS SAFE ───────────────────────
 *
 * It does not read the database. Doc 49 P6b asks for a cached device-row
 * re-read here, and the reason it is not here is worth stating, because the
 * alternative is a round trip on the hottest `@SkipThrottle()`d route on the
 * platform:
 *
 * The TENANT boundary is not enforced by this guard at all - it is enforced by
 * RLS, one layer down. Every device handler opens `db.withOrg(orgId, ...)` with
 * the org from this token and then reads its own device row by id. So a token
 * whose `org_id` names the WRONG tenant enters that tenant's RLS context and
 * finds no device row at all, because the row lives in the other org - and the
 * handler returns 409 "device or org is not active" rather than acting. A
 * forged token therefore cannot reach another tenant's data by naming it; it
 * can only reach a context where it owns nothing.
 *
 * That property is load-bearing and emergent, which is a bad combination, so
 * `device-auth.guard.spec.ts` pins it explicitly rather than leaving it to be
 * rediscovered.
 *
 * Revocation is likewise the handler's job and is already built: the handlers
 * refuse any device whose `status` is not `active`, and `POST /devices/:id/logout`,
 * `/wipe` and `/owner/devices/:id/revoke` all set it. The cost is that an
 * already-issued token stays cryptographically valid for the remainder of its
 * 15 minutes while doing nothing - which is the right trade against a database
 * read per ingest request.
 *
 * ── WHAT IT DOES DO, SINCE P6b ──────────────────────────────────────────────
 *
 * It validates the CLAIMS' shape. The guard used to copy `org_id` and
 * `instance_id` straight out of the payload with no parsing, so a token
 * carrying neither produced `req.device.orgId === undefined`, which the
 * handlers passed into `withOrg(undefined)` - a tenant context set from
 * nothing. Failing closed here is one regex and removes a whole class of
 * question about what that context contains.
 */
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
        jwtSecret(),
        { algorithms: ["HS256"] },
      ) as jwt.JwtPayload;
      if (payload.scope !== "device" || typeof payload.sub !== "string") {
        throw new Error("wrong token scope");
      }
      // ── EVERY CLAIM THE HANDLERS WILL TRUST, VALIDATED HERE ─────────────
      //
      // `org_id` becomes the RLS context and `instance_id` is written onto
      // rows, so neither may be undefined, a number, or a string that is not a
      // uuid. This is a SHAPE check: it does not prove the device belongs to
      // that org (RLS does - see the class comment), it proves the handler is
      // not about to open a tenant context from nothing.
      if (!UUID.test(String(payload.org_id ?? ""))) {
        throw new Error("token carries no usable org_id");
      }
      if (!UUID.test(String(payload.instance_id ?? ""))) {
        throw new Error("token carries no usable instance_id");
      }
      if (!UUID.test(payload.sub)) {
        throw new Error("token subject is not a device id");
      }
      req.device = {
        deviceId: payload.sub,
        orgId: payload.org_id as string,
        instanceId: payload.instance_id as string,
        cfgVer: typeof payload.cfg_ver === "number" ? payload.cfg_ver : 0,
      };
      return true;
    } catch {
      throw new UnauthorizedException("invalid or expired device token");
    }
  }
}
