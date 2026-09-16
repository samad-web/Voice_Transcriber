import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { type Observable, tap } from "rxjs";
import { actionForMethod, topicForApiPath } from "@aura/shared";
import type { PrincipalRequest } from "../../common/auth-principal";
import { RealtimeService } from "./realtime.service";

/** Verbs that change something. GET and HEAD announce nothing. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every successful mutation announces itself.
 *
 * ── WHY AN INTERCEPTOR AND NOT AN EMIT AT EACH WRITE ──────────────────────
 *
 * There are sixty-odd controllers in this API and there will be more next
 * month. A rule that says "remember to publish an event after you write" is a
 * rule that holds for about three weeks: the twentieth controller forgets, its
 * page quietly stops updating, and the symptom is stale numbers with no error
 * anywhere - the least detectable kind of bug there is.
 *
 * Mounting it once, globally, inverts that. A new route is live by default and
 * has to opt OUT (by being on the silent list in packages/shared/realtime.ts)
 * rather than opt in. The topic is derived from the route itself, so nobody has
 * to maintain a mapping either.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not announce failures. `tap`'s next handler runs only when the
 * handler completed, so a 400 or a guard's 403 emits nothing - a console
 * re-reading because somebody's invalid form was rejected would be pure noise.
 *
 * It does not guess the org. If the request never resolved a tenant - an
 * unauthenticated webhook that looks its own org up internally, a cross-tenant
 * admin route with no single subject - it stays silent and the handler is left
 * to publish for itself with the org it worked out. Guessing here would mean
 * signalling the wrong tenant, and the one thing this must never do is tell
 * org A that something happened when it happened to org B.
 */
@Injectable()
export class RealtimeInterceptor implements NestInterceptor {
  constructor(private readonly realtime: RealtimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    if (!MUTATING.has(req.method)) return next.handle();

    return next.handle().pipe(
      tap(() => {
        try {
          this.announce(req);
        } catch {
          // A change signal is a courtesy. It must never turn a request that
          // already succeeded into a 500 the caller sees.
        }
      }),
    );
  }

  private announce(req: PrincipalRequest): void {
    const orgId = this.orgOf(req);
    if (!orgId) return;

    const topic = topicForApiPath(req.path ?? req.url ?? "");
    if (!topic) return;

    const id = typeof req.params?.id === "string" && UUID.test(req.params.id) ? req.params.id : null;

    this.realtime.publish({
      orgId,
      topic,
      action: actionForMethod(req.method),
      id,
      at: new Date().toISOString(),
    });
  }

  /**
   * The tenant this request acted on, in order of how much it is trusted.
   *
   * `tenantOrgId` is what TenantGuard pinned and is the answer wherever it
   * exists. `apiKey.orgId` is the tenant a headless integration key belongs to.
   * `principal.orgId` covers the session and admin-key routes that TenantGuard
   * does not mount on. `device.orgId` covers the handset fleet, which carries
   * neither of the first two - DeviceAuthGuard writes `req.device` and nothing
   * else (device-auth.guard.ts) - and which is where the product's primary
   * input actually arrives: a recording finishing its upload is the moment a
   * call appears in somebody's log. It is a claim out of a JWT this platform
   * signed and verified, so it is a fact, not caller input.
   *
   * The raw `x-org-id` header is NOT consulted: on these routes it is either
   * already reflected in one of the above or it is unvalidated caller input,
   * and an unvalidated org is how a signal ends up announced to the wrong
   * tenant.
   */
  private orgOf(req: PrincipalRequest): string | null {
    const candidate =
      req.tenantOrgId ??
      req.apiKey?.orgId ??
      req.principal?.orgId ??
      (req as { device?: { orgId?: string } }).device?.orgId ??
      null;
    return candidate && UUID.test(candidate) ? candidate : null;
  }
}
