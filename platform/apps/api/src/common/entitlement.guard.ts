import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type EntitlementKey, cheapestPlanWith } from "@aura/shared";
import { EntitlementsService } from "../modules/entitlements/entitlements.service";
import type { PrincipalRequest } from "./auth-principal";

export const ENTITLEMENT_KEY = "required_entitlement";

export interface EntitlementRequirement {
  key: EntitlementKey;
  /** For a graded entitlement: the lowest variant that will do. */
  minVariant?: string;
}

/**
 * The plan entitlement a route requires.
 *
 * Mounted per-handler, never per-controller, for the reason `RequireScope`
 * gives: adding a route to an existing controller must not inherit an
 * unexamined grant. A route with no decorator is NOT refused here, unlike
 * `ApiKeyGuard`'s scope check - most routes are not plan-gated at all, and
 * making the absence of a decorator fail would mean annotating two hundred
 * controllers to keep the console working.
 *
 * That difference is the one thing to be careful about when adding a gated
 * route: **forgetting this decorator fails OPEN.** The protection against
 * forgetting is `entitlement-coverage.spec.ts`, which reflects over the real
 * controller metadata and fails the build for a route in its list that has no
 * decorator - the same mechanism `agent-gate-coverage.spec.ts` uses for the
 * feature gate, and for the same reason: a gate nobody can see is a gate
 * nobody notices is missing.
 */
export const RequireEntitlement = (key: EntitlementKey, minVariant?: string) =>
  SetMetadata(ENTITLEMENT_KEY, { key, minVariant } satisfies EntitlementRequirement);

/**
 * Enforces `@RequireEntitlement(...)`, and renders the spec's §9.4 body.
 *
 * ── THE BODY SHAPE IS PART OF THE CONTRACT ──────────────────────────────────
 *
 * §9.4 asks for a stable body "so integrators can handle it programmatically":
 *
 *     { code, message, required_plan, upgrade_url, request_id }
 *
 * `required_plan` is DERIVED from `PLAN_SEED` by `cheapestPlanWith`, not
 * written down next to the decorator. A hand-maintained "this needs Growth"
 * goes stale the first time product moves a feature down a tier, and the
 * staleness would be invisible: the 403 still arrives, it just names the wrong
 * plan, and the integrator's support ticket is about a plan they already have.
 *
 * ── RUNS AFTER TenantGuard OR ApiKeyGuard ───────────────────────────────────
 *
 * It needs `req.principal.orgId`, so list it after whichever guard established
 * the tenant. On the console side that is `AdminKeyGuard, TenantGuard`; on the
 * ingestion side `ApiKeyGuard, TenantGuard`. Both write `principal.orgId` from
 * something the caller cannot choose, which is what makes it safe to gate on.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<EntitlementRequirement | undefined>(
      ENTITLEMENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No decorator means not plan-gated. See the header for why this is open
    // and how the coverage spec stops it being a hole.
    if (!required) return true;

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const orgId = req.principal?.orgId;
    if (!orgId) {
      // Reaching here with no principal means the guard is mounted before the
      // one that establishes the tenant. Fail closed and say so plainly -
      // silently allowing would make a mis-ordered guard list look like it
      // works.
      throw new ForbiddenException(
        "entitlement check ran before a tenant was established; mount EntitlementGuard after TenantGuard",
      );
    }

    // A platform operator is not a tenant and holds no plan. They are
    // deliberately NOT exempted: an operator looking at a customer's console
    // should see the product that customer bought, or the screenshot they send
    // back is of a console the customer cannot reach. Operator-only routes are
    // not entitlement-gated in the first place.
    const decision = await this.entitlements.hard(orgId, required.key, required.minVariant);
    if (decision.allowed) return true;

    const plan = cheapestPlanWith(required.key, required.minVariant);
    const requestId = requestIdOf(req);
    throw new ForbiddenException({
      code: "entitlement_required",
      message: plan
        ? `This endpoint requires the ${plan} plan or higher.`
        : "This endpoint is not available on any current plan.",
      required_plan: plan,
      upgrade_url: `/owner/plan?feature=${encodeURIComponent(required.key)}`,
      request_id: requestId,
      docs_url: "/docs/api#entitlement_required",
    });
  }
}

/**
 * The request id echoed in every error body (§6.3).
 *
 * Taken from the inbound header when there is one, so a customer's own tracing
 * id survives into our error and a support conversation has one identifier
 * rather than two.
 */
export function requestIdOf(req: PrincipalRequest): string {
  const header = req.headers["x-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.slice(0, 120) || `req_${Math.random().toString(36).slice(2, 12)}`;
}
