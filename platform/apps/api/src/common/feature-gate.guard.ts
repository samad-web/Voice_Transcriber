import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  type AgentCapability,
  type GateDecision,
  type GatedFeatureKey,
  gatedFeatureSpec,
} from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";
import { FeatureGateService } from "./feature-gate.service";

export const GATED_FEATURE_KEY = "required_gated_feature";
export const GATED_CAPABILITY_KEY = "required_gate_capability";

/**
 * Mark a route (or controller) as needing a gated feature (§3A.4).
 *
 * UNLIKE `@RequireFeature` (0101), this is mounted on EVERY route of the
 * module, not sparingly. `OrgFeatureGuard`'s header explains why that one is
 * mounted only where a whole route belongs to a feature: a feature gate on a
 * SHARED read (`GET /v1/leads`) would break the pages that survive.
 *
 * Nothing here is shared. Every route under the transcript agent and the
 * callback list exists only because the feature does, so the rule inverts: a
 * route in these modules WITHOUT a gate is the bug, and
 * `agent-gate-coverage.spec.ts` is §3A.4's "CI check [that] must fail the build
 * if any agent tool, endpoint or job is reachable without a gate check".
 */
export const RequireGatedFeature = (feature: GatedFeatureKey) =>
  SetMetadata(GATED_FEATURE_KEY, feature);

/**
 * Narrow a route to one capability (§3A.2).
 *
 * `@RequireGatedFeature("transcript_agent")` alone means "the feature is on for
 * this person". Adding `@RequireCapability("callbacks")` means "and they have
 * the call-back half of it" - which is what an owner who switched on summaries
 * and not messaging expects a messaging route to refuse.
 */
export const RequireCapability = (capability: AgentCapability) =>
  SetMetadata(GATED_CAPABILITY_KEY, capability);

/**
 * §3A.4's API row: "403 with machine-readable code `feature_disabled` and no
 * data leakage."
 *
 * ── THE CODE IS MACHINE-READABLE AND THE MESSAGE IS FOR A PERSON ───────────
 *
 * The console branches on `code` to decide whether to show an upgrade prompt
 * (owner only), a "your owner switched this off" notice, or nothing at all -
 * and §3A.6 wants those to be three different conversations. The `message` is
 * the sentence a person reads, which is why `plan_missing` says "contact your
 * provider" and `scope_off` does not.
 *
 * ── AND NO DATA LEAKAGE ────────────────────────────────────────────────────
 *
 * The refusal says nothing about the SUBJECT beyond what the caller already
 * knows. A manager asking about a telecaller for whom the feature is off learns
 * that it is off - which they are entitled to know and need, since they
 * configure it - and nothing about that telecaller's calls.
 */
export class FeatureDisabledException extends ForbiddenException {
  constructor(decision: GateDecision, capability?: AgentCapability) {
    const spec = gatedFeatureSpec(decision.feature);
    super({
      statusCode: 403,
      code: "feature_disabled",
      reason: decision.reason,
      feature: decision.feature,
      capability: capability ?? null,
      lockedByPlan: decision.lockedByPlan,
      message: messageFor(decision, spec.name, capability),
    });
  }
}

function messageFor(
  decision: GateDecision,
  featureName: string,
  capability?: AgentCapability,
): string {
  switch (decision.reason) {
    case "plan_missing":
      return `${featureName} is not part of your plan - contact your provider to enable it.`;
    case "platform_kill_switch":
      return `${featureName} is temporarily unavailable for everybody. We are working on it.`;
    case "org_off":
      return `${featureName} is switched off for this workspace.`;
    case "scope_off":
    case "no_decision":
    case "mode_off":
      return `${featureName} is not switched on for this person.`;
    case "capability_off":
    case "capability_above_mode":
      return capability
        ? `"${capability.replace(/_/g, " ")}" is not switched on for this person.`
        : `Part of ${featureName} is not switched on for this person.`;
    case "usage_cap_reached":
      return `${featureName} has reached this month's limit.`;
    case "gate_unavailable":
      // Deliberately not "something went wrong": the caller needs to know this
      // is a refusal they should retry rather than a setting they should
      // change, and an owner told "switched off" would go looking for a switch
      // that is already on.
      return `${featureName} could not be checked just now, so the request was refused. Try again.`;
    case "enabled":
      return "";
  }
}

/**
 * Enforces `@RequireGatedFeature` / `@RequireCapability`.
 *
 * Runs AFTER AdminKeyGuard and TenantGuard, so `req.tenantOrgId` and
 * `req.principal` are set - list it third or later in `@UseGuards`.
 *
 * ── THE SUBJECT IS THE VIEWER, NOT THE CALL'S TELECALLER ───────────────────
 *
 * §3A.3 has two gates and this is the ACCESS one. The route-level question is
 * "may this person use this surface at all", answered against their own
 * setting; "may they see this particular call's results" is the processing
 * gate's snapshot on the run, which the handler reads. Conflating the two would
 * make a manager's access depend on their own toggle rather than on the
 * telecallers they manage.
 *
 * An admin-key principal (the operator console) has no `users` row and
 * therefore no per-user setting. It is gated on the ORG's master switch alone:
 * the operator is not a member of the workspace, and resolving them through
 * `scope_type = 'user'` would always find nothing and always deny - which would
 * lock the vendor out of the support surface the whole module needs.
 */
@Injectable()
export class FeatureGateGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly gate: FeatureGateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<GatedFeatureKey | undefined>(
      GATED_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;

    const capability = this.reflector.getAllAndOverride<AgentCapability | undefined>(
      GATED_CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const orgId = req.tenantOrgId;
    if (!orgId) {
      // Guard order is wrong - this ran before TenantGuard. A configuration
      // bug, not a caller error; the same branch and status
      // `OrgFeatureGuard` and `CrmPermissionsGuard` use.
      throw new UnauthorizedException("tenant scope required");
    }

    const principal = req.principal;
    // `viaAdminKey` and not a `kind` discriminator - `Principal` is one
    // interface with a boolean, and an admin-key principal still carries a
    // `userId` (the web tier's forwarded `x-caller-user-id`, or a bare script's
    // placeholder). Reading `userId` unconditionally would resolve a
    // PLATFORM OPERATOR through `scope_type = 'user'`, find nothing, and deny -
    // locking the vendor out of the support surface the module needs.
    const userId = principal && !principal.viaAdminKey ? principal.userId : null;

    const subject = userId
      ? await this.gate.subjectForUser(orgId, userId)
      : // The operator path. `ownerRole: null` and no ids, so the resolver
        // stops at the org master switch - see the header.
        { userId: null, telecallerId: null, teamId: null, ownerRole: null };

    const decision = await this.gate.check(feature, subject, orgId);

    if (!decision.enabled) throw new FeatureDisabledException(decision, capability);
    if (capability && !decision.capabilities.includes(capability)) {
      throw new FeatureDisabledException(
        { ...decision, reason: "capability_off", enabled: false },
        capability,
      );
    }

    // Handed to the handler so it does not resolve the gate a second time -
    // the decision has to be stored on anything the request creates (§3A.4's
    // audit snapshot), and a second resolution could differ from the one that
    // authorised the request.
    req.gateDecision = decision;
    return true;
  }
}
