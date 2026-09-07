import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type FeatureKey, featureSpec } from "@aura/shared";
import { DbService } from "../db/db.service";
import type { PrincipalRequest } from "./auth-principal";
import { loadOrgFeatures } from "./org-features";

export const ORG_FEATURE_KEY = "required_org_feature";

/** Mark a route as belonging to a client-switchable feature (migration 0101). */
export const RequireFeature = (feature: FeatureKey) => SetMetadata(ORG_FEATURE_KEY, feature);

/**
 * Enforces `@RequireFeature(...)` against the client's own switchboard.
 *
 * Runs AFTER AdminKeyGuard and TenantGuard, so `req.tenantOrgId` is set - list
 * it third or later in `@UseGuards`.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 *
 * It is NOT an authorization boundary, and pretending otherwise would be the
 * wrong mental model to build on. The same people who can reach a gated route
 * can switch the feature back on; nothing here protects one person from
 * another. That job belongs to `OwnerRoleGuard` (which desk are you at) and
 * `CrmPermissionsGuard` (what were you granted), and both still run.
 *
 * What it enforces is that OFF MEANS OFF. A switch that only hid a sidebar
 * entry would leave the page reachable by bookmark, by a link in an old
 * notification, and by every server action the page already ships - so a
 * client who switched Invoices off would still find their console issuing
 * payment links. The gate has to be where the work happens.
 *
 * ── WHY IT IS MOUNTED SPARINGLY ─────────────────────────────────────────────
 *
 * On the routes that ARE a feature - the ones whose whole surface disappears
 * with it - and nowhere else. Two reasons, and the second is the interesting
 * one.
 *
 * The first is cost: this is a database round trip, and the console makes
 * dozens of calls per page against a database ~125ms away.
 *
 * The second is that a feature gate on a SHARED read breaks the pages that
 * survive. `GET /v1/leads` is read by the board, the dashboard and three
 * reports; gating it on `leads` would be harmless (that feature is locked) and
 * gating a shared read on a switchable feature would take out surfaces the
 * client never switched off. So the rule is: gate a route only when the whole
 * route belongs to the feature, and let the web tier's page guard
 * (`requireFeature` in owner-context.ts) handle the rest.
 *
 * ── THE THREE STATES ARE NOT ONE ────────────────────────────────────────────
 *
 * `unavailable` (the provider has not granted the module), `blocked` (a
 * requirement is off) and `off` (the client's own choice) all refuse - but they
 * refuse with different sentences, because the person reading the message needs
 * to know whether to call their provider, flip a different switch, or flip this
 * one.
 */
@Injectable()
export class OrgFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<FeatureKey | undefined>(ORG_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const orgId = req.tenantOrgId;
    if (!orgId) {
      // Guard order is wrong - this ran before TenantGuard. Same reasoning and
      // status as CrmPermissionsGuard's equivalent branch: a configuration bug,
      // not a caller error.
      throw new UnauthorizedException("tenant scope required");
    }

    const resolved = await this.db.withOrg(orgId, (client) => loadOrgFeatures(client));
    const state = resolved.get(required)?.state ?? "unavailable";
    if (state === "on") return true;

    const spec = featureSpec(required);
    if (state === "unavailable") {
      throw new ForbiddenException(
        `${spec.label} is not part of your plan - contact your provider to enable it.`,
      );
    }
    if (state === "blocked") {
      const blocker = resolved.get(required)?.blockedBy;
      throw new ForbiddenException(
        `${spec.label} needs ${blocker ? featureSpec(blocker).label : "another feature"}, ` +
          `which is switched off for this workspace.`,
      );
    }
    throw new ForbiddenException(`${spec.label} is switched off for this workspace.`);
  }
}
