import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerModuleOptions } from "@nestjs/throttler";
import type { Request } from "express";
import { resolveAdminKey } from "../common/admin-key.guard";
import { timingSafeStringEqual } from "../common/timing-safe-equal";

const MINUTE_MS = 60_000;

/**
 * Rate limiting (checklist 08 §0.7).
 *
 * The headline number is 100 requests/minute per client IP, but the shape
 * matters more than the number here, because this API has three completely
 * different kinds of caller and a naive global limit breaks two of them:
 *
 *  1. The console. `apps/web` is server-rendered and calls this API from the
 *     Next.js container with the admin key - every console request in the whole
 *     platform arrives from ONE source IP, and a single page render fans out
 *     into several calls. A per-IP limit of 100/min would cap the entire
 *     customer-facing console at roughly twenty page loads a minute, for
 *     everyone at once. Handled by `skipIf` below.
 *  2. The handset fleet. Devices poll config, beat health, and upload calls.
 *     A tenant's phones sit behind one office WiFi or one carrier NAT, so they
 *     share a source IP too, and throttling them means silently dropping
 *     recordings - the one failure this product cannot have. Handled by
 *     `@SkipThrottle()` on the device-authed routes.
 *  3. Everyone else: the open internet, probing. That is what the limit is for.
 *
 * The two named limits (5/min on POST /v1/auth/login, 10/min on POST
 * /v1/devices/register) live on their handlers via `@Throttle`.
 *
 * Storage is the in-memory default. There is one API container
 * (docker-compose.prod.yml), so counts are complete; if the API is ever scaled
 * out, the effective limit multiplies by the replica count and this needs the
 * Redis storage provider.
 */
export function throttlerOptions(): ThrottlerModuleOptions {
  return {
    throttlers: [{ name: "default", ttl: MINUTE_MS, limit: 100 }],
    skipIf: isTrustedPlatformCaller,
  };
}

/**
 * True for a caller presenting the correct admin key.
 *
 * Rate-limiting the admin key protects nothing - it is already the credential
 * that reads and writes every tenant (see the AdminKeyGuard header comment), so
 * a holder does not need volume to do damage - while throttling it would take
 * the console down, per note 1 above.
 *
 * What this deliberately does NOT skip is a WRONG or absent key. Guessing
 * ADMIN_API_KEY is exactly the attack 08 §0.2 is about, and those attempts stay
 * on the 100/min budget.
 *
 * Comparison goes through timing-safe-equal.ts, shared with AdminKeyGuard -
 * the two must not disagree, and neither should compare a secret with `===`.
 */
function isTrustedPlatformCaller(context: ExecutionContext): boolean {
  if (context.getType() !== "http") return false;

  const configured = resolveAdminKey();
  if (configured === null) return false;

  const presented = context.switchToHttp().getRequest<Request>().headers["x-admin-key"];
  const value = Array.isArray(presented) ? presented[0] : presented;
  return value !== undefined && timingSafeStringEqual(value, configured);
}
